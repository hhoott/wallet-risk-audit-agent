// Copy the portal's static frontend assets into dist so the compiled server can serve them.
//
// `tsc` only emits .ts -> .js, so the hand-written public/ assets (HTML/CSS/JS/SVG) are not copied
// by the build. The portal server resolves its assets dir relative to the compiled module
// (dist/portal/public), so this script mirrors src/portal/public -> dist/portal/public after tsc.

import { cp, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "portal", "public");
const dest = join(root, "dist", "portal", "public");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await exists(src))) {
    console.error(`[copy-portal-assets] source not found: ${src}`);
    process.exit(1);
  }
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true });
  console.info(`[copy-portal-assets] copied ${src} -> ${dest}`);
}

main().catch((err) => {
  console.error(`[copy-portal-assets] failed: ${err?.message ?? err}`);
  process.exit(1);
});
