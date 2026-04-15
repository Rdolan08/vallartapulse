import { useState } from "react";
import { Link } from "wouter";
import {
  useGetDashboardSummary,
  useGetAirportMetrics,
  useGetRentalMarketMetrics,
} from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { StatCard } from "@/components/stat-card";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import {
  ArrowRight,
  Building2,
  ChevronRight,
  DollarSign,
  Home,
  Plane,
  ShieldAlert,
  Sparkles,
  ThermometerSun,
  Thermometer,
  TrendingUp,
  Zap,
} from "lucide-react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_TOOLTIP, TOOLTIP_CURSOR } from "@/lib/chart-theme";

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
  const { data: airportYear } = useGetAirportMetrics({ year });
  const { data: rentalYear } = useGetRentalMarketMetrics({ year });

  // Build airport passengers trend — official GAP bars (teal) + estimate bars (amber)
  const airportTrend = (airportYear ?? [])
    .sort((a, b) => a.month - b.month)
    .map((row) => ({
      month: MONTH_SHORT[row.month - 1],
      passengers: row.totalPassengers,
      isEstimate: row.source.toLowerCase().includes("est"),
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

  // Peak season: Nov–Apr (months 11,12,1,2,3,4)
  const isPeakSeason = [11, 12, 1, 2, 3, 4].includes(month);

  // Market momentum: weighted composite of YoY changes from the API
  // Only compute once data is loaded; fall back to null while loading
  const momentum: "positive" | "mixed" | "pressure" | null = (() => {
    if (!data) return null;
    // hotel occupancy change is in percentage points; convert to % change for comparability
    const occupancyPct = data.hotelOccupancyChange;
    const arrivalsPct  = data.touristArrivalsChange;
    const ratePct      = data.avgNightlyRateChange;
    // Weighted score: demand signals carry more weight than rate
    const score = (occupancyPct * 0.35) + (arrivalsPct * 0.45) + (ratePct * 0.20);
    if (score >= 2)   return "positive";
    if (score >= -5)  return "mixed";
    return "pressure";
  })();

  const momentumLabel = {
    positive: { en: "Market Momentum: Positive", es: "Impulso del Mercado: Positivo" },
    mixed:    { en: "Market Momentum: Mixed",    es: "Impulso del Mercado: Mixto" },
    pressure: { en: "Market Momentum: Slowing",  es: "Impulso del Mercado: A la Baja" },
  };

  const momentumStyle: Record<string, { bg: string; border: string; color: string }> = {
    positive: { bg: "rgba(0,209,255,0.08)",   border: "rgba(0,209,255,0.2)",   color: "#00D1FF" },
    mixed:    { bg: "rgba(245,158,11,0.10)",  border: "rgba(245,158,11,0.25)", color: "#F59E0B" },
    pressure: { bg: "rgba(248,113,113,0.10)", border: "rgba(248,113,113,0.25)",color: "#F87171" },
  };

  return (
    <PageWrapper>
      {/* ── Pricing Tool CTA — always visible at top ─────────────────── */}
      <Link href="/pricing-tool" className="block">
        <div
          className="relative overflow-hidden rounded-2xl cursor-pointer group"
          style={{
            background: "linear-gradient(135deg, rgba(0,194,168,0.14) 0%, rgba(99,102,241,0.14) 55%, rgba(0,209,255,0.10) 100%)",
            border: "1px solid rgba(0,194,168,0.28)",
          }}
        >
          {/* Glow orb */}
          <div
            className="absolute -top-16 -right-16 w-64 h-64 rounded-full pointer-events-none"
            style={{ background: "radial-gradient(circle, rgba(99,102,241,0.18) 0%, transparent 70%)" }}
          />

          <div className="relative flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6 p-7">

            {/* Left — copy */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-3">
                <span
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-widest"
                  style={{ background: "rgba(99,102,241,0.18)", border: "1px solid rgba(99,102,241,0.35)", color: "#818CF8" }}
                >
                  <Sparkles className="w-3 h-3" />
                  {t("New Tool", "Nueva Herramienta")}
                </span>
              </div>

              <h2
                className="font-bold tracking-tight mb-2"
                style={{ fontSize: "clamp(1.25rem, 2.5vw, 1.65rem)", color: "#F5F7FA", lineHeight: 1.2 }}
              >
                {t(
                  "Stop guessing. Price your rental with real market data.",
                  "Deja de adivinar. Ponle precio a tu renta con datos reales."
                )}
              </h2>
              <p style={{ color: "#9AA5B1", fontSize: "14px", maxWidth: "52ch", lineHeight: 1.6 }}>
                {t(
                  "Enter your property details and get a data-backed nightly rate — conservative, recommended, and stretch — calibrated to your neighborhood, building, amenities, and the month.",
                  "Ingresa los detalles de tu propiedad y obtén una tarifa nocturna respaldada por datos — conservadora, recomendada y de estiramiento — calibrada a tu colonia, edificio, amenidades y mes."
                )}
              </p>

              <div className="flex flex-wrap gap-4 mt-4">
                {[
                  { icon: <Building2 className="w-3.5 h-3.5" />, en: "16 PV neighborhoods", es: "16 colonias de PV" },
                  { icon: <TrendingUp className="w-3.5 h-3.5" />, en: "Live Airbnb & VRBO comps", es: "Comparables en vivo" },
                  { icon: <DollarSign className="w-3.5 h-3.5" />, en: "Seasonal multipliers", es: "Multiplicadores estacionales" },
                ].map(({ icon, en, es }) => (
                  <span
                    key={en}
                    className="flex items-center gap-1.5 text-xs font-semibold"
                    style={{ color: "#00C2A8" }}
                  >
                    {icon}
                    {t(en, es)}
                  </span>
                ))}
              </div>
            </div>

            {/* Right — mini price output mockup */}
            <div className="flex-shrink-0 w-full lg:w-auto">
              <div
                className="rounded-xl p-5 min-w-[220px]"
                style={{ background: "rgba(10,30,39,0.7)", border: "1px solid rgba(255,255,255,0.07)" }}
              >
                <div className="flex items-center gap-2 mb-4">
                  <div
                    className="w-7 h-7 rounded-lg flex items-center justify-center"
                    style={{ background: "rgba(0,194,168,0.15)" }}
                  >
                    <DollarSign className="w-4 h-4" style={{ color: "#00C2A8" }} />
                  </div>
                  <div>
                    <div className="text-xs font-bold uppercase tracking-widest" style={{ color: "#9AA5B1" }}>
                      {t("Sample Output", "Muestra")}
                    </div>
                    <div className="text-xs" style={{ color: "#9AA5B1" }}>
                      {t("2BR · Ocean View · March", "2 rec. · Vista al mar · Marzo")}
                    </div>
                  </div>
                </div>

                <div className="space-y-2.5">
                  {[
                    { label: t("Conservative", "Conservadora"), price: "$165", highlight: false },
                    { label: t("Recommended", "Recomendada"),  price: "$212", highlight: true  },
                    { label: t("Stretch",      "Máximo"),       price: "$268", highlight: false },
                  ].map(({ label, price, highlight }) => (
                    <div
                      key={label}
                      className="flex items-center justify-between rounded-lg px-3 py-2"
                      style={highlight
                        ? { background: "rgba(0,194,168,0.15)", border: "1px solid rgba(0,194,168,0.3)" }
                        : { background: "rgba(255,255,255,0.04)" }
                      }
                    >
                      <span className="text-xs font-semibold" style={{ color: highlight ? "#00C2A8" : "#9AA5B1" }}>
                        {label}
                      </span>
                      <span className="font-bold tabular-nums" style={{ color: highlight ? "#F5F7FA" : "#9AA5B1", fontSize: "15px" }}>
                        {price}
                        <span className="text-xs font-normal ml-1" style={{ color: "#9AA5B1" }}>/nt</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* CTA button */}
            <div
              className="hidden lg:flex flex-shrink-0 items-center gap-2 px-5 py-3 rounded-xl font-semibold text-sm transition-all group-hover:gap-3"
              style={{ background: "#00C2A8", color: "#0A1E27" }}
            >
              {t("Try It Free", "Pruébalo Gratis")}
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </div>
          </div>
        </div>
      </Link>

      {/* Header + Filters */}
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-4">

          {/* Hero signal pills */}
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest"
              style={isPeakSeason
                ? { background: "rgba(0,194,168,0.12)", border: "1px solid rgba(0,194,168,0.3)", color: "#00C2A8" }
                : { background: "rgba(148,163,184,0.10)", border: "1px solid rgba(148,163,184,0.25)", color: "#94A3B8" }
              }
            >
              <Zap className="w-3 h-3 fill-current" />
              {isPeakSeason
                ? t("Peak Season Active", "Temporada Alta Activa")
                : t("Shoulder Season", "Temporada Baja")}
            </span>
            {momentum && (() => {
              const style = momentumStyle[momentum];
              const label = momentumLabel[momentum];
              return (
                <span
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold"
                  style={{ background: style.bg, border: `1px solid ${style.border}`, color: style.color }}
                >
                  <TrendingUp className="w-3 h-3" />
                  {t(label.en, label.es)}
                </span>
              );
            })()}
          </div>

          {/* Page title + subtitle */}
          <div>
            <h1
              className="font-bold tracking-tight"
              style={{ fontSize: "clamp(2rem, 4vw, 2.75rem)", color: "#F5F7FA", lineHeight: 1.1 }}
            >
              {t("PV Market Vitals", "Indicadores del Mercado PV")}
            </h1>
            <p style={{ color: "#9AA5B1", fontSize: "15px", maxWidth: "52ch", marginTop: "8px" }}>
              {t(
                "Live tourism and rental data for Puerto Vallarta, updated monthly.",
                "Datos de turismo y renta en Puerto Vallarta, actualizados mensualmente."
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
          {/* KPI Cards — order: demand → rates → supply → risk → context */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <StatCard
              titleEn="Airport Passengers"
              titleEs="Pasajeros Aeropuerto"
              value={formatNumber(data.touristArrivals)}
              change={data.touristArrivalsChange}
              footnoteEn="PVR · GAP official data"
              footnoteEs="PVR · datos oficiales GAP"
              icon={<Plane className="text-blue-500" />}
              trend="up_good"
              href="/tourism"
            />
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
            <StatCard
              titleEn="Avg Temperature"
              titleEs="Temperatura Promedio"
              value={fmtTemp(data.avgTemperatureC, tempUnit)}
              icon={<ThermometerSun className="text-amber-500" />}
              trend="neutral"
              href="/weather"
            />
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* PVR Airport Passengers — current year */}
            <Card className="glass-card">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="font-display">
                    {t(`PVR Airport Passengers — ${year}`, `Pasajeros Aeropuerto PVR — ${year}`)}
                  </CardTitle>
                  <Link
                    href="/tourism"
                    className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-accent transition-colors"
                  >
                    {t("View all", "Ver todo")} <ChevronRight className="w-3.5 h-3.5" />
                  </Link>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(
                    "GAP official · amber bars = model estimate",
                    "GAP oficial · barras ámbar = estimación"
                  )}
                </p>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={airportTrend}
                    margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      vertical={false}
                      stroke="rgba(255,255,255,0.06)"
                    />
                    <XAxis
                      dataKey="month"
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                      dy={8}
                    />
                    <YAxis
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }}
                      tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                      width={52}
                    />
                    <RechartsTooltip
                      {...CHART_TOOLTIP}
                      cursor={TOOLTIP_CURSOR}
                      formatter={(val: number, _name: string, entry: { payload?: { isEstimate?: boolean } }) => [
                        formatNumber(val),
                        entry?.payload?.isEstimate
                          ? t("Passengers (est.)", "Pasajeros (est.)")
                          : t("Passengers", "Pasajeros"),
                      ]}
                      labelFormatter={(label) => `${label} ${year}`}
                    />
                    <Bar dataKey="passengers" radius={[3, 3, 0, 0]} maxBarSize={48}>
                      {airportTrend.map((entry, i) => (
                        <Cell
                          key={i}
                          fill={entry.isEstimate ? "#F59E0B" : "#00C2A8"}
                          fillOpacity={entry.isEstimate ? 0.75 : 1}
                        />
                      ))}
                    </Bar>
                  </BarChart>
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
                      {...CHART_TOOLTIP}
                      cursor={TOOLTIP_CURSOR}
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
