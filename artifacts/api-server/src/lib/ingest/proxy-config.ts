/**
 * ingest/proxy-config.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth for residential-proxy URL construction across all
 * ingest transports (raw-fetch, browser-fetch, airbnb-graphql-quote-adapter,
 * airbnb-search-adapter).
 *
 * Two configuration modes, in precedence order:
 *
 *   1. Bright Data (preferred — supports per-request session rotation):
 *      Set BRIGHTDATA_CUSTOMER_ID, BRIGHTDATA_ZONE, BRIGHTDATA_ZONE_PASSWORD.
 *      Optionally BRIGHTDATA_HOST (default brd.superproxy.io) and
 *      BRIGHTDATA_PORT (default 33335).
 *      Each call to buildProxyUrl({ session }) injects a `-session-<token>`
 *      segment into the username so Bright Data hands back a fresh exit IP
 *      per session token. Without rotation, Akamai sees N listing requests
 *      from one IP in M seconds and starts walling.
 *
 *   2. Legacy single PROXY_URL (used by Decodo, kept for backward compat):
 *      Set PROXY_URL=http://USER:PASS@HOST:PORT. No rotation; the URL is
 *      passed through unchanged regardless of `session` argument.
 *
 * Bright Data residential proxies MITM the TLS chain to inspect/route
 * traffic. That means downstream HTTPS cert validation against the target
 * site's chain will fail unless we either (a) install Bright Data's CA
 * cert via NODE_EXTRA_CA_CERTS, or (b) disable cert validation for the
 * proxy-tunneled connection only. Callers should use the BRIGHTDATA_TLS_*
 * helpers exported from this module to apply the latter — scoped so it
 * does NOT affect any other TLS in the process.
 */

import { randomBytes } from "node:crypto";

const BRIGHTDATA_DEFAULT_HOST = "brd.superproxy.io";
const BRIGHTDATA_DEFAULT_PORT = "33335";

export interface ProxyParts {
  /** `http://host:port` — no credentials, suitable for Playwright's `proxy.server`. */
  server: string;
  username: string;
  password: string;
}

/** True when Bright Data env vars are configured (preferred mode). */
export function isBrightDataConfigured(): boolean {
  return Boolean(
    process.env.BRIGHTDATA_CUSTOMER_ID &&
      process.env.BRIGHTDATA_ZONE &&
      process.env.BRIGHTDATA_ZONE_PASSWORD,
  );
}

/**
 * Generate a random session token suitable for Bright Data's
 * `-session-<token>` username segment. 12 hex chars (~48 bits) is well
 * inside the keyspace Bright Data accepts and matches their docs.
 */
export function randomSession(): string {
  return randomBytes(6).toString("hex");
}

/**
 * Compose the credentialed proxy URL.
 *
 * Bright Data mode: returns http://brd-customer-{id}-zone-{zone}-session-{s}:{pass}@host:port
 * Legacy mode: returns the raw PROXY_URL unchanged (session is ignored).
 *
 * Returns null when no proxy is configured at all (caller decides whether
 * to fall back to direct fetch or throw).
 */
export function buildProxyUrl(opts: { session?: string } = {}): string | null {
  if (isBrightDataConfigured()) {
    const parts = brightDataParts(opts.session);
    return `${parts.server.replace(
      /^https?:\/\//,
      "http://",
    )}`.replace(
      "http://",
      `http://${encodeURIComponent(parts.username)}:${encodeURIComponent(parts.password)}@`,
    );
  }
  const legacy = process.env.PROXY_URL?.trim();
  return legacy ? legacy : null;
}

/**
 * Compose the proxy as the `{server, username, password}` shape Playwright's
 * `chromium.launch({ proxy })` expects. Bright Data mode injects the session
 * token into the username; legacy mode parses PROXY_URL.
 */
export function buildProxyParts(opts: { session?: string } = {}): ProxyParts | null {
  if (isBrightDataConfigured()) {
    return brightDataParts(opts.session);
  }
  return parseLegacyProxyUrl(process.env.PROXY_URL ?? "");
}

function brightDataParts(session?: string): ProxyParts {
  const customer = process.env.BRIGHTDATA_CUSTOMER_ID!;
  const zone = process.env.BRIGHTDATA_ZONE!;
  const password = process.env.BRIGHTDATA_ZONE_PASSWORD!;
  const host = process.env.BRIGHTDATA_HOST?.trim() || BRIGHTDATA_DEFAULT_HOST;
  const port = process.env.BRIGHTDATA_PORT?.trim() || BRIGHTDATA_DEFAULT_PORT;
  const sessionSegment = session ? `-session-${session}` : "";
  const username = `brd-customer-${customer}-zone-${zone}${sessionSegment}`;
  return {
    server: `http://${host}:${port}`,
    username,
    password,
  };
}

function parseLegacyProxyUrl(raw: string): ProxyParts | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const port = u.port ? `:${u.port}` : "";
    return {
      server: `${u.protocol}//${u.hostname}${port}`,
      username: u.username ? decodeURIComponent(u.username) : "",
      password: u.password ? decodeURIComponent(u.password) : "",
    };
  } catch {
    return null;
  }
}

/**
 * undici ProxyAgent options that disable cert validation for the
 * proxy-tunneled request only (NOT process-wide). Required when routing
 * through Bright Data because their network MITMs the TLS chain.
 *
 * For legacy PROXY_URL mode (Decodo) this is a no-op — Decodo doesn't
 * MITM, so we leave validation on.
 */
export function proxyAgentTlsOptions(): { requestTls: { rejectUnauthorized: boolean } } | {} {
  if (isBrightDataConfigured()) {
    return { requestTls: { rejectUnauthorized: false } };
  }
  return {};
}

/**
 * Playwright BrowserContext option to ignore HTTPS errors when the proxy
 * MITMs the TLS chain. Same rationale as proxyAgentTlsOptions. Returns
 * `true` only when Bright Data is configured.
 */
export function shouldIgnoreHttpsErrors(): boolean {
  return isBrightDataConfigured();
}
