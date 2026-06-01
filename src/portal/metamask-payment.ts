/**
 * MetaMask / direct-transfer payment verification (Base USDC).
 *
 * The web UI offers a second payment method besides CAP: the user connects MetaMask and sends a
 * fixed amount of USDC on Base directly to OUR configured payee address, then submits the tx hash.
 * This module verifies, READ-ONLY, that such a transfer really happened:
 *
 *   1. The tx is mined and successful (status === "success").
 *   2. It contains an ERC-20 Transfer(USDC) log: to === payee, value >= the tier price.
 *
 * Unlike CAP settlement (escrow via CAPVault), this is a plain on-chain transfer to us — used only
 * for the convenience web-payment path. It never touches a private key (the user signs in their own
 * wallet); we only read the chain to confirm the payment.
 *
 * Security: read-only. The payee address is injected from the environment (never hard-coded).
 */

import {
  createPublicClient,
  http,
  getAddress,
  decodeEventLog,
  parseAbi,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";

import type { Tier } from "../config.js";
import { TIER_PRICE_USDC } from "../config.js";

/** USDC on Base (6 decimals). */
export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_DECIMALS = 6;

/** Default public Base RPC (override via PORTAL_BASE_RPC_URL for reliability / rate limits). */
export const DEFAULT_BASE_RPC_URL = "https://mainnet.base.org";

const ERC20_TRANSFER_ABI = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

/** Convert a USDC decimal price (e.g. 0.5) to base units (6 decimals) as a bigint. */
export function usdcToBaseUnits(amount: number): bigint {
  // Avoid float drift: scale via string with fixed decimals.
  const [whole, frac = ""] = amount.toString().split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(fracPadded || "0");
}

/** Result of verifying a MetaMask USDC payment. */
export interface MetaMaskVerifyResult {
  paid: boolean;
  reason: string;
  /** The verified amount in USDC (decimal), when paid. */
  amountUsdc?: number;
}

/** Dependencies for {@link MetaMaskPaymentVerifier} (injectable for tests). */
export interface MetaMaskVerifierOptions {
  /** Our USDC payee address on Base (env: PORTAL_PAYEE_ADDRESS). */
  payeeAddress: string;
  /** Base RPC URL (env: PORTAL_BASE_RPC_URL); defaults to the public Base RPC. */
  rpcUrl?: string;
  /** Injected viem client (tests). */
  publicClient?: PublicClient;
  /** USDC token address on Base (override for tests). */
  usdcAddress?: string;
}

/**
 * Verifies a user-submitted USDC transfer on Base to our payee address. The expected amount is the
 * tier price (allowing overpayment). It reads the transaction receipt + decodes Transfer logs.
 */
export class MetaMaskPaymentVerifier {
  private readonly client: PublicClient;
  private readonly payee: string;
  private readonly usdc: string;

  constructor(opts: MetaMaskVerifierOptions) {
    this.payee = getAddress(opts.payeeAddress);
    this.usdc = getAddress(opts.usdcAddress ?? BASE_USDC_ADDRESS);
    this.client =
      opts.publicClient ??
      (createPublicClient({
        chain: base,
        transport: http(opts.rpcUrl ?? DEFAULT_BASE_RPC_URL),
      }) as PublicClient);
  }

  /** Verify that `txHash` paid at least the tier price in USDC to our payee on Base. */
  async verify(txHash: string, tier: Tier): Promise<MetaMaskVerifyResult> {
    const required = usdcToBaseUnits(TIER_PRICE_USDC[tier]);
    let receipt;
    try {
      receipt = await this.client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch {
      return {
        paid: false,
        reason: "Transaction not found yet. Wait for it to confirm, then retry.",
      };
    }
    if (receipt.status !== "success") {
      return { paid: false, reason: "The payment transaction failed on-chain." };
    }

    // Sum USDC Transfer(value) logs whose `to` is our payee.
    let received = 0n;
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== this.usdc) continue;
      try {
        const decoded = decodeEventLog({
          abi: ERC20_TRANSFER_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName !== "Transfer") continue;
        const { to, value } = decoded.args as unknown as { to: string; value: bigint };
        if (getAddress(to) === this.payee) received += value;
      } catch {
        // Not a Transfer log we can decode; skip.
      }
    }

    if (received < required) {
      const recv = Number(received) / 10 ** USDC_DECIMALS;
      const need = TIER_PRICE_USDC[tier];
      return {
        paid: false,
        reason: `Insufficient USDC to our address: received ${recv}, need ${need}.`,
      };
    }
    return {
      paid: true,
      reason: "USDC payment verified on Base.",
      amountUsdc: Number(received) / 10 ** USDC_DECIMALS,
    };
  }
}
