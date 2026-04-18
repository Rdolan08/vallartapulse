/**
 * ingest/http-proxy.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Source-agnostic outbound-fetch transport. Three modes are supported:
 *
 *   - "direct":     no proxy, plain Node https/http.
 *   - "proxy":      tunnel via PROXY_URL. Used for residential proxies
 *                   (e.g. Decodo Residential gate). Cheap; minimal anti-bot
 *                   power on its own.
 *   - "unblocker":  tunnel via UNBLOCKER_URL. Used for Decodo Site Unblocker
 *                   (host:port = unblock.decodo.com:60000), which performs
 *                   server-side JS rendering, IP rotation, and TLS/header
 *                   fingerprint spoofing. Decodo terminates and re-signs the
 *                   target site's TLS, so we must accept their cert
 *                   (rejectUnauthorized: false on the agent).
 *
 * Reads two env vars, both optional:
 *   - PROXY_URL       e.g. http://user:pass@mx.decodo.com:20000
 *                     Schemes: http, https, socks5, socks
 *   - UNBLOCKER_URL   e.g. http://user:pass@unblock.decodo.com:60000
 *
 * Each mode's agent is cached per-(mode, url). Calling `getProxyAgent()` with
 * no arg keeps the legacy behavior (mode = "proxy", reads PROXY_URL).
 */

import type { Agent as HttpAgent } from "http";
import type { Agent as HttpsAgent } from "https";

export type FetchMode = "direct" | "proxy" | "unblocker" | "browser";

interface CachedAgent {
  mode: FetchMode;
  url: string;
  agent: HttpAgent | HttpsAgent;
}

let cached: CachedAgent | null = null;

function readUrl(mode: FetchMode): string {
  if (mode === "proxy") return (process.env.PROXY_URL ?? "").trim();
  if (mode === "unblocker") return (process.env.UNBLOCKER_URL ?? "").trim();
  return "";
}

/**
 * Returns a per-process Agent for outbound HTTPS through the requested mode,
 * or null if that mode has no URL configured (or mode = "direct"). Safe to
 * call on every request — the agent is cached.
 */
export async function getProxyAgent(
  mode: FetchMode = "proxy"
): Promise<HttpAgent | HttpsAgent | null> {
  if (mode === "direct") return null;
  // Browser mode never uses node http; the Chromium instance owns its own
  // proxy config (see browser-fetch.ts). Returning null here is correct —
  // callers in browser mode should not be issuing node http requests at all.
  if (mode === "browser") return null;

  const raw = readUrl(mode);
  if (!raw) return null;

  if (cached && cached.mode === mode && cached.url === raw) return cached.agent;

  const scheme = raw.split(":", 1)[0]?.toLowerCase();
  let agent: HttpAgent | HttpsAgent;

  if (scheme === "socks" || scheme === "socks5" || scheme === "socks5h" || scheme === "socks4") {
    const { SocksProxyAgent } = await import("socks-proxy-agent");
    agent = new SocksProxyAgent(raw);
  } else if (scheme === "http" || scheme === "https") {
    const { HttpsProxyAgent } = await import("https-proxy-agent");
    if (mode === "unblocker") {
      // Decodo Site Unblocker performs server-side TLS termination + re-sign,
      // so the cert presented to us is Decodo's, not the target site's.
      // We must skip cert verification on this leg only.
      agent = new HttpsProxyAgent(raw, { rejectUnauthorized: false });
    } else {
      agent = new HttpsProxyAgent(raw);
    }
  } else {
    throw new Error(
      `[http-proxy] Unsupported ${mode === "unblocker" ? "UNBLOCKER_URL" : "PROXY_URL"} ` +
        `scheme: '${scheme}'. Supported: http://, https://, socks5://, socks://`
    );
  }

  cached = { mode, url: raw, agent };
  return agent;
}

/** True if PROXY_URL is configured (cheap; no module load). */
export function isProxyConfigured(): boolean {
  return readUrl("proxy").length > 0;
}

/** True if UNBLOCKER_URL is configured (cheap; no module load). */
export function isUnblockerConfigured(): boolean {
  return readUrl("unblocker").length > 0;
}

/**
 * Returns a redacted form of the given mode's URL for safe logging
 * (host:port only, no creds).
 */
export function describeProxy(mode: FetchMode = "proxy"): string {
  if (mode === "direct") return "direct (no proxy)";
  if (mode === "browser") {
    // Browser mode wraps PROXY_URL inside Chromium.
    const raw = readUrl("proxy");
    if (!raw) return "browser (direct, no PROXY_URL)";
    try {
      const u = new URL(raw);
      return `browser → ${u.protocol}//${u.hostname}:${u.port || "(default)"}`;
    } catch {
      return "browser (PROXY_URL unparseable)";
    }
  }
  const raw = readUrl(mode);
  if (!raw) return mode === "unblocker" ? "unblocker not configured" : "direct (no proxy)";
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}:${u.port || "(default)"}`;
  } catch {
    return "configured (unparseable)";
  }
}

/**
 * Resolves the effective fetch mode given a requested mode.
 * - "direct" / "unblocker"  → returned as-is (caller must ensure URL is set
 *                             for "unblocker"; this fn doesn't read env).
 * - "proxy"                 → returned as-is. getProxyAgent() will fall back
 *                             to direct fetches if PROXY_URL is unset.
 */
export function effectiveMode(mode: FetchMode): FetchMode {
  return mode;
}

/** Reset the cached agent — used by tests or after rotating credentials. */
export function resetProxyAgent(): void {
  cached = null;
}
