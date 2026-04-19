/**
 * Resolve the base URL for API requests.
 *
 * Resolution order (first match wins):
 *   1. `VITE_API_URL` build-time env var (Vercel canonical, Railway-style
 *      absolute origin, e.g. "https://api.example.com").
 *   2. **Production fallback** — if the page is being served from a known
 *      production host (anything that isn't localhost / a Replit preview /
 *      a generic file URL), fall back to the hardcoded Railway origin
 *      (`PRODUCTION_API_BASE_URL` below). This means a missing or
 *      mistyped `VITE_API_URL` on Vercel can no longer cause `/api/*`
 *      calls to silently hit the SPA host and 404.
 *   3. Empty string — local dev / single-origin reverse-proxied
 *      deployments keep relative `/api/...` paths.
 *
 * Trailing slashes on the env var are stripped to keep concatenation safe.
 *
 * Single source of truth: the Railway URL literal lives **only** in this
 * file. Other modules import `API_BASE_URL`, `apiUrl`, or `apiFetch`
 * from here.
 */

/**
 * Hardcoded Railway origin used when the SPA is served from a production
 * host but `VITE_API_URL` is missing/blank. Mirrors `vercel.json`'s
 * `/api/:path*` rewrite destination — keep them in sync.
 */
export const PRODUCTION_API_BASE_URL =
  "https://the-data-store-production.up.railway.app";

function isLocalOrPreviewHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost") return true;
  if (hostname === "127.0.0.1") return true;
  if (hostname === "0.0.0.0") return true;
  if (hostname === "[::1]") return true;
  // Replit preview proxy hostnames look like `<id>.<region>.replit.dev`
  // or the legacy `<slug>.<user>.repl.co`. Both serve the SPA + API on
  // the same origin via the workflow proxy, so relative paths are fine.
  if (hostname.endsWith(".replit.dev")) return true;
  if (hostname.endsWith(".repl.co")) return true;
  if (hostname.endsWith(".replit.app")) return true;
  return false;
}

function resolveApiBase(): string {
  const fromEnv = (import.meta.env.VITE_API_URL ?? "").trim().replace(/\/+$/, "");
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined" && !isLocalOrPreviewHost(window.location.hostname)) {
    return PRODUCTION_API_BASE_URL;
  }
  return "";
}

export const API_BASE_URL = resolveApiBase();

/**
 * Build a fully-qualified URL for an API path.
 *
 *   apiUrl("/api/contact")            // "/api/contact"            (same-origin)
 *   apiUrl("/api/contact")            // "https://api…/api/contact" (split)
 *   apiUrl("api/contact")             // leading slash auto-added
 */
export function apiUrl(path: string): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${normalized}` : normalized;
}

/**
 * `fetch` + JSON wrapper for `/api/*` calls.
 *
 * Adds two safety nets on top of the bare `fetch`:
 *
 *   1. **HTML-response guard.** If the response's `content-type` is
 *      `text/html`, throws a precise error including the resolved URL
 *      and HTTP status. This is the regression that re-bit `/pricing-tool`:
 *      Vercel had no `/api/*` rewrite and was returning its 404 HTML
 *      page, which `res.json()` then rendered as an opaque
 *      "API error 404 html" toast. The new error explicitly names the
 *      misroute so the next failure is debuggable in seconds.
 *   2. **Non-JSON error parsing.** Falls back to a status-code error if
 *      the server returned a non-OK response without a JSON body.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const url = apiUrl(path);
  const res = await fetch(url, options);

  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.startsWith("text/html")) {
    throw new Error(
      `Production API returned HTML at ${url} (HTTP ${res.status}) — likely a misrouted /api/* proxy. ` +
      `Check the SPA host's /api/* rewrite and the VITE_API_URL build env var.`,
    );
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(
      (err as { message?: string; error?: string }).message
        ?? (err as { error?: string }).error
        ?? `API error: HTTP ${res.status}`,
    );
  }

  return res.json() as Promise<T>;
}
