import { useState } from "react";
import { useGetRentalMarketMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { ExternalLink } from "lucide-react";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

import { MONTHLY_DATA_YEARS, LAST_COMPLETED_YEAR, yearLabel } from "@/lib/data-availability";
import { CHART_TOOLTIP, TOOLTIP_CURSOR } from "@/lib/chart-theme";

const YEARS = [...MONTHLY_DATA_YEARS].reverse();

const NEIGHBORHOODS = [
  { value: "Zona Romántica", label: "Zona Romántica (Old Town / Emiliano Zapata)" },
  { value: "Centro", label: "Centro (El Centro / Downtown)" },
  { value: "Conchas Chinas / Amapas", label: "Conchas Chinas / Amapas (South Zone)" },
  { value: "Versalles", label: "Versalles" },
  { value: "Hotel Zone", label: "Hotel Zone (Las Glorias / Zona Hotelera)" },
  { value: "Marina Vallarta", label: "Marina Vallarta" },
  { value: "5 de Diciembre", label: "5 de Diciembre" },
];

export default function RentalMarket() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(LAST_COMPLETED_YEAR);
  const [neighborhood, setNeighborhood] = useState<string>("Zona Romántica");

  const { data, isLoading, error } = useGetRentalMarketMetrics({ year, neighborhood });

  const chartData = data?.map((row) => ({
    name: row.monthName.slice(0, 3),
    [t("Avg Rate", "Tarifa Prom.")]: parseFloat(String(row.avgNightlyRateUsd)),
    [t("Median Rate", "Tarifa Mediana")]: row.medianNightlyRateUsd != null ? parseFloat(String(row.medianNightlyRateUsd)) : null,
    [t("Occupancy %", "Ocupación %")]: parseFloat(String(row.occupancyRate)),
    [t("Listings", "Anuncios")]: row.activeListings,
  }));

  const latestRow = data?.[data.length - 1];

  return (
    <PageWrapper>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t("Rental Market", "Mercado de Renta")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {lang === "es" ? "Análisis de rentas a corto plazo de " : "Short-term rental analytics from "}
            <a
              href="https://www.airbnb.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              Airbnb <ExternalLink className="w-3 h-3" />
            </a>
            {" "}{lang === "es" ? "y" : "and"}{" "}
            <a
              href="https://www.vrbo.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              VRBO <ExternalLink className="w-3 h-3" />
            </a>.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={neighborhood}
            onChange={(e) => setNeighborhood(e.target.value)}
            className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary max-w-[280px]"
          >
            {NEIGHBORHOODS.map((n) => (
              <option key={n.value} value={n.value}>{n.label}</option>
            ))}
          </select>
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
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-[300px] w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">{t("Failed to load data.", "Error al cargar datos.")}</div>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-8">

          {/* Summary KPI strip */}
          {latestRow && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: t("Avg Nightly Rate", "Tarifa Noche Prom."), value: formatCurrency(latestRow.avgNightlyRateUsd), sub: t("latest month", "último mes") },
                { label: t("Occupancy Rate", "Tasa de Ocupación"), value: formatPercent(latestRow.occupancyRate), sub: t("latest month", "último mes") },
                { label: t("Active Listings", "Anuncios Activos"), value: formatNumber(latestRow.activeListings), sub: t("latest month", "último mes") },
                { label: t("Avg Review Score", "Puntuación Promedio"), value: latestRow.avgReviewScore ? `${latestRow.avgReviewScore} / 5` : "—", sub: t("latest month", "último mes") },
              ].map((kpi) => (
                <Card key={kpi.label} className="glass-card">
                  <CardContent className="pt-5">
                    <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">{kpi.label}</div>
                    <div className="text-2xl font-bold text-primary mt-1">{kpi.value}</div>
                    <div className="text-xs text-muted-foreground mt-1">{kpi.sub}</div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {/* Nightly rate trend */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="font-display">{t("Nightly Rate Trend", "Tendencia de Tarifa Noche")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v) => `$${v}`}
                    domain={[
                      (min: number) => Math.floor(min * 0.88),
                      (max: number) => Math.ceil(max * 1.06),
                    ]}
                  />
                  <Tooltip {...CHART_TOOLTIP} formatter={(v: number, name: string) => [`$${Number(v).toLocaleString()}`, name]} />
                  <Legend />
                  <Line type="monotone" dataKey={t("Avg Rate", "Tarifa Prom.")} stroke="#00C2A8" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey={t("Median Rate", "Tarifa Mediana")} stroke="#00D1FF" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Occupancy + listings */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="font-display">{t("Occupancy Rate", "Tasa de Ocupación")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis
                      unit="%"
                      tick={{ fontSize: 12 }}
                      domain={[
                        (min: number) => Math.max(0, Math.floor(min - 10)),
                        100,
                      ]}
                    />
                    <Tooltip {...CHART_TOOLTIP} cursor={TOOLTIP_CURSOR} formatter={(v: number, name: string) => [`${v}%`, name]} />
                    <Bar dataKey={t("Occupancy %", "Ocupación %")} fill="#F59E0B" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="font-display">{t("Active Listings", "Anuncios Activos")}</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 12 }} />
                    <Tooltip {...CHART_TOOLTIP} cursor={TOOLTIP_CURSOR} formatter={(v: number, name: string) => [formatNumber(v), name]} />
                    <Bar dataKey={t("Listings", "Anuncios")} fill="#6366F1" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          {/* Detail table */}
          <Card className="glass-card overflow-hidden">
            <CardHeader>
              <CardTitle className="font-display">{t("Monthly Breakdown", "Detalle Mensual")}</CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
                  <tr>
                    <th className="px-6 py-4">{t("Month", "Mes")}</th>
                    <th className="px-6 py-4">{t("Listings", "Anuncios")}</th>
                    <th className="px-6 py-4">{t("Avg Rate", "Tarifa Prom.")}</th>
                    <th className="px-6 py-4">{t("Median Rate", "Tarifa Mediana")}</th>
                    <th className="px-6 py-4">{t("Occupancy", "Ocupación")}</th>
                    <th className="px-6 py-4">{t("Avg Score", "Puntuación")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-6 py-4 font-medium">{row.monthName}</td>
                      <td className="px-6 py-4">{formatNumber(row.activeListings)}</td>
                      <td className="px-6 py-4 font-semibold text-primary">{formatCurrency(row.avgNightlyRateUsd)}</td>
                      <td className="px-6 py-4">{row.medianNightlyRateUsd ? formatCurrency(row.medianNightlyRateUsd) : "—"}</td>
                      <td className="px-6 py-4">{formatPercent(row.occupancyRate)}</td>
                      <td className="px-6 py-4">{row.avgReviewScore ? `${row.avgReviewScore} ★` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t("No data available for these filters.", "No hay datos disponibles para estos filtros.")}
        </div>
      )}
    </PageWrapper>
  );
}
