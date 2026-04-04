import { useState } from "react";
import { Link } from "wouter";
import {
  useGetDashboardSummary,
  useGetTourismMetrics,
  useGetRentalMarketMetrics,
} from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { StatCard } from "@/components/stat-card";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import {
  Building2,
  ChevronRight,
  Home,
  Plane,
  ShieldAlert,
  ThermometerSun,
  Thermometer,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import {
  CURRENT_YEAR,
  LAST_COMPLETED_MONTH,
  LAST_COMPLETED_YEAR,
  MONTHLY_DATA_YEARS,
  MONTH_NAMES,
  MONTH_SHORT,
  availableMonths,
  clampMonth,
  yearLabel,
} from "@/lib/data-availability";

const YEARS = MONTHLY_DATA_YEARS.slice().reverse();

function cToF(c: number) {
  return Math.round((c * 9) / 5 + 32);
}

function fmtTemp(c: number, unit: "C" | "F") {
  return unit === "F" ? `${cToF(c)}°F` : `${c.toFixed(1)}°C`;
}

export default function Dashboard() {
  const { t } = useLanguage();

  const [year, setYear] = useState<number>(LAST_COMPLETED_YEAR);
  const [month, setMonth] = useState<number>(LAST_COMPLETED_MONTH);
  const [tempUnit, setTempUnit] = useState<"C" | "F">("F");

  const { data, isLoading, error } = useGetDashboardSummary({ year, month });

  // Real chart data for the selected year
  const { data: tourismYear } = useGetTourismMetrics({ year });
  const { data: rentalYear } = useGetRentalMarketMetrics({ year });

  // Build occupancy trend for selected year
  const occupancyTrend = (tourismYear ?? [])
    .sort((a, b) => a.month - b.month)
    .map((row) => ({
      month: MONTH_SHORT[row.month - 1],
      occupancy: Number(row.hotelOccupancyRate.toFixed(1)),
      arrivals: row.totalArrivals,
    }));

  // Build avg nightly rate trend: average across neighborhoods per month
  const rateByMonth: Record<number, { sum: number; count: number }> = {};
  for (const row of rentalYear ?? []) {
    if (!rateByMonth[row.month]) rateByMonth[row.month] = { sum: 0, count: 0 };
    rateByMonth[row.month].sum += row.avgNightlyRateUsd;
    rateByMonth[row.month].count += 1;
  }
  const rateTrend = Object.entries(rateByMonth)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([m, v]) => ({
      month: MONTH_SHORT[Number(m) - 1],
      rate: Math.round(v.sum / v.count),
    }));

  const selectedMonthName = MONTH_NAMES[month - 1];

  return (
    <PageWrapper>
      {/* Header + Filters */}
      <div className="flex flex-col gap-5 mb-8">
        <div className="flex flex-col gap-4">

          {/* Hero signal pills */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest"
              style={{
                background: "rgba(0,194,168,0.12)",
                border: "1px solid rgba(0,194,168,0.3)",
                color: "#00C2A8",
              }}
            >
              <Zap className="w-3 h-3 fill-current" />
              {t("Peak Season Active", "Temporada Alta Activa")}
            </span>
            <span
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold"
              style={{
                background: "rgba(0,209,255,0.08)",
                border: "1px solid rgba(0,209,255,0.2)",
                color: "#00D1FF",
              }}
            >
              <TrendingUp className="w-3 h-3" />
              {t("Market Momentum: Positive", "Impulso del Mercado: Positivo")}
            </span>
          </div>

          {/* Page title + subtitle */}
          <div>
            <h1
              className="font-bold tracking-tight"
              style={{ fontSize: "clamp(2rem, 4vw, 2.75rem)", color: "#F5F7FA", lineHeight: 1.1 }}
            >
              {t("Platform Overview", "Resumen de la Plataforma")}
            </h1>
            <p style={{ color: "#9AA5B1", fontSize: "15px", maxWidth: "52ch", marginTop: "8px" }}>
              {t(
                "Key performance indicators for Puerto Vallarta real estate and tourism.",
                "Indicadores clave para bienes raíces y turismo en Puerto Vallarta."
              )}
            </p>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Year */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t("Year", "Año")}
            </span>
            <select
              value={year}
              onChange={(e) => {
                const y = Number(e.target.value);
                setYear(y);
                setMonth((prev) => clampMonth(y, prev));
              }}
              className="glass-panel px-3 py-1.5 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {YEARS.map((y) => (
                <option key={y} value={y}>{yearLabel(y)}</option>
              ))}
            </select>
          </div>

          {/* Month — only show available months for the selected year */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              {t("Month", "Mes")}
            </span>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="glass-panel px-3 py-1.5 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {availableMonths(year).map((m) => (
                <option key={m} value={m}>{MONTH_NAMES[m - 1]}</option>
              ))}
            </select>
          </div>

          {/* °C / °F toggle */}
          <div className="flex items-center gap-1 glass-panel rounded-xl px-1 py-1">
            <button
              onClick={() => setTempUnit("C")}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-sm font-semibold transition-all ${
                tempUnit === "C"
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Thermometer className="w-3.5 h-3.5" />
              °C
            </button>
            <button
              onClick={() => setTempUnit("F")}
              className={`flex items-center gap-1 px-3 py-1 rounded-lg text-sm font-semibold transition-all ${
                tempUnit === "F"
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <ThermometerSun className="w-3.5 h-3.5" />
              °F
            </button>
          </div>

          {/* Context label */}
          <span className="text-xs text-muted-foreground/70 italic ml-1">
            {t(
              `Showing data for ${selectedMonthName} ${year}`,
              `Mostrando datos de ${selectedMonthName} ${year}`
            )}
          </span>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            {Array.from({ length: 7 }).map((_, i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Skeleton className="h-72 rounded-2xl" />
            <Skeleton className="h-72 rounded-2xl" />
          </div>
        </div>
      ) : error ? (
        <div className="p-8 text-center bg-destructive/10 text-destructive rounded-2xl border border-destructive/20">
          <p className="font-semibold">
            {t("Failed to load dashboard data.", "Error al cargar datos del tablero.")}
          </p>
        </div>
      ) : data ? (
        <div className="space-y-8">
          {/* KPI Cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <StatCard
              titleEn="Hotel Occupancy"
              titleEs="Ocupación Hotelera"
              value={formatPercent(data.hotelOccupancyRate)}
              change={data.hotelOccupancyChange}
              icon={<Building2 className="text-primary" />}
              trend="up_good"
              href="/tourism"
            />
            <StatCard
              titleEn="Avg Nightly Rate"
              titleEs="Tarifa Promedio por Noche"
              value={formatCurrency(data.avgNightlyRate)}
              change={data.avgNightlyRateChange}
              icon={<Home className="text-accent" />}
              trend="up_good"
              href="/rental-market"
            />
            <StatCard
              titleEn="Active Listings"
              titleEs="Anuncios Activos"
              value={formatNumber(data.activeListings)}
              change={data.activeListingsChange}
              icon={<Home className="text-emerald-500" />}
              trend="up_good"
              href="/rental-market"
            />
            <StatCard
              titleEn="Tourist Arrivals"
              titleEs="Llegada de Turistas"
              value={formatNumber(data.touristArrivals)}
              change={data.touristArrivalsChange}
              icon={<Plane className="text-blue-500" />}
              trend="up_good"
              href="/tourism"
            />
            <StatCard
              titleEn="Avg Temperature"
              titleEs="Temperatura Promedio"
              value={fmtTemp(data.avgTemperatureC, tempUnit)}
              icon={<ThermometerSun className="text-amber-500" />}
              trend="neutral"
              href="/weather"
            />
            <StatCard
              titleEn="Crime Index"
              titleEs="Índice de Criminalidad"
              value={`${data.crimeIndex.toFixed(1)} / 100`}
              change={data.crimeIndexChange}
              changeLabelEn="vs last year · lower is safer"
              changeLabelEs="vs año anterior · menor es más seguro"
              icon={<ShieldAlert className="text-rose-500" />}
              trend="down_good"
              href="/safety"
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Occupancy trend for selected year */}
            <Card className="glass-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="font-display">
                    {t(`Hotel Occupancy — ${year} (%)`, `Ocupación Hotelera — ${year} (%)`)}
                  </CardTitle>
                  <Link
                    href="/tourism"
                    className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-accent transition-colors"
                  >
                    {t("View all", "Ver todo")} <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
                <p className="text-xs text-muted-foreground">DATATUR / SECTUR</p>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={occupancyTrend}
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="colorOcc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(199 89% 48%)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(199 89% 48%)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="month"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                      dy={10}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                      tickFormatter={(v) => `${v}%`}
                      domain={[40, 100]}
                    />
                    <RechartsTooltip
                      contentStyle={{
                        borderRadius: "12px",
                        border: "none",
                        boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
                      }}
                      formatter={(val: number, name: string) => [
                        `${val.toFixed(1)}%`,
                        t("Occupancy", "Ocupación"),
                      ]}
                      labelFormatter={(label) => label}
                    />
                    <Area
                      type="monotone"
                      dataKey="occupancy"
                      name={t("Occupancy %", "Ocupación %")}
                      stroke="hsl(199 89% 48%)"
                      strokeWidth={3}
                      fillOpacity={1}
                      fill="url(#colorOcc)"
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Avg nightly rate trend */}
            <Card className="glass-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="font-display">
                    {t(
                      `Avg Nightly Rate — ${year} (USD)`,
                      `Tarifa Promedio por Noche — ${year} (USD)`
                    )}
                  </CardTitle>
                  <Link
                    href="/rental-market"
                    className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-accent transition-colors"
                  >
                    {t("View all", "Ver todo")} <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
                <p className="text-xs text-muted-foreground">Airbnb / VRBO</p>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart
                    data={rateTrend}
                    margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(12 76% 61%)" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(12 76% 61%)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="month"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                      dy={10}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                      tickFormatter={(v) => `$${v.toLocaleString()}`}
                      domain={[
                        (min: number) => Math.floor(min * 0.88),
                        (max: number) => Math.ceil(max * 1.06),
                      ]}
                    />
                    <RechartsTooltip
                      contentStyle={{
                        borderRadius: "12px",
                        border: "none",
                        boxShadow: "0 10px 25px -5px rgba(0,0,0,0.1)",
                      }}
                      formatter={(val: number) => [
                        `$${val.toLocaleString()}`,
                        t("Avg Nightly Rate", "Tarifa Promedio por Noche"),
                      ]}
                    />
                    <Area
                      type="monotone"
                      dataKey="rate"
                      stroke="hsl(12 76% 61%)"
                      strokeWidth={3}
                      fillOpacity={1}
                      fill="url(#colorRate)"
                      dot={{ r: 3 }}
                      activeDot={{ r: 5 }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </PageWrapper>
  );
}
