/**
 * forward-demand-panel.tsx — v1
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders the forward-demand recommendation alongside the comp-based
 * pricing summary on the pricing tool. Read-only signal — clicking Apply
 * just copies the price into the operator's clipboard and logs the event;
 * it does NOT mutate any pricing engine state.
 *
 * Empty state: when the gate suppresses the recommendation, this component
 * renders nothing (returns null). The pricing tool layout is unaffected.
 */

import { useEffect, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Sparkles, Clock, Check, ChevronDown, ChevronUp } from "lucide-react";
import { apiFetch } from "@/lib/api-base";

interface NightRec {
  date: string;
  event_label: string;
  event_name: string;
  bucket: "early" | "mid" | "late" | "very_late";
  badge: "forward_demand" | "time_pressure";
  comp_median: number;
  recommended_low: number;
  recommended_high: number;
  recommended_apply_price: number;
  headline: string;
  supporting_line: string | null;
  why_bullets: string[];
  suggested_action: string[];
  transition_message: string | null;
}

interface ForwardDemandResponse {
  qualifying_nights: NightRec[];
  qualifying_count: number;
  all_nights_count: number;
  gate: {
    event_name: string | null;
    suppression_reason: string | null;
  };
}

interface Props {
  neighborhood: string;
  checkIn: string;
  checkOut: string;
  compMedian: number | null | undefined;
  /** UI language: "en" | "es" */
  lang: "en" | "es";
}

const LS_TRANSITION_KEY = "vp_fd_transition_seen_v1";

