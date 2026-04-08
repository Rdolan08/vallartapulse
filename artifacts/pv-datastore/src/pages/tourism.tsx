import { useState } from "react";
import { useGetTourismMetrics, useGetAirportMetrics, useGetCruiseSchedule, useGetPendingAirportEstimates } from "@workspace/api-client-react";
import { MONTHLY_DATA_YEARS, LAST_COMPLETED_YEAR, yearLabel } from "@/lib/data-availability";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  ComposedChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { formatNumber, formatPercent } from "@/lib/utils";
import { CHART_TOOLTIP, TOOLTIP_CURSOR, TOOLTIP_CONTENT_STYLE, TOOLTIP_LABEL_STYLE, TOOLTIP_ITEM_STYLE } from "@/lib/chart-theme";
import { Building2, DollarSign, ExternalLink, Info, Plane, Ship, TrendingUp, Users } from "lucide-react";

const MONTH_NAMES_LONG = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const GRID = <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(255,255,255,0.06)" />;
const TICK = { fill: "hsl(var(--muted-foreground))", fontSize: 12 };
const AXIS_PROPS = { axisLine: false as const, tickLine: false as const };

const YEARS = [...MONTHLY_DATA_YEARS].reverse();

export default function Tourism() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(LAST_COMPLETED_YEAR);

  const { data, isLoading, error } = useGetTourismMetrics({ year });
  const { data: airportRaw } = useGetAirportMetrics();
  const { data: cruiseSchedule } = useGetCruiseSchedule();
  const { data: pendingEstimates } = useGetPendingAirportEstimates();

  // ── Airport chart data (all years, YoY comparison) ───────────────────────
  const airportYears = airportRaw
    ? [...new Set(airportRaw.map((r) => r.year))].sort()
    : [];
  // Last official month for 2026 — used as the overlap / join point between solid and dotted lines
  const official2026Rows = airportRaw?.filter((r) => r.year === 2026) ?? [];
  const lastOfficial2026Month = official2026Rows.length
    ? Math.max(...official2026Rows.map((r) => r.month))
    : 0;
  // Pending estimates for 2026 (from the existing hook data)
  const estimated2026 = pendingEstimates?.filter((e) => e.year === 2026) ?? [];

  const airportChartData = MONTH_ABBR.map((abbr, idx) => {
    const month = idx + 1;
    const point: Record<string, number | string> = { month: abbr };
    for (const yr of airportYears) {
      const row = airportRaw?.find((r) => r.year === yr && r.month === month);
      if (row) point[String(yr)] = row.totalPassengers;
    }
    // ── 2026 estimate overlay (dotted) ─────────────────────────────────────
    // The overlap point at lastOfficial2026Month makes the dotted line connect
    // visually to the solid line — it is filtered out of the tooltip via the
    // custom content renderer below.
    if (estimated2026.length > 0) {
      if (month === lastOfficial2026Month) {
        const overlapRow = official2026Rows.find((r) => r.month === month);
        if (overlapRow) point["2026est"] = overlapRow.totalPassengers;
      }
      const estRow = estimated2026.find((e) => e.month === month);
      if (estRow) point["2026est"] = estRow.projectedFullMonthPassengers;
    }
    return point;
  });
  const airportColors: Record<number, string> = { 2024: "#6366F1", 2025: "#00C2A8", 2026: "#F59E0B" };
  const latestAirportYear = airportYears.length ? Math.max(...airportYears) : 0;

  // ── Airport YoY stats ────────────────────────────────────────────────────
  const airport2026Official = airportRaw?.filter((r) => r.year === 2026).sort((a, b) => a.month - b.month) ?? [];
  const airportYoYRows = airport2026Official.map((r) => {
    const prior = airportRaw?.find((p) => p.year === 2025 && p.month === r.month);
    const pct   = prior ? (r.totalPassengers - prior.totalPassengers) / prior.totalPassengers * 100 : null;
    return { month: r.month, cur: r.totalPassengers, prior: prior?.totalPassengers ?? null, pct, anomaly: r.anomaly ?? null };
  });

  // Months in the YoY grid that have a detected anomaly (for the market note block)
  const anomalousThroughOfficialData = airportYoYRows.filter((r) => r.anomaly?.detected);
  // First anomaly (for the market note) — may be null
  const firstAnomaly = anomalousThroughOfficialData[0]?.anomaly ?? null;
  const ytd2026 = airport2026Official.reduce((s, r) => s + r.totalPassengers, 0);
  const ytd2025 = airport2026Official.reduce((s, r) => {
    const p = airportRaw?.find((p) => p.year === 2025 && p.month === r.month);
    return s + (p?.totalPassengers ?? 0);
  }, 0);
  const ytdPct = ytd2025 > 0 ? (ytd2026 - ytd2025) / ytd2025 * 100 : null;

  // ── SECTUR KPI aggregates ────────────────────────────────────────────────
  const totals = data?.reduce(
    (acc, row) => ({
      arrivals: acc.arrivals + (row.totalArrivals ?? 0),
      cruise:   acc.cruise   + (row.cruiseVisitors ?? 0),
      intl:     acc.intl     + (row.internationalArrivals ?? 0),
    }),
    { arrivals: 0, cruise: 0, intl: 0 }
  );
  const avgOccupancy = data && data.length > 0
    ? data.reduce((s, r) => s + r.hotelOccupancyRate, 0) / data.length
    : null;
  const avgAdr = data && data.length > 0
    ? data.reduce((s, r) => s + (r.avgHotelRateUsd ?? 0), 0) / data.length
    : null;
  return (
    <PageWrapper>
      {/* ── Page header ──────────────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
          {t("Tourism Metrics", "Métricas Turísticas")}
        </h1>
        <p className="text-muted-foreground mt-1">
          {lang === "es"
            ? "Aeropuertos, hoteles y cruceros · fuentes: "
            : "Airports, hotels and cruise data · sources: "}
          <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
             className="text-primary hover:underline inline-flex items-center gap-0.5">
            DATATUR <ExternalLink className="w-3 h-3" />
          </a>
          {" · "}
          <a href="https://www.globenewswire.com/search/organization/Grupo%20Aeroportuario%20del%20Pac%C3%ADfico"
             target="_blank" rel="noopener noreferrer"
             className="text-primary hover:underline inline-flex items-center gap-0.5">
            GAP <ExternalLink className="w-3 h-3" />
          </a>
        </p>
      </div>

      {/* ── PVR Airport Metrics subheader ─────────────────────────────────── */}
      <div className="mb-6">
        <h2 className="text-xl font-display font-bold tracking-tight text-foreground">
          {t("PVR Airport Metrics", "Métricas Aeropuerto PVR")}
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {t("Passenger traffic, arrivals & trends · GAP official data", "Tráfico de pasajeros, llegadas y tendencias · datos oficiales GAP")}
        </p>
      </div>

      {/* ── Airport traffic (always visible — GAP real data incl. 2026) ──── */}
      {airportRaw && airportRaw.length > 0 && (
        <Card className="glass-card mb-6">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle>{t("PVR Airport Passenger Traffic", "Tráfico de Pasajeros Aeropuerto PVR")}</CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  {t(
                    "Year-over-year monthly comparison · solid = official GAP data · dotted = passenger estimate",
                    "Comparativo mensual interanual · sólido = datos oficiales GAP · punteado = estimación de pasajeros"
                  )}
                </p>
              </div>
              <a href="https://www.globenewswire.com/search/organization/Grupo%20Aeroportuario%20del%20Pac%C3%ADfico"
                 target="_blank" rel="noopener noreferrer"
                 className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors">
                GAP / GlobeNewswire <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </CardHeader>
          <CardContent className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={airportChartData} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
                {GRID}
                <XAxis dataKey="month" {...AXIS_PROPS} tick={TICK} dy={8} />
                <YAxis {...AXIS_PROPS} tick={TICK}
                  tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                  domain={[(min: number) => Math.floor(min * 0.92), (max: number) => Math.ceil(max * 1.04)]}
                  width={48}
                />
                <Tooltip
                  cursor={TOOLTIP_CURSOR}
                  content={({ active, payload, label: tooltipLabel }) => {
                    if (!active || !payload?.length) return null;
                    const dataPoint = payload[0]?.payload as Record<string, unknown>;
                    const hasReal2026 = dataPoint?.["2026"] !== undefined;
                    const visible = payload
                      .filter((e) => !(e.dataKey === "2026est" && hasReal2026))
                      .slice()
                      .sort((a, b) => {
                        const aKey = a.dataKey === "2026est" ? 2026.5 : Number(a.dataKey);
                        const bKey = b.dataKey === "2026est" ? 2026.5 : Number(b.dataKey);
                        return bKey - aKey;
                      });
                    return (
                      <div style={TOOLTIP_CONTENT_STYLE}>
                        <p style={TOOLTIP_LABEL_STYLE}>{tooltipLabel}</p>
                        {visible.map((e, i) => {
                          const isEst = e.dataKey === "2026est";
                          const isMostRecent = i === 0;
                          const entryLabel = isEst
                            ? `2026 (${t("est.", "est.")}) ${t("passengers", "pasajeros")}`
                            : `${e.name} ${t("passengers", "pasajeros")}`;
                          return (
                            <p key={i} style={{ ...TOOLTIP_ITEM_STYLE, fontWeight: isMostRecent ? 700 : 400 }}>
                              {entryLabel} : {formatNumber(e.value as number)}
                            </p>
                          );
                        })}
                      </div>
                    );
                  }}
                />
                <Legend iconType="circle" wrapperStyle={{ paddingTop: "16px" }} />
                {airportYears.map((yr) => (
                  <Line key={yr} type="monotone" dataKey={String(yr)} name={String(yr)}
                    stroke={airportColors[yr] ?? "#9AA5B1"}
                    strokeWidth={yr === latestAirportYear ? 2.5 : 1.5}
                    dot={false}
                    connectNulls={false}
                  />
                ))}
                {/* Dotted overlay for estimated 2026 months — same amber color as the solid 2026 line */}
                {estimated2026.length > 0 && (
                  <Line
                    type="monotone"
                    dataKey="2026est"
                    name={t("2026 (est.)", "2026 (est.)")}
                    stroke={airportColors[2026] ?? "#F59E0B"}
                    strokeWidth={2.5}
                    strokeDasharray="5 4"
                    dot={false}
                    connectNulls={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* ── Airport YoY stats for 2026 ───────────────────────────────────── */}
      {airportYoYRows.length > 0 && (
        <Card className="glass-card mb-6">
          <CardHeader className="pb-3">
            <div className="flex items-center gap-2">
              <TrendingUp className="w-4 h-4" style={{ color: "#F59E0B" }} />
              <CardTitle>{t("2026 Airport Traffic vs 2025", "Tráfico Aéreo 2026 vs 2025")}</CardTitle>
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              {t("Year-over-year change per month · PVR total passengers", "Cambio interanual por mes · pasajeros totales PVR")}
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
              {airportYoYRows.map(({ month, cur, prior, pct, anomaly }) => {
                const positive = pct !== null && pct >= 0;
                const hasAnomaly = anomaly?.detected;
                const isRecovery = hasAnomaly && (anomaly?.recoveryPhase === "recovery" || anomaly?.recoveryPhase === "normalised");
                return (
                  <div key={month} className="rounded-xl p-3" style={{
                    background: hasAnomaly && !isRecovery ? "rgba(251,191,36,0.05)" : "rgba(255,255,255,0.03)",
                    border: hasAnomaly && !isRecovery ? "1px solid rgba(251,191,36,0.18)" : "1px solid rgba(255,255,255,0.06)",
                  }}>
                    <div className="text-xs text-muted-foreground mb-1 flex items-center justify-between gap-1">
                      <span>{MONTH_NAMES_LONG[month - 1]}</span>
                      {hasAnomaly && !isRecovery && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold leading-none" style={{ background: "rgba(251,191,36,0.15)", color: "#FBBF24" }}>
                          {t("event", "evento")}
                        </span>
                      )}
                      {isRecovery && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold leading-none" style={{ background: "rgba(0,194,168,0.1)", color: "#00C2A8" }}>
                          {t("recovery", "recuperación")}
                        </span>
                      )}
                    </div>
                    <div className="text-base font-bold text-foreground">{formatNumber(cur)}</div>
                    <div className="text-xs mt-0.5" style={{ color: pct !== null ? (positive ? "#00C2A8" : "#F87171") : "#9AA5B1" }}>
                      {pct !== null ? `${positive ? "+" : ""}${pct.toFixed(1)}% YoY` : "—"}
                    </div>
                    {prior !== null && (
                      <div className="text-xs mt-0.5" style={{ color: "#9AA5B1" }}>
                        {t("vs", "vs")} {formatNumber(prior)} {t("in 2025", "en 2025")}
                      </div>
                    )}
                  </div>
                );
              })}
              {ytdPct !== null && (
                <div className="rounded-xl p-3" style={{ background: "rgba(245,158,11,0.07)", border: "1px solid rgba(245,158,11,0.18)" }}>
                  <div className="text-xs font-semibold mb-1" style={{ color: "#F59E0B" }}>{t("YTD Total", "Total Año")}</div>
                  <div className="text-base font-bold text-foreground">{formatNumber(ytd2026)}</div>
                  <div className="text-xs mt-0.5" style={{ color: ytdPct >= 0 ? "#00C2A8" : "#F87171" }}>
                    {`${ytdPct >= 0 ? "+" : ""}${ytdPct.toFixed(1)}% YoY`}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: "#9AA5B1" }}>
                    {t("vs", "vs")} {formatNumber(ytd2025)} {t("in 2025", "en 2025")}
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Market context note (shown when official data includes anomalous months) */}
      {firstAnomaly && (
        <div className="rounded-xl px-4 py-3 mb-6 flex items-start gap-3" style={{ background: "rgba(251,191,36,0.06)", border: "1px solid rgba(251,191,36,0.2)" }}>
          <Info className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#FBBF24" }} />
          <div>
            <p className="text-sm font-semibold mb-0.5" style={{ color: "#FBBF24" }}>
              {t("Market context", "Contexto de mercado")}
            </p>
            <p className="text-xs" style={{ color: "#CBD5E1" }}>
              {lang === "es"
                ? firstAnomaly.commentary?.es
                : firstAnomaly.commentary?.en}
            </p>
          </div>
        </div>
      )}

      {/* ── Airport estimates: all months without an official GAP total ── */}
      {pendingEstimates && pendingEstimates.map((est) => {
        const monthName   = MONTH_NAMES_LONG[est.month - 1];
        const yoyPct      = est.estimatedVsSameMonthLastYearPct;
        const yoyPos      = yoyPct !== null && yoyPct >= 0;
        const isComplete  = est.monthComplete;

        return (
          <Card key={`${est.year}-${est.month}`} className="glass-card mb-6">
            <CardHeader className="pb-3">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Plane className="w-4 h-4" style={{ color: "#3B82F6" }} />
                    <CardTitle>
                      {t("PVR Airport", "Aeropuerto PVR")} · {monthName} {est.year}
                    </CardTitle>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold"
                      style={{ background: "rgba(148,163,184,0.12)", color: "#94A3B8", border: "1px solid rgba(148,163,184,0.35)" }}>
                      {t("Estimate", "Estimación")}: {t(
                        est.confidence === "low" ? "Low Confidence" : est.confidence === "medium" ? "Medium Confidence" : "High Confidence",
                        est.confidence === "low" ? "Confianza baja" : est.confidence === "medium" ? "Confianza media" : "Confianza alta"
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1.5">
                    {isComplete
                      ? t(
                          "Month complete · awaiting official GAP press release",
                          "Mes completo · en espera del comunicado oficial de GAP",
                        )
                      : t(
                          `${est.daysElapsed} of ${est.daysInMonth} days elapsed — projecting full month from official GAP trends`,
                          `${est.daysElapsed} de ${est.daysInMonth} días transcurridos — proyectando mes completo con datos GAP`,
                        )}
                  </p>
                </div>
                <a href="https://www.aeropuertosgap.com.mx/en/material-events.html"
                   target="_blank" rel="noopener noreferrer"
                   className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors whitespace-nowrap">
                  GAP <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="rounded-xl p-4" style={{ background: "rgba(59,130,246,0.08)", border: "1px solid rgba(59,130,246,0.2)" }}>
                  <div className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "#9AA5B1" }}>
                    {isComplete
                      ? t("Full Month Estimate", "Estimación Mes Completo")
                      : t("Projected Full Month", "Proyección Mes Completo")}
                  </div>
                  <div className="text-2xl font-bold" style={{ color: "#F5F7FA", letterSpacing: "-0.02em" }}>
                    {formatNumber(est.projectedFullMonthPassengers)}
                  </div>
                  <div className="text-xs mt-1" style={{ color: "#9AA5B1" }}>
                    {t("passengers", "pasajeros")}
                  </div>
                </div>
                {!isComplete && (
                  <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                    <div className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "#9AA5B1" }}>
                      {t("To Date", "Hasta la Fecha")} ({est.daysElapsed}d)
                    </div>
                    <div className="text-2xl font-bold" style={{ color: "#F5F7FA", letterSpacing: "-0.02em" }}>
                      {formatNumber(est.estimatedPassengersToDate)}
                    </div>
                    <div className="text-xs mt-1" style={{ color: "#9AA5B1" }}>
                      {t("estimated", "estimado")}
                    </div>
                  </div>
                )}
                <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "#9AA5B1" }}>
                    {t("Avg Daily", "Promedio Diario")}
                  </div>
                  <div className="text-2xl font-bold" style={{ color: "#F5F7FA", letterSpacing: "-0.02em" }}>
                    {formatNumber(est.averageDailyPassengersToDate)}
                  </div>
                  <div className="text-xs mt-1" style={{ color: "#9AA5B1" }}>
                    {t("passengers/day", "pasajeros/día")}
                  </div>
                </div>
                <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                  <div className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: "#9AA5B1" }}>
                    {t(`vs ${monthName} ${est.year - 1}`, `vs ${monthName} ${est.year - 1}`)}
                  </div>
                  <div className="text-2xl font-bold" style={{ color: yoyPct !== null ? (yoyPos ? "#00C2A8" : "#F87171") : "#9AA5B1", letterSpacing: "-0.02em" }}>
                    {yoyPct !== null ? `${yoyPos ? "+" : ""}${yoyPct.toFixed(1)}%` : "—"}
                  </div>
                  <div className="text-xs mt-1" style={{ color: "#9AA5B1" }}>
                    {est.sameMonthLastYearPassengers !== null
                      ? formatNumber(est.sameMonthLastYearPassengers) + " " + t("last year", "año pasado")
                      : t("no prior data", "sin datos previos")}
                  </div>
                </div>
              </div>
              <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2" style={{ background: "rgba(148,163,184,0.06)", color: "#9AA5B1", border: "1px solid rgba(148,163,184,0.12)" }}>
                <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 opacity-60" />
                <span>{isComplete
                  ? t(
                      "This month is complete but official GAP data has not yet been published. The estimate uses year-over-year pacing from official prior months. It will be replaced automatically when GAP releases the press release (typically the first week of the following month).",
                      "Este mes ha concluido pero los datos oficiales de GAP aún no han sido publicados. La estimación usa el ritmo interanual de meses oficiales anteriores. Se actualizará automáticamente cuando GAP publique el comunicado (generalmente la primera semana del mes siguiente).",
                    )
                  : t(
                      "Estimate based on recent official GAP passenger trends and seasonal pacing. Final monthly total will be updated when official airport data is released (typically the first week of the following month).",
                      "Estimación basada en tendencias oficiales de pasajeros GAP y pacing estacional. El total mensual definitivo se actualizará cuando se publiquen datos oficiales del aeropuerto (generalmente la primera semana del mes siguiente).",
                    )}
                </span>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* ── Hotel & tourism statistics section header ────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mt-10 mb-6">
        <div>
          <h2 className="text-xl font-display font-bold tracking-tight text-foreground">
            {t("Hotel & Tourism Statistics", "Estadísticas Hoteleras y Turísticas")}
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {t("SECTUR / DATATUR official data · select a year to explore", "Datos oficiales SECTUR / DATATUR · selecciona un año para explorar")}
          </p>
        </div>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {YEARS.map((y) => (
            <option key={y} value={y}>{yearLabel(y)}</option>
          ))}
        </select>
      </div>

      {/* ── SECTUR / DATATUR section (year-filtered) ─────────────────────── */}
      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-96 w-full rounded-2xl" />
          <Skeleton className="h-72 w-full rounded-2xl" />
          <Skeleton className="h-72 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium mb-2">
            {t("API Endpoint Not Connected Yet", "Endpoint de API No Conectado Aún")}
          </div>
          <p className="text-sm text-muted-foreground/70">/api/metrics/tourism?year={year}</p>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-6">

          {/* ── KPI pills ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            {[
              {
                label: t("Total Arrivals", "Total Llegadas"),
                value: totals ? formatNumber(totals.arrivals) : "—",
                sub: t("visitors incl. domestic", "visitantes incl. nacionales"),
                icon: <Plane className="w-5 h-5" />, color: "#3B82F6",
              },
              {
                label: t("Cruise Visitors", "Cruceristas"),
                value: totals ? formatNumber(totals.cruise) : "—",
                sub: t("day visitors by sea", "visitantes en crucero"),
                icon: <Ship className="w-5 h-5" />, color: "#6366F1",
              },
              {
                label: t("Intl Arrivals", "Llegadas Internacionales"),
                value: totals ? formatNumber(totals.intl) : "—",
                sub: t("foreign visitors", "visitantes extranjeros"),
                icon: <Users className="w-5 h-5" />, color: "#00C2A8",
              },
              {
                label: t("Avg Hotel Occupancy", "Ocupación Hotelera Prom."),
                value: avgOccupancy != null ? formatPercent(avgOccupancy) : "—",
                sub: t("annual avg · DATATUR", "promedio anual · DATATUR"),
                icon: <Building2 className="w-5 h-5" />, color: "#F59E0B",
              },
              {
                label: t("Avg Daily Rate (ADR)", "Tarifa Diaria Prom. (ADR)"),
                value: avgAdr != null ? `$${avgAdr.toFixed(0)}` : "—",
                sub: t("USD per night · DATATUR", "USD por noche · DATATUR"),
                icon: <DollarSign className="w-5 h-5" />, color: "#00D1FF",
              },
            ].map(({ label, value, sub, icon, color }) => (
              <div key={label} className="glass-card flex flex-col gap-2" style={{ padding: "1.25rem" }}>
                <div className="flex items-center gap-2">
                  <span style={{ color }}>{icon}</span>
                  <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "#9AA5B1" }}>
                    {label}
                  </span>
                </div>
                <div className="text-2xl font-bold" style={{ color: "#F5F7FA", letterSpacing: "-0.02em" }}>
                  {value}
                </div>
                <div className="text-xs" style={{ color: "#9AA5B1" }}>{sub}</div>
              </div>
            ))}
          </div>

          {/* ── Tourist Arrivals by Origin ────────────────────────────── */}
          <Card className="glass-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>{t("Tourist Arrivals by Origin", "Llegadas de Turistas por Origen")}</CardTitle>
                <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
                   className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors">
                  DATATUR / SECTUR <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent className="h-[360px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
                  {GRID}
                  <XAxis dataKey="monthName" {...AXIS_PROPS} tick={TICK} dy={8} />
                  <YAxis {...AXIS_PROPS} tick={TICK} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} width={44} />
                  <Tooltip
                    {...CHART_TOOLTIP}
                    cursor={TOOLTIP_CURSOR}
                    labelFormatter={(label) => `${label} ${year}`}
                    formatter={(val: number, name: string) => [formatNumber(val), name]}
                  />
                  <Legend iconType="circle" wrapperStyle={{ paddingTop: "16px" }} />
                  <Bar dataKey="internationalArrivals" name={t("International", "Internacional")}
                    fill="#00C2A8" radius={[3, 3, 0, 0]} stackId="a" />
                  <Bar dataKey="domesticArrivals" name={t("Domestic", "Nacional")}
                    fill="#F59E0B" radius={[3, 3, 0, 0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ── Hotel Performance: Occupancy + ADR ───────────────────── */}
          <Card className="glass-card">
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle>{t("Hotel Performance", "Desempeño Hotelero")}</CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t(
                      "Monthly occupancy rate vs. average daily rate (ADR) in USD",
                      "Ocupación mensual vs. tarifa diaria promedio (ADR) en USD"
                    )}
                  </p>
                </div>
                <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
                   className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors">
                  DATATUR / SECTUR <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent className="h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={data} margin={{ top: 10, right: 50, left: 10, bottom: 5 }}>
                  {GRID}
                  <XAxis dataKey="monthName" {...AXIS_PROPS} tick={TICK} dy={8} />
                  <YAxis yAxisId="occ" {...AXIS_PROPS} tick={TICK}
                    tickFormatter={(v) => `${v.toFixed(0)}%`}
                    domain={[(min: number) => Math.max(0, Math.floor(min - 8)), 100]}
                    width={44}
                  />
                  <YAxis yAxisId="adr" orientation="right" {...AXIS_PROPS} tick={TICK}
                    tickFormatter={(v) => `$${v.toFixed(0)}`}
                    domain={[(min: number) => Math.floor(min * 0.88), (max: number) => Math.ceil(max * 1.06)]}
                    width={52}
                  />
                  <Tooltip
                    {...CHART_TOOLTIP}
                    cursor={TOOLTIP_CURSOR}
                    labelFormatter={(label) => `${label} ${year}`}
                    formatter={(val: number, name: string) => {
                      if (name === t("Occupancy Rate", "Tasa de Ocupación")) return [`${val.toFixed(1)}%`, name];
                      if (name === t("Avg Daily Rate (ADR)", "Tarifa Diaria Prom. (ADR)")) return [`$${val.toFixed(0)}`, name];
                      return [val, name];
                    }}
                  />
                  <Legend iconType="circle" wrapperStyle={{ paddingTop: "16px" }} />
                  <Area
                    yAxisId="occ"
                    type="monotone"
                    dataKey="hotelOccupancyRate"
                    name={t("Occupancy Rate", "Tasa de Ocupación")}
                    stroke="#F59E0B"
                    fill="#F59E0B"
                    fillOpacity={0.15}
                    strokeWidth={2}
                    dot={false}
                  />
                  <Line
                    yAxisId="adr"
                    type="monotone"
                    dataKey="avgHotelRateUsd"
                    name={t("Avg Daily Rate (ADR)", "Tarifa Diaria Prom. (ADR)")}
                    stroke="#00D1FF"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ── Cruise Data section header ───────────────────────────── */}
          <div className="flex flex-col gap-1 mt-10 mb-6">
            <h2 className="text-xl font-display font-bold tracking-tight text-foreground">
              {t("Cruise Data", "Datos de Cruceros")}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("Historical visitor counts · SECTUR / DATATUR · live port schedule via CruiseDig", "Conteos históricos · SECTUR / DATATUR · agenda en vivo del puerto vía CruiseDig")}
            </p>
          </div>

          {/* ── Cruise Visitors ──────────────────────────────────────── */}
          <Card className="glass-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4" style={{ color: "#6366F1" }} />
                  <CardTitle>{t("Cruise Visitors by Month", "Visitantes de Crucero por Mes")}</CardTitle>
                </div>
                <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
                   className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors">
                  DATATUR / SECTUR <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 10, right: 30, left: 10, bottom: 5 }}>
                  {GRID}
                  <XAxis dataKey="monthName" {...AXIS_PROPS} tick={TICK} dy={8} />
                  <YAxis {...AXIS_PROPS} tick={TICK} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} width={44} />
                  <Tooltip
                    {...CHART_TOOLTIP}
                    cursor={TOOLTIP_CURSOR}
                    labelFormatter={(label) => `${label} ${year}`}
                    formatter={(val: number, name: string) => [formatNumber(val), name]}
                  />
                  <Bar dataKey="cruiseVisitors" name={t("Cruise Visitors", "Visitantes de Crucero")}
                    fill="#6366F1" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ── Monthly data table ───────────────────────────────────── */}
          <Card className="glass-card overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-2">
              <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
                {t("Monthly Data", "Datos Mensuales")} · {year}
              </h3>
              <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
                 className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors">
                {t("Source: DATATUR / SECTUR", "Fuente: DATATUR / SECTUR")} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
                  <tr>
                    <th className="px-4 py-3">{t("Month", "Mes")}</th>
                    <th className="px-4 py-3">{t("Occupancy", "Ocupación")}</th>
                    <th className="px-4 py-3">{t("ADR (USD)", "TAD (USD)")}</th>
                    <th className="px-4 py-3">{t("Intl Arrivals", "Llegadas Int.")}</th>
                    <th className="px-4 py-3">{t("Dom Arrivals", "Llegadas Nac.")}</th>
                    <th className="px-4 py-3">{t("Total", "Total")}</th>
                    <th className="px-4 py-3">{t("Cruise", "Crucero")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3 font-medium text-foreground">{row.monthName}</td>
                      <td className="px-4 py-3">{formatPercent(row.hotelOccupancyRate)}</td>
                      <td className="px-4 py-3">
                        {row.avgHotelRateUsd != null ? `$${Number(row.avgHotelRateUsd).toFixed(0)}` : "—"}
                      </td>
                      <td className="px-4 py-3">
                        {row.internationalArrivals ? formatNumber(row.internationalArrivals) : "—"}
                      </td>
                      <td className="px-4 py-3">
                        {row.domesticArrivals ? formatNumber(row.domesticArrivals) : "—"}
                      </td>
                      <td className="px-4 py-3 font-semibold">{formatNumber(row.totalArrivals)}</td>
                      <td className="px-4 py-3">
                        {row.cruiseVisitors != null ? formatNumber(row.cruiseVisitors) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

        </div>
      ) : year >= 2026 ? (
        <div className="rounded-2xl p-8" style={{ background: "rgba(0,194,168,0.05)", border: "1px solid rgba(0,194,168,0.15)" }}>
          <div className="flex items-start gap-3">
            <TrendingUp className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "#00C2A8" }} />
            <div>
              <p className="font-semibold text-foreground mb-1">
                {t("SECTUR / DATATUR data for 2026 is not yet published", "Los datos de SECTUR / DATATUR para 2026 aún no están publicados")}
              </p>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Mexico's official tourism statistics (DATATUR) are typically released with a 2–3 month lag. Airport passenger data from GAP is already available above and is updated monthly.",
                  "Las estadísticas de turismo oficiales de México (DATATUR) se publican con un rezago de 2–3 meses. Los datos de pasajeros del aeropuerto GAP ya están disponibles arriba y se actualizan mensualmente."
                )}
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground">
          {t("No data available for this year.", "No hay datos disponibles para este año.")}
        </div>
      )}

      {/* ── Live cruise port schedule (CruiseDig, near real-time) ──────── */}
      {cruiseSchedule && cruiseSchedule.length > 0 && (() => {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const upcoming = cruiseSchedule
          .filter((a) => new Date(a.date) >= today)
          .sort((a, b) => a.date.localeCompare(b.date))
          .slice(0, 60);

        const weekBuckets: Record<string, { label: string; passengers: number; ships: number }> = {};
        for (const a of upcoming) {
          const d = new Date(a.date);
          const weekStart = new Date(d);
          weekStart.setDate(d.getDate() - d.getDay());
          const key = weekStart.toISOString().split("T")[0];
          const mon = d.getMonth();
          const label = `${d.getDate()} ${MONTH_NAMES_LONG[mon].slice(0, 3)}`;
          if (!weekBuckets[key]) weekBuckets[key] = { label, passengers: 0, ships: 0 };
          weekBuckets[key].passengers += a.passengers;
          weekBuckets[key].ships += 1;
        }
        const weekData = Object.entries(weekBuckets)
          .sort(([a], [b]) => a.localeCompare(b))
          .slice(0, 10)
          .map(([, v]) => v);

        const nextShip = upcoming[0];
        const totalNextMonth = upcoming
          .filter((a) => {
            const d = new Date(a.date);
            return d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
          })
          .reduce((s, a) => s + a.passengers, 0);

        return (
          <Card className="glass-card mt-6">
            <CardHeader>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <Ship className="w-4 h-4" style={{ color: "#6366F1" }} />
                    <CardTitle>{t("Live Cruise Port Schedule", "Agenda en Vivo del Puerto de Cruceros")}</CardTitle>
                    <span className="text-xs px-2 py-0.5 rounded-full font-semibold" style={{ background: "#163C4A", color: "#00C2A8", border: "1px solid #00C2A8" }}>
                      {t("Live", "En Vivo")}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t(
                      "Upcoming cruise ship arrivals with passenger counts — updated daily",
                      "Próximas llegadas de cruceros con número de pasajeros — actualizado diariamente"
                    )}
                    {nextShip && (
                      <span className="ml-2 text-primary font-medium">
                        · {t("Next arrival", "Próxima llegada")}: {nextShip.ship} {nextShip.date}
                      </span>
                    )}
                  </p>
                </div>
                <a href="https://cruisedig.com/ports/puerto-vallarta-mexico/arrivals"
                   target="_blank" rel="noopener noreferrer"
                   className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors">
                  CruiseDig <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                {[
                  { label: t("Arrivals in next 60 days", "Escalas próx. 60 días"), value: String(upcoming.length) },
                  { label: t("Est. cruise visitors (60 days)", "Viajeros est. (60 días)"), value: formatNumber(upcoming.reduce((s, a) => s + a.passengers, 0)) },
                  { label: t("This month's cruise visitors", "Cruceristas este mes"), value: formatNumber(totalNextMonth) },
                  { label: t("Cruise lines calling", "Líneas activas"), value: String(new Set(upcoming.map((a) => a.line)).size) },
                ].map(({ label, value }) => (
                  <div key={label} className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <div className="text-xs text-muted-foreground mb-1">{label}</div>
                    <div className="text-lg font-bold text-foreground">{value}</div>
                  </div>
                ))}
              </div>
              {weekData.length > 0 && (
                <div className="h-[200px] mb-5">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={weekData} margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                      {GRID}
                      <XAxis dataKey="label" {...AXIS_PROPS} tick={{ ...TICK, fontSize: 11 }} dy={6} />
                      <YAxis {...AXIS_PROPS} tick={{ ...TICK, fontSize: 11 }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} width={36} />
                      <Tooltip
                        {...CHART_TOOLTIP}
                        cursor={TOOLTIP_CURSOR}
                        formatter={(val: number, name: string) => [formatNumber(val), name]}
                        labelFormatter={(label) => `${t("Week of", "Semana del")} ${label}`}
                      />
                      <Bar dataKey="passengers" name={t("Cruise Passengers", "Pasajeros de Crucero")} fill="#6366F1" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
                    <tr>
                      <th className="px-4 py-3">{t("Date", "Fecha")}</th>
                      <th className="px-4 py-3">{t("Ship", "Barco")}</th>
                      <th className="px-4 py-3">{t("Cruise Line", "Línea")}</th>
                      <th className="px-4 py-3 text-right">{t("Passengers", "Pasajeros")}</th>
                      <th className="px-4 py-3">{t("Time", "Hora")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.slice(0, 20).map((a, i) => {
                      const d = new Date(a.date);
                      const isToday = d.toDateString() === today.toDateString();
                      const isTomorrow = d.toDateString() === new Date(today.getTime() + 86400000).toDateString();
                      return (
                        <tr key={`${a.date}-${a.ship}-${i}`}
                          className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                          style={isToday ? { background: "rgba(0,194,168,0.06)" } : undefined}>
                          <td className="px-4 py-3 font-medium text-foreground whitespace-nowrap">
                            {isToday ? (
                              <span className="text-primary font-bold">{t("Today", "Hoy")}</span>
                            ) : isTomorrow ? (
                              <span style={{ color: "#F59E0B" }}>{t("Tomorrow", "Mañana")}</span>
                            ) : (
                              <span>{d.getDate()} {MONTH_NAMES_LONG[d.getMonth()].slice(0, 3)} {d.getFullYear()}</span>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <a href={a.shipUrl} target="_blank" rel="noopener noreferrer"
                               className="hover:text-primary transition-colors flex items-center gap-1">
                              {a.ship} <ExternalLink className="w-3 h-3 opacity-40" />
                            </a>
                          </td>
                          <td className="px-4 py-3 text-muted-foreground">{a.line}</td>
                          <td className="px-4 py-3 text-right font-semibold">{formatNumber(a.passengers)}</td>
                          <td className="px-4 py-3 text-muted-foreground">{a.time}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {upcoming.length > 20 && (
                  <p className="text-xs text-muted-foreground text-center py-3">
                    {t(`Showing 20 of ${upcoming.length} upcoming arrivals`, `Mostrando 20 de ${upcoming.length} llegadas próximas`)}
                    {" · "}
                    <a href="https://cruisedig.com/ports/puerto-vallarta-mexico/arrivals" target="_blank" rel="noopener noreferrer"
                       className="text-primary hover:underline">
                      {t("View all on CruiseDig", "Ver todos en CruiseDig")}
                    </a>
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        );
      })()}
    </PageWrapper>
  );
}
