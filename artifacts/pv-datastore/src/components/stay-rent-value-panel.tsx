/**
 * stay-rent-value-panel.tsx — v1
 * ─────────────────────────────────────────────────────────────────────────────
 * Neutral opportunity-cost framing for the operator's chosen stay window.
 * Answers a single question — "what would these nights earn if rented?" —
 * using only data already present in the comps response. Read-only.
 *
 * Hard guarantees:
 *   • No actions
 *   • No tracking
 *   • No event dependency
 *   • No backend calls
 *   • No pricing-engine touchpoints
 *   • Returns null when the headline number is weak, noisy, or missing
 *
 * Input priority for the headline:
 *   1. summary.stay_window_total
 *   2. summary.stay_window_median × stay_window_nights
 *   3. otherwise → suppress
 *
 * Additional suppression: if the comp engine reports a stay-window sample
 * size below MIN_SAMPLES, suppress the entire card. Operators should not
 * see opportunity-cost framing built on a thin sample.
 */

import { Card, CardContent } from "@/components/ui/card";
import { Calculator } from "lucide-react";
import { formatCurrency } from "@/lib/utils";

interface StayWindowSummary {
  stay_window_median?: number | null;
  stay_window_low?: number | null;
  stay_window_high?: number | null;
  stay_window_total?: number | null;
  stay_window_nights?: number | null;
  stay_window_samples?: number;
}

interface Props {
  summary: StayWindowSummary | undefined;
  /** Free-form neighborhood label, used in the factual disclaimer. */
  neighborhood: string;
  /** UI language. */
  lang: "en" | "es";
}

/** Below this, the stay-window sample is too thin to ground an estimate honestly. */
const MIN_SAMPLES = 5;

export function StayRentValuePanel({ summary, neighborhood, lang }: Props) {
  if (!summary) return null;

  const t = (en: string, es: string) => (lang === "es" ? es : en);

  // ── Headline computation, in declared priority order ─────────────────────
  const nights = summary.stay_window_nights ?? null;

  let headlineTotal: number | null = null;
  let perNight: number | null = null;
  let source: "total" | "median_x_nights" | null = null;

  if (summary.stay_window_total != null && nights != null && nights > 0) {
    headlineTotal = summary.stay_window_total;
    perNight = summary.stay_window_total / nights;
    source = "total";
  } else if (
    summary.stay_window_median != null &&
    nights != null &&
    nights > 0
  ) {
    headlineTotal = summary.stay_window_median * nights;
    perNight = summary.stay_window_median;
    source = "median_x_nights";
  }

  // Suppress: missing headline.
  if (headlineTotal == null || perNight == null || nights == null || !source) {
    return null;
  }

  // Suppress: weak / noisy sample.
  if (
    summary.stay_window_samples != null &&
    summary.stay_window_samples < MIN_SAMPLES
  ) {
    return null;
  }

  // Range, only when both bounds are present and well-formed.
  const hasRange =
    summary.stay_window_low != null &&
    summary.stay_window_high != null &&
    summary.stay_window_low > 0 &&
    summary.stay_window_high >= summary.stay_window_low;

  const lowTotal = hasRange ? summary.stay_window_low! * nights : null;
  const highTotal = hasRange ? summary.stay_window_high! * nights : null;

  return (
    <Card
      className="glass-card"
      style={{
        borderColor: "rgba(154,165,177,0.18)",
        background:
          "linear-gradient(180deg, rgba(154,165,177,0.04) 0%, rgba(154,165,177,0.015) 100%)",
      }}
      data-testid="stay-rent-value-panel"
    >
      <CardContent className="pt-5 pb-5">
        {/* Header — no chevron, no toggle. Always rendered when shown. */}
        <div className="flex items-center gap-2 mb-3">
          <Calculator
            className="w-4 h-4"
            style={{ color: "rgba(154,165,177,0.85)" }}
          />
          <span
            className="text-sm font-semibold"
            style={{ color: "rgba(245,247,250,0.9)" }}
          >
            {t(
              "Estimated rental value of this stay",
              "Valor estimado de renta de esta estadía",
            )}
          </span>
        </div>

        {/* Headline */}
        <div className="flex items-baseline gap-2">
          <span
            className="text-4xl font-extrabold tracking-tight tabular-nums"
            style={{ color: "rgba(245,247,250,0.95)" }}
          >
            {formatCurrency(Math.round(headlineTotal))}
          </span>
          <span className="text-xs text-muted-foreground">
            {t(`total · ${nights} nights`, `total · ${nights} noches`)}
          </span>
        </div>

        {/* Per-night derivation — calm, factual */}
        <p className="text-[12px] mt-1.5 text-muted-foreground tabular-nums">
          {source === "total"
            ? t(
                `Works out to ≈ ${formatCurrency(Math.round(perNight))} / night across the stay`,
                `Equivale a ≈ ${formatCurrency(Math.round(perNight))} / noche durante la estadía`,
              )
            : t(
                `≈ ${formatCurrency(Math.round(perNight))} / night × ${nights} nights at the comp median for these dates`,
                `≈ ${formatCurrency(Math.round(perNight))} / noche × ${nights} noches según la mediana comparable para estas fechas`,
              )}
        </p>

        {/* Range row — only when honest bounds exist */}
        {hasRange && lowTotal != null && highTotal != null && (
          <div
            className="flex items-center gap-5 mt-3 pt-3"
            style={{ borderTop: "1px solid rgba(154,165,177,0.1)" }}
          >
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                {t("Range across comps", "Rango entre comparables")}
              </p>
              <p className="text-sm font-semibold tabular-nums">
                {formatCurrency(Math.round(lowTotal))} –{" "}
                {formatCurrency(Math.round(highTotal))}
              </p>
              <p className="text-[10px] text-muted-foreground tabular-nums mt-0.5">
                {formatCurrency(Math.round(summary.stay_window_low!))} –{" "}
                {formatCurrency(Math.round(summary.stay_window_high!))}{" "}
                {t("/ night", "/ noche")}
              </p>
            </div>
          </div>
        )}

        {/* Calm disclaimer — opportunity-cost framing, not a recommendation */}
        <p
          className="text-[10px] mt-3 pt-3"
          style={{
            color: "rgba(154,165,177,0.45)",
            borderTop: "1px solid rgba(154,165,177,0.08)",
          }}
        >
          {t(
            `Based on comparable rentals in ${neighborhood} for the same dates. This is an estimate of what the stay would earn if rented — not a price recommendation.`,
            `Basado en rentas comparables en ${neighborhood} para las mismas fechas. Es una estimación de lo que la estadía generaría si se rentara — no es una recomendación de precio.`,
          )}
        </p>
      </CardContent>
    </Card>
  );
}