function formatUSD(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

function bucketLabel(bucket: NightRec["bucket"], lang: "en" | "es"): string {
  const map = {
    early: { en: "Early window", es: "Ventana temprana" },
    mid: { en: "Mid window", es: "Ventana media" },
    late: { en: "Late window", es: "Ventana tardía" },
    very_late: { en: "Final window", es: "Ventana final" },
  };
  return map[bucket][lang];
}

function readSeenTransitions(): Record<string, true> {
  try {
    return JSON.parse(localStorage.getItem(LS_TRANSITION_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function markTransitionSeen(key: string) {
  try {
    const seen = readSeenTransitions();
    seen[key] = true;
    localStorage.setItem(LS_TRANSITION_KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
}

export function ForwardDemandPanel({
  neighborhood,
  checkIn,
  checkOut,
  compMedian,
  lang,
}: Props) {
  const [data, setData] = useState<ForwardDemandResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [appliedDates, setAppliedDates] = useState<Record<string, true>>({});
  const observationIdsRef = useRef<Record<string, number>>({});

  // Fetch when inputs change.
  useEffect(() => {
    if (!neighborhood || !checkIn || !checkOut || !compMedian || compMedian <= 0) {
      setData(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiFetch<ForwardDemandResponse>("/api/rental/forward-demand", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        neighborhood,
        check_in: checkIn,
        check_out: checkOut,
        comp_median: compMedian,
      }),
    })
      .then((j) => {
        if (cancelled) return;
        setData(j);
      })
      .catch(() => {
        if (cancelled) return;
        setData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [neighborhood, checkIn, checkOut, compMedian]);

  // Fire track-shown for each qualifying night exactly once per render-cycle.
  useEffect(() => {
    if (!data || data.qualifying_nights.length === 0) return;
    let cancelled = false;
    for (const n of data.qualifying_nights) {
      const key = `${n.date}__${n.event_label}__${n.bucket}`;
      if (observationIdsRef.current[key] != null) continue;
      // Mark as in-flight to prevent duplicate fires inside StrictMode.
      observationIdsRef.current[key] = -1;
      apiFetch<{ observation_id: number | null }>(
        "/api/rental/forward-demand/track-shown",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            night_date: n.date,
            event_label: n.event_label,
            bucket: n.bucket,
            recommended_price: n.recommended_apply_price,
            comp_median_at_show: n.comp_median,
          }),
        },
      )
        .then((j) => {
          if (cancelled) return;
          if (j.observation_id != null) observationIdsRef.current[key] = j.observation_id;
        })
        .catch(() => {
          /* tracking failures are silent */
        });
    }
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (loading || !data) return null;
  if (data.qualifying_count === 0) return null;

  const t = (en: string, es: string) => (lang === "es" ? es : en);
  const nights = data.qualifying_nights;
  const seenTransitions = readSeenTransitions();

  const handleApply = (n: NightRec) => {
    const key = `${n.date}__${n.event_label}__${n.bucket}`;
    setAppliedDates((prev) => ({ ...prev, [n.date]: true }));
    // Copy to clipboard for operator convenience.
    try {
      navigator.clipboard.writeText(String(n.recommended_apply_price));
    } catch {
      /* clipboard may be blocked — silent */
    }
    const obsId = observationIdsRef.current[key];
    if (obsId != null && obsId > 0) {
      apiFetch("/api/rental/forward-demand/track-applied", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ observation_id: obsId }),
      }).catch(() => {});
    }
  };

  return (
    <Card
      className="glass-card"
      style={{
        borderColor: "rgba(255,120,73,0.25)",
        background:
          "linear-gradient(180deg, rgba(255,120,73,0.05) 0%, rgba(255,120,73,0.02) 100%)",
      }}
      data-testid="forward-demand-panel"
    >
      <CardContent className="pt-5 pb-5">
        {/* Header */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center justify-between w-full"
          data-testid="forward-demand-toggle"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4" style={{ color: "#FF7849" }} />
            <span className="text-sm font-semibold" style={{ color: "#FF7849" }}>
              {t("Forward-demand signal", "Señal de demanda anticipada")}
              {data.gate.event_name ? ` · ${data.gate.event_name}` : ""}
            </span>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full font-medium"
              style={{ background: "rgba(255,120,73,0.12)", color: "#FF7849" }}
            >
              {nights.length}{" "}
              {nights.length === 1 ? t("night", "noche") : t("nights", "noches")}
            </span>
          </div>
          {expanded ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </button>

        {expanded && (
          <div className="mt-4 space-y-3">
            {/* Headline (uses first night's headline; consistent across nights
                in the same bucket family). */}
            <div className="space-y-1">
              <p className="text-sm font-medium" style={{ color: "rgba(245,247,250,0.95)" }}>
                {nights[0].headline}
              </p>
              {nights[0].supporting_line && (
                <p className="text-xs text-muted-foreground">{nights[0].supporting_line}</p>
              )}
            </div>

            {/* Per-night rows */}
            <div className="space-y-2">
              {nights.map((n) => {
                const transitionKey = `${n.date}__${n.event_label}__very_late`;
                const showTransition =
                  n.transition_message != null && !seenTransitions[transitionKey];
                if (showTransition) {
                  // Mark as seen so subsequent renders suppress it.
                  markTransitionSeen(transitionKey);
                }
                const applied = appliedDates[n.date] === true;
                const Icon = n.badge === "time_pressure" ? Clock : Sparkles;
                const accentColor = n.badge === "time_pressure" ? "#F59E0B" : "#FF7849";
                return (
                  <div
                    key={n.date}
                    className="rounded-lg p-3"
                    style={{
                      background: "rgba(255,255,255,0.02)",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                    data-testid={`fd-night-${n.date}`}
                  >
                    {showTransition && (
                      <div
                        className="text-[11px] mb-2 p-2 rounded"
                        style={{
                          background: "rgba(245,158,11,0.1)",
                          color: "#F59E0B",
                          border: "1px solid rgba(245,158,11,0.25)",
                        }}
                      >
                        {n.transition_message}
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="flex items-center gap-2 min-w-0">
                        <Icon className="w-3.5 h-3.5 shrink-0" style={{ color: accentColor }} />
                        <span className="text-xs font-semibold tabular-nums">{n.date}</span>
                        <span
                          className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                          style={{
                            background: `${accentColor}1f`,
                            color: accentColor,
                          }}
                        >
                          {bucketLabel(n.bucket, lang)}
                        </span>
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-[10px] text-muted-foreground">
                          {t("Comp median", "Mediana comp.")}{" "}
                          <span className="tabular-nums">{formatUSD(n.comp_median)}</span>
                        </span>
                        <span className="text-[10px] text-muted-foreground">→</span>
                        <span
                          className="text-base font-bold tabular-nums"
                          style={{ color: accentColor }}
                        >
                          {formatUSD(n.recommended_apply_price)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          ({formatUSD(n.recommended_low)}–{formatUSD(n.recommended_high)})
                        </span>
                        <button
                          type="button"
                          onClick={() => handleApply(n)}
                          disabled={applied}
                          className="text-[10px] font-semibold px-2 py-1 rounded transition-opacity disabled:opacity-60"
                          style={{
                            background: applied
                              ? "rgba(0,194,168,0.15)"
                              : `${accentColor}26`,
                            color: applied ? "#00C2A8" : accentColor,
                            border: `1px solid ${applied ? "rgba(0,194,168,0.3)" : accentColor + "55"}`,
                          }}
                          data-testid={`fd-apply-${n.date}`}
                        >
                          {applied ? (
                            <span className="flex items-center gap-1">
                              <Check className="w-3 h-3" />
                              {t("Copied", "Copiado")}
                            </span>
                          ) : (
                            t("Apply", "Aplicar")
                          )}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Why bullets — derived from first qualifying night */}
            <div
              className="pt-3 mt-1"
              style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
            >
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                {t("Why", "Por qué")}
              </p>
              <ul className="space-y-1">
                {nights[0].why_bullets.map((b, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground flex gap-2">
                    <span style={{ color: "#FF7849" }}>·</span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Suggested next action — from first night */}
            <div className="pt-2">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground mb-1.5">
                {t("Suggested action", "Acción sugerida")}
              </p>
              <ul className="space-y-1">
                {nights[0].suggested_action.map((a, i) => (
                  <li key={i} className="text-[11px] text-muted-foreground flex gap-2">
                    <span style={{ color: "#00C2A8" }}>›</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Manual-only disclaimer */}
            <p
              className="text-[10px] mt-2 pt-2"
              style={{
                color: "rgba(154,165,177,0.4)",
                borderTop: "1px solid rgba(255,255,255,0.04)",
              }}
            >
              {t(
                "This is an informational signal — recommendations are never auto-applied to your listing.",
                "Esta es una señal informativa — las recomendaciones nunca se aplican automáticamente a tu propiedad.",
              )}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
