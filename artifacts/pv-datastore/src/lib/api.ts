/**
 * Resolves the base URL for API calls.
 *
 * Resolution order:
 *  1. VITE_API_BASE_URL — set this when the API lives on a different origin
 *     (e.g. VITE_API_BASE_URL=https://api.vallartapulse.com).
 *  2. Vite's BASE_URL — works for same-origin deployments where the reverse
 *     proxy routes /api/... to the API server on the same host.
 */
export function getApiBase(): string {
  const override = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (override) return override.replace(/\/$/, "");
  return (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
}
