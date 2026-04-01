import { useState } from "react";
import { useGetTourismMetrics } from "@workspace/api-client-react";
import { MONTHLY_DATA_YEARS, LAST_COMPLETED_YEAR, yearLabel } from "@/lib/data-availability";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { formatNumber, formatPercent } from "@/lib/utils";
import { Building2, Plane, Ship, Users } from "lucide-react";

const YEARS = [...MONTHLY_DATA_YEARS].reverse();

export default function Tourism() {
  const { t } = useLanguage();
  const [year, setYear] = useState<number>(LAST_COMPLETED_YEAR);

  const { data, isLoading, error } = useGetTourismMetrics({ year });

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
            {t(
              "Arrivals, cruise visitors, and occupancy data from DATATUR.",
              "Llegadas, visitantes de cruceros y ocupación de DATATUR."
            )}
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
              <CardTitle>
                {t("Cruise Visitors by Month", "Visitantes de Cruceros por Mes")}
              </CardTitle>
              <p className="text-xs text-muted-foreground">DATATUR / SECTUR</p>
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
