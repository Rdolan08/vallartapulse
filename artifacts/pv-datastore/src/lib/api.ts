/**
 * Resolves the base URL for API calls.
 *
 * Resolution order (first match wins):
 *  1. VITE_API_URL       — canonical name shared with `api-base.ts` (Vercel).
 *  2. VITE_API_BASE_URL  — legacy alias kept for backward compatibility.
 *  3. Vite's BASE_URL    — same-origin deployments where the reverse proxy
 *                          routes /api/... to the API server on the same host.
 */
export function getApiBase(): string {
  const fromEnv =
    (import.meta.env.VITE_API_URL as string | undefined) ??
    (import.meta.env.VITE_API_BASE_URL as string | undefined);
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
}
