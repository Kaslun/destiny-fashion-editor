/**
 * Resolve a writable cache directory.
 *
 * Local dev caches under the project (`data/cache`), but on Vercel (and most
 * serverless hosts) the deployment filesystem is READ-ONLY — only the OS temp
 * dir (`/tmp`) is writable. `/tmp` is per-container and not shared across cold
 * starts, so it's a best-effort cache, not durable storage.
 */
import os from "os";
import path from "path";

const BASE =
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? path.join(os.tmpdir(), "d2cache")
    : path.join(process.cwd(), "data", "cache");

export function cacheDir(...sub: string[]): string {
  return path.join(BASE, ...sub);
}
