import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const RESULT_DIR_NAME = "result";
export const DEFAULT_RESULT_BASE_URL = "https://intel.say2agent.com";

export interface ResultUrls {
  resultJsonUrl: string;
  resultPageUrl: string;
}

export interface ResultStoreOptions {
  dir?: string;
  baseUrl?: string;
}

export interface StoredReportPayload {
  orderId: string;
  tier?: string;
  chain?: string;
  mode: "a2a" | "api" | "web" | "free";
  paid: boolean;
  payTxHash?: string;
  structured: unknown;
  humanReadable: string;
  decision?: unknown;
  ai?: unknown;
  addressIntel?: unknown;
  resultJsonUrl: string;
  resultPageUrl: string;
  status?: "saved" | "delivered";
  deliveryTxHash?: string;
  communicationLog?: Array<{
    step: string;
    message: string;
    at: string;
  }>;
}

export function resultDir(options: ResultStoreOptions = {}): string {
  return options.dir ?? join(process.cwd(), RESULT_DIR_NAME);
}

export function sanitizeResultFileName(name: string): string {
  const safe = name.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe.length > 0 ? safe : `report-${Date.now()}`;
}

export function resultFileNameForOrder(orderId: string): string {
  return `${sanitizeResultFileName(orderId)}.json`;
}

export function isSafeResultFileName(fileName: string): boolean {
  return /^[a-zA-Z0-9._-]+\.json$/.test(fileName) && !fileName.includes("..");
}

function normalizeBaseUrl(raw: string | undefined): string {
  const value = raw?.trim() || DEFAULT_RESULT_BASE_URL;
  return value.replace(/\/+$/, "");
}

export function buildResultUrls(fileName: string, options: ResultStoreOptions = {}): ResultUrls {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.RESULT_BASE_URL);
  const encoded = encodeURIComponent(fileName);
  return {
    resultJsonUrl: `${baseUrl}/result/${encoded}`,
    resultPageUrl: `${baseUrl}/report?file=${encoded}`,
  };
}

export async function writeResultJson(
  fileName: string,
  payload: StoredReportPayload,
  options: ResultStoreOptions = {},
): Promise<string> {
  if (!isSafeResultFileName(fileName)) {
    throw new Error(`Unsafe result file name: ${fileName}`);
  }
  const dir = resultDir(options);
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

export async function readResultJson(
  fileName: string,
  options: ResultStoreOptions = {},
): Promise<Buffer> {
  if (!isSafeResultFileName(fileName)) {
    throw new Error(`Unsafe result file name: ${fileName}`);
  }
  return readFile(join(resultDir(options), fileName));
}

export async function readStoredReport(
  fileName: string,
  options: ResultStoreOptions = {},
): Promise<StoredReportPayload> {
  return JSON.parse((await readResultJson(fileName, options)).toString("utf8")) as StoredReportPayload;
}

export async function latestResultFileName(
  options: ResultStoreOptions = {},
): Promise<string | undefined> {
  const dir = resultDir(options);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const files = entries.filter(isSafeResultFileName);
  if (files.length === 0) return undefined;

  const withMtime = await Promise.all(
    files.map(async (fileName) => ({
      fileName,
      mtimeMs: (await stat(join(dir, fileName))).mtimeMs,
    })),
  );
  withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return withMtime[0]?.fileName;
}
