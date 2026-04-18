/**
 * ingest/http-proxy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Source-agnostic proxy support for the discovery scrapers.
 *
 * Reads PROXY_URL from the environment. When unset (or empty), all consumers
 * fall back to direct fetches — current behavior is preserved exactly.
 *
 * Supported PROXY_URL schemes:
 *   - http://[user:pass@]host:port    (most residential proxy providers)
 *   - https://[user:pass@]host:port   (rare; same handler as http://)
 *   - socks5://[user:pass@]host:port  (Bright Data SOCKS, etc.)
 *   - socks://[user:pass@]host:port   (alias for socks5)
 *
 * The agent is created lazily on first use and cached by URL — providers'
 * residential rotation typically happens server-side, so a single agent is
 * fine. To force re-creation (e.g. in tests), call resetProxyAgent().
 */

import type { Agent as HttpAgent } from "http";
import type { Agent as HttpsAgent } from "https";

let cached: { url: string; agent: HttpAgent | HttpsAgent } | null = null;

/**
 * Returns a per-process Agent for outbound HTTPS through PROXY_URL, or null
 * if no proxy is configured. Safe to call on every request — agent is cached.
 */
export async function getProxyAgent(): Promise<HttpAgent | HttpsAgent | null> {
  const raw = (process.env.PROXY_URL ?? "").trim();
  if (!raw) return null;

  if (cached && cached.url === raw) return cached.agent;

  const scheme = raw.split(":", 1)[0]?.toLowerCase();
  let agent: HttpAgent | HttpsAgent;

  if (scheme === "socks" || scheme === "socks5" || scheme === "socks5h" || scheme === "socks4") {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    agent = new SocksProxyAgent(raw);
  } else if (scheme === "http" || scheme === "https") {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    agent = new HttpsProxyAgent(raw);
  } else {
    throw new Error(
      `[http-proxy] Unsupported PROXY_URL scheme: '${scheme}'. ` +
        `Supported: http://, https://, socks5://, socks://`
    );
  }

  cached = { url: raw, agent };
  return agent;
}

/** True if PROXY_URL is configured (cheap check; doesn't load any modules). */
export function isProxyConfigured(): boolean {
  return (process.env.PROXY_URL ?? "").trim().length > 0;
}

/** Returns a redacted PROXY_URL for safe logging (host:port only, no creds). */
export function describeProxy(): string {
  const raw = (process.env.PROXY_URL ?? "").trim();
  if (!raw) return "direct (no proxy)";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}:${u.port || "(default)"}`;
  } catch {
    return "configured (unparseable)";
  }
}

/** Reset the cached agent — used by tests or after rotating credentials. */
export function resetProxyAgent(): void {
  cached = null;
}
