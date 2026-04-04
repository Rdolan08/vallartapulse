import { useState } from "react";
import { useGetTourismMetrics, useGetAirportMetrics } from "@workspace/api-client-react";
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
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { formatNumber, formatPercent } from "@/lib/utils";
import { Building2, ExternalLink, Plane, Ship, Users } from "lucide-react";

const MONTH_ABBR = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// Tourism SECTUR/DATATUR data only goes through 2025 — 2026 official figures not yet published
const YEARS = [...MONTHLY_DATA_YEARS].filter((y) => y <= 2025).reverse();

export default function Tourism() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(Math.min(LAST_COMPLETED_YEAR, 2025));

  const { data, isLoading, error } = useGetTourismMetrics({ year });
  const { data: airportRaw } = useGetAirportMetrics();

  // Build year-over-year airport chart data (all years, months as x-axis)
  const airportYears = airportRaw
    ? [...new Set(airportRaw.map((r) => r.year))].sort()
    : [];
  const airportChartData = MONTH_ABBR.map((abbr, idx) => {
    const month = idx + 1;
    const point: Record<string, number | string> = { month: abbr };
    for (const yr of airportYears) {
      const row = airportRaw?.find((r) => r.year === yr && r.month === month);
      if (row) point[String(yr)] = row.totalPassengers;
    }
    return point;
  });
  const airportColors: Record<number, string> = { 2024: "#6366F1", 2025: "#00C2A8", 2026: "#F59E0B" };

  // Aggregate totals for KPI row
  const totals = data?.reduce(
    (acc, row) => ({
      arrivals: acc.arrivals + (row.totalArrivals ?? 0),
      cruise: acc.cruise + (row.cruiseVisitors ?? 0),
      intl: acc.intl + (row.internationalArrivals ?? 0),
    }),
    { arrivals: 0, cruise: 0, intl: 0 }
  );

  const avgOccupancy =
    data && data.length > 0
      ? data.reduce((sum, r) => sum + r.hotelOccupancyRate, 0) / data.length
      : null;

  return (
    <PageWrapper>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t("Tourism Metrics", "Métricas Turísticas")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {lang === "es"
              ? "Llegadas, visitantes de cruceros y ocupación de "
              : "Arrivals, cruise visitors, and occupancy data from "}
            <a
              href="https://www.datatur.sectur.gob.mx/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              DATATUR <ExternalLink className="w-3 h-3" />
            </a>.
          </p>
        </div>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {YEARS.map((y) => (
            <option key={y} value={y}>
              {yearLabel(y)}
            </option>
          ))}
        </select>
      </div>

      {/* Airport passenger traffic — real GAP/GlobeNewswire scraped data, multi-year */}
      {airportRaw && airportRaw.length > 0 && (
        <Card className="glass-card mb-6">
          <CardHeader>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <CardTitle>
                  {t("PVR Airport Passenger Traffic", "Tráfico de Pasajeros Aeropuerto PVR")}
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-1">
                  {t(
                    "Year-over-year monthly comparison · 2026 data through February (official GAP press releases)",
                    "Comparativo mensual interanual · datos 2026 hasta febrero (comunicados oficiales GAP)"
                  )}
                </p>
              </div>
              <a
                href="https://www.globenewswire.com/search/organization/Grupo%20Aeroportuario%20del%20Pac%C3%ADfico"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
              >
                GAP / GlobeNewswire <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </CardHeader>
          <CardContent className="h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={airportChartData}
                margin={{ top: 10, right: 30, left: 20, bottom: 5 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="month"
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  dy={8}
                />
                <YAxis
                  axisLine={false}
                  tickLine={false}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }}
                  tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                  domain={[(min: number) => Math.floor(min * 0.92), (max: number) => Math.ceil(max * 1.04)]}
                  width={48}
                />
                <Tooltip
                  contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)" }}
                  formatter={(val: number, name: string) => [formatNumber(val), `${name} ${t("passengers", "pasajeros")}`]}
                />
                <Legend iconType="circle" wrapperStyle={{ paddingTop: "16px" }} />
                {airportYears.map((yr) => (
                  <Line
                    key={yr}
                    type="monotone"
                    dataKey={String(yr)}
                    name={String(yr)}
                    stroke={airportColors[yr] ?? "#9AA5B1"}
                    strokeWidth={yr === Math.max(...airportYears) ? 2.5 : 1.5}
                    dot={false}
                    strokeDasharray={yr === Math.max(...airportYears) ? "5 3" : undefined}
                    connectNulls={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-96 w-full rounded-2xl" />
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

          {/* KPI summary row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            {[
              {
                label: t("Total Arrivals", "Total de Llegadas"),
                value: totals ? formatNumber(totals.arrivals) : "—",
                icon: <Plane className="w-5 h-5" style={{ color: "#3B82F6" }} />,
                color: "#3B82F6",
              },
              {
                label: t("Cruise Visitors", "Visitantes de Cruceros"),
                value: totals ? formatNumber(totals.cruise) : "—",
                icon: <Ship className="w-5 h-5" style={{ color: "#6366F1" }} />,
                color: "#6366F1",
              },
              {
                label: t("International Arrivals", "Llegadas Internacionales"),
                value: totals ? formatNumber(totals.intl) : "—",
                icon: <Users className="w-5 h-5" style={{ color: "#00C2A8" }} />,
                color: "#00C2A8",
              },
              {
                label: t("Avg Hotel Occupancy", "Ocupación Hotelera Prom."),
                value: avgOccupancy != null ? formatPercent(avgOccupancy) : "—",
                icon: <Building2 className="w-5 h-5" style={{ color: "#F59E0B" }} />,
                color: "#F59E0B",
              },
            ].map(({ label, value, icon, color }) => (
              <div
                key={label}
                className="glass-card flex flex-col gap-3"
                style={{ padding: "1.25rem" }}
              >
                <div className="flex items-center gap-2">
                  {icon}
                  <span
                    className="text-xs font-semibold uppercase tracking-[0.08em]"
                    style={{ color: "#9AA5B1" }}
                  >
                    {label}
                  </span>
                </div>
                <div
                  className="text-2xl font-bold"
                  style={{ color: "#F5F7FA", letterSpacing: "-0.02em" }}
                >
                  {value}
                </div>
              </div>
            ))}
          </div>

          {/* Arrivals chart */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle>
                {t("Tourist Arrivals by Origin", "Llegada de Turistas por Origen")}
              </CardTitle>
            </CardHeader>
            <CardContent className="h-[380px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data}
                  margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--border))"
                  />
                  <XAxis
                    dataKey="monthName"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    dy={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "12px",
                      border: "none",
                      boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
                    }}
                    cursor={{ fill: "hsl(var(--muted)/0.5)" }}
                    formatter={(val: number, name: string) => [formatNumber(val), name]}
                  />
                  <Legend iconType="circle" wrapperStyle={{ paddingTop: "20px" }} />
                  <Bar
                    dataKey="internationalArrivals"
                    name={t("International", "Internacional")}
                    fill="#00C2A8"
                    radius={[4, 4, 0, 0]}
                    stackId="a"
                  />
                  <Bar
                    dataKey="domesticArrivals"
                    name={t("Domestic", "Nacional")}
                    fill="#F59E0B"
                    radius={[4, 4, 0, 0]}
                    stackId="a"
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Cruise visitors chart */}
          <Card className="glass-card">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>
                  {t("Cruise Visitors by Month", "Visitantes de Cruceros por Mes")}
                </CardTitle>
                <a
                  href="https://www.datatur.sectur.gob.mx/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
                >
                  DATATUR / SECTUR <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            </CardHeader>
            <CardContent className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={data}
                  margin={{ top: 10, right: 30, left: 20, bottom: 5 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="hsl(var(--border))"
                  />
                  <XAxis
                    dataKey="monthName"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    dy={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                    tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: "12px",
                      border: "none",
                      boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
                    }}
                    cursor={{ fill: "hsl(var(--muted)/0.5)" }}
                    formatter={(val: number) => [formatNumber(val), t("Cruise Visitors", "Visitantes de Crucero")]}
                  />
                  <Bar
                    dataKey="cruiseVisitors"
                    name={t("Cruise Visitors", "Visitantes de Crucero")}
                    fill="#6366F1"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Data table */}
          <Card className="glass-card overflow-hidden">
            <div className="flex items-center justify-between px-6 pt-5 pb-2">
              <h3 className="font-semibold text-sm uppercase tracking-wider text-muted-foreground">
                {t("Monthly Data", "Datos Mensuales")}
              </h3>
              <a
                href="https://www.datatur.sectur.gob.mx/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors"
              >
                {t("Source: DATATUR / SECTUR", "Fuente: DATATUR / SECTUR")} <ExternalLink className="w-3 h-3" />
              </a>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
                  <tr>
                    <th className="px-6 py-4">{t("Month", "Mes")}</th>
                    <th className="px-6 py-4">{t("Occupancy", "Ocupación")}</th>
                    <th className="px-6 py-4">{t("Intl Arrivals", "Llegadas Int.")}</th>
                    <th className="px-6 py-4">{t("Dom Arrivals", "Llegadas Nac.")}</th>
                    <th className="px-6 py-4">{t("Total Arrivals", "Total Llegadas")}</th>
                    <th className="px-6 py-4">{t("Cruise Visitors", "Cruceristas")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => (
                    <tr
                      key={row.id}
                      className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                    >
                      <td className="px-6 py-4 font-medium text-foreground">
                        {row.monthName}
                      </td>
                      <td className="px-6 py-4">
                        {formatPercent(row.hotelOccupancyRate)}
                      </td>
                      <td className="px-6 py-4">
                        {row.internationalArrivals
                          ? formatNumber(row.internationalArrivals)
                          : "—"}
                      </td>
                      <td className="px-6 py-4">
                        {row.domesticArrivals
                          ? formatNumber(row.domesticArrivals)
                          : "—"}
                      </td>
                      <td className="px-6 py-4 font-semibold">
                        {formatNumber(row.totalArrivals)}
                      </td>
                      <td className="px-6 py-4">
                        {row.cruiseVisitors != null
                          ? formatNumber(row.cruiseVisitors)
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground">
          {t("No data available for this year.", "No hay datos disponibles para este año.")}
        </div>
      )}
    </PageWrapper>
  );
}
