/**
 * Resolve the base URL for API requests.
 *
 * Behaviour:
 *   - When `VITE_API_URL` is set at build time, all `/api/...` paths are
 *     prefixed with that absolute origin (e.g. "https://api.example.com").
 *   - When `VITE_API_URL` is unset (local dev, single-origin deployments,
 *     reverse-proxied setups), paths are returned unchanged so the browser
 *     hits the same origin that served the page.
 *
 * Trailing slashes on the env var are stripped to keep concatenation safe.
 */
const RAW_BASE = (import.meta.env.VITE_API_URL ?? "").trim();
export const API_BASE_URL = RAW_BASE.replace(/\/+$/, "");

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
