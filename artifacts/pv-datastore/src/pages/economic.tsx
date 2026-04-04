import { useState, useMemo } from "react";
import { useGetTourismMetrics, useGetAirportMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer,
  ComposedChart,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
} from "recharts";
import { ExternalLink } from "lucide-react";
import { formatNumber } from "@/lib/utils";

const REAL_DATA_YEARS = [2025, 2024];

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

function pct(v: number) { return `${v.toFixed(1)}%`; }
function usd(v: number) { return `$${v.toFixed(0)}`; }

export default function Economic() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(2025);

  const { data: tourismAll, isLoading: tourismLoading } = useGetTourismMetrics({});
  const { data: airportAll, isLoading: airportLoading } = useGetAirportMetrics({});

  const isLoading = tourismLoading || airportLoading;

  // ── Aggregate DATATUR (2 rows per month → average) ──────────────────────
  const tourismAgg = useMemo(() => {
    if (!tourismAll) return {};
    const map: Record<string, { occ: number; adr: number; revpar: number; cnt: number; monthName: string; year: number; month: number }> = {};
    for (const row of tourismAll) {
      const key = `${row.year}-${row.month}`;
      if (!map[key]) map[key] = { occ: 0, adr: 0, revpar: 0, cnt: 0, monthName: row.monthName, year: row.year, month: row.month };
      map[key].cnt++;
      map[key].occ += row.hotelOccupancyRate;
      map[key].adr += row.avgHotelRateUsd ?? 0;
      map[key].revpar += row.revenuePerAvailableRoomUsd ?? 0;
    }
    return map;
  }, [tourismAll]);

  const flatTourism = useMemo(() =>
    Object.values(tourismAgg).map((g) => ({
      year: g.year, month: g.month, monthName: g.monthName,
      occupancy: +(g.occ / g.cnt).toFixed(2),
      adr: +(g.adr / g.cnt).toFixed(2),
      revpar: +(g.revpar / g.cnt).toFixed(2),
    })).sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month),
  [tourismAgg]);

  // ── KPIs for selected year ───────────────────────────────────────────────
  const selTourism = flatTourism.filter((r) => r.year === year);
  const selAirport = (airportAll ?? []).filter((r) => r.year === year);

  const avgOccupancy = selTourism.length > 0
    ? selTourism.reduce((s, r) => s + r.occupancy, 0) / selTourism.length : null;
  const avgAdr = selTourism.length > 0
    ? selTourism.reduce((s, r) => s + r.adr, 0) / selTourism.length : null;
  const avgRevpar = selTourism.length > 0
    ? selTourism.reduce((s, r) => s + r.revpar, 0) / selTourism.length : null;
  const totalPax = selAirport.reduce((s, r) => s + r.totalPassengers, 0);
  const intlPax = selAirport.reduce((s, r) => s + (r.internationalPassengers ?? 0), 0);
  const domPax  = selAirport.reduce((s, r) => s + (r.domesticPassengers ?? 0), 0);
  const knownPax = intlPax + domPax;
  const intlShare = knownPax > 0 ? (intlPax / knownPax) * 100 : null;

  // ── RevPAR trend: 2024 vs 2025 side by side ─────────────────────────────
  const revparTrend = MONTH_NAMES.map((name, i) => {
    const month = i + 1;
    const g24 = tourismAgg[`2024-${month}`];
    const g25 = tourismAgg[`2025-${month}`];
    return {
      month: name.slice(0, 3),
      "2024": g24 ? +(g24.revpar / g24.cnt).toFixed(2) : null,
      "2025": g25 ? +(g25.revpar / g25.cnt).toFixed(2) : null,
    };
  });

  // ── Occupancy & ADR for selected year ───────────────────────────────────
  const occAdrData = selTourism.map((r) => ({
    month: r.monthName.slice(0, 3),
    occupancy: r.occupancy,
    adr: r.adr,
  }));

  // ── Airport passengers 2024 vs 2025 ─────────────────────────────────────
  const airportTrend = MONTH_NAMES.map((name, i) => {
    const month = i + 1;
    const a24 = (airportAll ?? []).find((r) => r.year === 2024 && r.month === month);
    const a25 = (airportAll ?? []).find((r) => r.year === 2025 && r.month === month);
    return {
      month: name.slice(0, 3),
      "2024": a24 ? Math.round(a24.totalPassengers / 1000) : null,
      "2025": a25 ? Math.round(a25.totalPassengers / 1000) : null,
    };
  });

  // ── YoY occupancy change ────────────────────────────────────────────────
  const priorYear = year - 1;
  const priorTourism = flatTourism.filter((r) => r.year === priorYear);
  const priorAvgOcc = priorTourism.length > 0
    ? priorTourism.reduce((s, r) => s + r.occupancy, 0) / priorTourism.length : null;
  const occDelta = avgOccupancy !== null && priorAvgOcc !== null
    ? avgOccupancy - priorAvgOcc : null;

  const priorPax = (airportAll ?? []).filter((r) => r.year === priorYear)
    .reduce((s, r) => s + r.totalPassengers, 0);
  const paxDelta = totalPax > 0 && priorPax > 0
    ? ((totalPax - priorPax) / priorPax) * 100 : null;

  const tooltipStyle = {
    borderRadius: "12px", border: "none",
    boxShadow: "0 10px 25px -5px rgba(0,0,0,0.18)",
    background: "#0F2A36",
    color: "#F5F7FA",
  };

  return (
    <PageWrapper>
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t("Economic Indicators", "Indicadores Económicos")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {lang === "es" ? "Economía hotelera y aeroportuaria de " : "Hospitality economy data from "}
            <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5">
              DATATUR <ExternalLink className="w-3 h-3" />
            </a>
            {" "}{lang === "es" ? "y" : "and"}{" "}
            <a href="https://www.gapq.com.mx/inversionistas/informes-trafico/" target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5">
              GAP Airport <ExternalLink className="w-3 h-3" />
            </a>.
          </p>
        </div>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {REAL_DATA_YEARS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-72 w-full rounded-2xl" />
          <Skeleton className="h-72 w-full rounded-2xl" />
          <Skeleton className="h-72 w-full rounded-2xl" />
        </div>
      ) : (
        <div className="space-y-6">

          {/* ── KPI Row ─────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {[
              {
                label: t("Avg Hotel Occupancy", "Ocup. Hotelera Prom."),
                value: avgOccupancy != null ? pct(avgOccupancy) : "—",
                sub: occDelta != null
                  ? `${occDelta >= 0 ? "▲" : "▼"} ${Math.abs(occDelta).toFixed(1)} pp vs ${priorYear}`
                  : `vs ${priorYear}`,
                up: occDelta != null ? occDelta >= 0 : null,
                color: "#00C2A8",
              },
              {
                label: t("Avg Daily Rate (USD)", "Tarifa Diaria Prom."),
                value: avgAdr != null ? usd(avgAdr) : "—",
                sub: t("per room / night", "por habitación / noche"),
                up: null,
                color: "#3B82F6",
              },
              {
                label: t("Avg RevPAR (USD)", "RevPAR Prom."),
                value: avgRevpar != null ? usd(avgRevpar) : "—",
                sub: t("revenue / available room", "ingreso / hab. disponible"),
                up: null,
                color: "#6366F1",
              },
              {
                label: t("Airport Passengers", "Pasajeros en PVR"),
                value: totalPax > 0 ? formatNumber(totalPax) : "—",
                sub: paxDelta != null
                  ? `${paxDelta >= 0 ? "▲" : "▼"} ${Math.abs(paxDelta).toFixed(1)}% vs ${priorYear}`
                  : `${year} total`,
                up: paxDelta != null ? paxDelta >= 0 : null,
                color: "#F59E0B",
              },
              {
                label: t("International Share", "Tráfico Internacional"),
                value: intlShare != null ? pct(intlShare) : "—",
                sub: t("of passengers with breakdown", "de pasajeros con desglose"),
                up: null,
                color: "#EC4899",
              },
            ].map(({ label, value, sub, up, color }) => (
              <div key={label} className="glass-card flex flex-col gap-2" style={{ padding: "1.25rem" }}>
                <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "#9AA5B1" }}>
                  {label}
                </span>
                <div className="text-2xl font-bold" style={{ color, letterSpacing: "-0.02em" }}>
                  {value}
                </div>
                <span className={`text-xs ${up === true ? "text-emerald-400" : up === false ? "text-red-400" : "text-muted-foreground/70"}`}>
                  {sub}
                </span>
              </div>
            ))}
          </div>

          {/* ── Chart 1: RevPAR 2024 vs 2025 ───────────────────────── */}
          <Card className="glass-card border-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">
                    {t("Hotel RevPAR — 2024 vs 2025", "RevPAR Hotelero — 2024 vs 2025")}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("Revenue per available room (USD) — a hotel's core profitability metric",
                       "Ingreso por habitación disponible (USD) — la métrica clave de rentabilidad hotelera")}
                  </p>
                </div>
                <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 shrink-0">
                  DATATUR <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={revparTrend} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <YAxis axisLine={false} tickLine={false} width={44}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(v) => `$${v}`} />
                  <Tooltip contentStyle={tooltipStyle}
                    formatter={(v: number, name: string) => [`$${v}`, name]} />
                  <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }} />
                  <Line type="monotone" dataKey="2024" stroke="#3B82F6" strokeWidth={2.5}
                    dot={{ r: 3, fill: "#3B82F6" }} activeDot={{ r: 5 }}
                    connectNulls={false} />
                  <Line type="monotone" dataKey="2025" stroke="#00C2A8" strokeWidth={2.5}
                    dot={{ r: 3, fill: "#00C2A8" }} activeDot={{ r: 5 }}
                    connectNulls={false} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ── Chart 2: Occupancy vs ADR (selected year) ──────────── */}
          <Card className="glass-card border-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">
                    {t(`${year} — Occupancy vs Average Daily Rate`, `${year} — Ocupación vs Tarifa Diaria Promedio`)}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("Are hotels raising prices when they're full? (Bars = occupancy %, Line = ADR in USD)",
                       "¿Suben los precios cuando los hoteles están llenos? (Barras = ocupación %, Línea = tarifa USD)")}
                  </p>
                </div>
                <a href="https://www.datatur.sectur.gob.mx/" target="_blank" rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 shrink-0">
                  DATATUR <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={300}>
                <ComposedChart data={occAdrData} margin={{ top: 8, right: 48, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <YAxis yAxisId="occ" orientation="left" domain={[0, 100]} axisLine={false} tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(v) => `${v}%`} width={38} />
                  <YAxis yAxisId="adr" orientation="right" axisLine={false} tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(v) => `$${v}`} width={44} />
                  <Tooltip contentStyle={tooltipStyle}
                    formatter={(v: number, name: string) =>
                      name === "occupancy" ? [`${v.toFixed(1)}%`, t("Occupancy", "Ocupación")]
                      : [`$${v.toFixed(0)}`, t("Avg Daily Rate", "Tarifa Diaria")]} />
                  <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }}
                    formatter={(val) => val === "occupancy" ? t("Occupancy %", "Ocupación %") : t("ADR (USD)", "Tarifa (USD)")} />
                  <ReferenceLine yAxisId="occ" y={75} stroke="rgba(255,255,255,0.12)" strokeDasharray="4 4" />
                  <Bar yAxisId="occ" dataKey="occupancy" fill="#3B82F6" radius={[4, 4, 0, 0]} opacity={0.85} />
                  <Line yAxisId="adr" type="monotone" dataKey="adr" stroke="#F59E0B"
                    strokeWidth={2.5} dot={{ r: 3, fill: "#F59E0B" }} activeDot={{ r: 5 }} />
                </ComposedChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ── Chart 3: Airport passengers 2024 vs 2025 ───────────── */}
          <Card className="glass-card border-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base font-semibold">
                    {t("PVR Airport Passengers — 2024 vs 2025 (thousands)", "Pasajeros PVR — 2024 vs 2025 (miles)")}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t("Monthly total passengers — the primary demand driver for PVR's hospitality economy",
                       "Pasajeros totales mensuales — el principal motor de demanda de la economía hotelera de PVR")}
                  </p>
                </div>
                <a href="https://www.gapq.com.mx/inversionistas/informes-trafico/" target="_blank" rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 shrink-0">
                  GAP <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={airportTrend} margin={{ top: 8, right: 24, left: 8, bottom: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                  <YAxis axisLine={false} tickLine={false} width={36}
                    tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                    tickFormatter={(v) => `${v}k`} />
                  <Tooltip contentStyle={tooltipStyle}
                    formatter={(v: number, name: string) =>
                      [`${(v).toFixed(0)}k (${formatNumber(v * 1000)} total)`, name]} />
                  <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }} />
                  <Bar dataKey="2024" fill="#3B82F6" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="2025" fill="#00C2A8" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
              <p className="text-xs text-muted-foreground/60 mt-2 text-center">
                {t(
                  "Sep–Dec values are total-only (international/domestic breakdown not published by GAP for these months).",
                  "Sep–Dic sólo tienen total (GAP no publica el desglose internacional/nacional estos meses)."
                )}
              </p>
            </CardContent>
          </Card>

          {/* ── Monthly Detail Table ─────────────────────────────────── */}
          <Card className="glass-card border-0 overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-2">
              <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
                {t(`${year} Monthly Detail`, `Detalle Mensual ${year}`)}
              </h3>
              <span className="text-xs text-muted-foreground">
                {t("Source: DATATUR (hotel) · GAP (airport)", "Fuente: DATATUR (hotel) · GAP (aeropuerto)")}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b border-border/50">
                  <tr>
                    <th className="px-5 py-3">{t("Month", "Mes")}</th>
                    <th className="px-5 py-3 text-right">{t("Occupancy", "Ocupación")}</th>
                    <th className="px-5 py-3 text-right">{t("ADR (USD)", "Tarifa (USD)")}</th>
                    <th className="px-5 py-3 text-right">{t("RevPAR (USD)", "RevPAR (USD)")}</th>
                    <th className="px-5 py-3 text-right">{t("Airport Pax", "Pasajeros PVR")}</th>
                    <th className="px-5 py-3 text-right">{t("Intl %", "% Intl")}</th>
                  </tr>
                </thead>
                <tbody>
                  {MONTH_NAMES.map((name, i) => {
                    const month = i + 1;
                    const td = tourismAgg[`${year}-${month}`];
                    const ap = (airportAll ?? []).find((r) => r.year === year && r.month === month);
                    const intl = ap?.internationalPassengers ?? null;
                    const dom  = ap?.domesticPassengers ?? null;
                    const paxIntlPct = intl != null && dom != null && (intl + dom) > 0
                      ? ((intl / (intl + dom)) * 100).toFixed(1) + "%" : "—";
                    return (
                      <tr key={month} className="border-b border-border/30 hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3 font-medium text-foreground">{name}</td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {td ? pct(td.occ / td.cnt) : "—"}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {td ? usd(td.adr / td.cnt) : "—"}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums font-semibold">
                          {td ? usd(td.revpar / td.cnt) : "—"}
                        </td>
                        <td className="px-5 py-3 text-right tabular-nums">
                          {ap ? formatNumber(ap.totalPassengers) : "—"}
                        </td>
                        <td className="px-5 py-3 text-right text-muted-foreground tabular-nums">
                          {paxIntlPct}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

        </div>
      )}
    </PageWrapper>
  );
}
