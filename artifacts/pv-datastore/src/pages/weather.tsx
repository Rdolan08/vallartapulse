import { useState } from "react";
import { useGetWeatherMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ThermometerSun, Droplets, ExternalLink, Sun, Waves, Wind } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, BarChart, Bar,
} from "recharts";

import { MONTHLY_DATA_YEARS, LAST_COMPLETED_YEAR, yearLabel } from "@/lib/data-availability";
import { CHART_TOOLTIP, TOOLTIP_CURSOR } from "@/lib/chart-theme";

const WEATHER_YEARS = [2020, 2021, ...MONTHLY_DATA_YEARS].filter((v, i, a) => a.indexOf(v) === i).reverse();

function toF(c: number) { return Math.round((c * 9/5 + 32) * 10) / 10; }
function toIn(mm: number) { return Math.round((mm / 25.4) * 100) / 100; }

export default function Weather() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(LAST_COMPLETED_YEAR);
  const [unit, setUnit] = useState<"metric" | "imperial">("imperial");

  const { data, isLoading, error } = useGetWeatherMetrics({ year });

  const tempLabel = unit === "metric" ? "°C" : "°F";
  const precipLabel = unit === "metric" ? "mm" : "in";

  function displayTemp(c: number | undefined | null) {
    if (c == null) return "-";
    return unit === "metric" ? `${c}${tempLabel}` : `${toF(c)}${tempLabel}`;
  }
  function displayPrecip(mm: number | undefined | null) {
    if (mm == null) return "-";
    return unit === "metric" ? `${mm}${precipLabel}` : `${toIn(mm)}${precipLabel}`;
  }

  const chartData = data?.map((m) => {
    const avgTempC = parseFloat(String(m.avgTempC));
    const avgSeaTempC = m.avgSeaTempC != null ? parseFloat(String(m.avgSeaTempC)) : null;
    const precipMm = parseFloat(String(m.precipitationMm));
    return {
      name: m.monthName.slice(0, 3),
      [t("Avg Temp", "Temp. Prom")]: unit === "metric" ? avgTempC : toF(avgTempC),
      [t("Sea Temp", "Temp. Mar")]: avgSeaTempC != null ? (unit === "metric" ? avgSeaTempC : toF(avgSeaTempC)) : null,
      [t("Rainfall", "Lluvia")]: unit === "metric" ? precipMm : toIn(precipMm),
      [t("Rainy Days", "Días de Lluvia")]: m.rainyDays ?? null,
    };
  });

  return (
    <PageWrapper>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t("Weather & Climate", "Clima y Tiempo")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {lang === "es" ? "Datos climáticos históricos y estacionales de " : "Historical and seasonal climate data from "}
            <a
              href="https://www.ncei.noaa.gov/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              NOAA <ExternalLink className="w-3 h-3" />
            </a>
            {" / "}
            <a
              href="https://smn.conagua.gob.mx/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              CONAGUA <ExternalLink className="w-3 h-3" />
            </a>.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Unit toggle */}
          <div className="flex rounded-xl overflow-hidden border border-border text-sm font-semibold">
            <button
              onClick={() => setUnit("metric")}
              className={`px-3 py-2 transition-colors ${unit === "metric" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
            >
              °C / mm
            </button>
            <button
              onClick={() => setUnit("imperial")}
              className={`px-3 py-2 transition-colors ${unit === "imperial" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:bg-muted"}`}
            >
              °F / in
            </button>
          </div>
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {WEATHER_YEARS.map((y) => (
              <option key={y} value={y}>{yearLabel(y)}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <Skeleton className="h-[300px] w-full rounded-2xl" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-2xl" />)}
          </div>
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">{t("Failed to load data.", "Error al cargar datos.")}</div>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-8">

          {/* Temperature Chart */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="font-display">{t("Temperature Trends", "Tendencias de Temperatura")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis
                    unit={tempLabel}
                    tick={{ fontSize: 12 }}
                    domain={[
                      (min: number) => Math.floor(min - (unit === "metric" ? 3 : 6)),
                      (max: number) => Math.ceil(max  + (unit === "metric" ? 2 : 4)),
                    ]}
                  />
                  <Tooltip {...CHART_TOOLTIP} formatter={(v: number, name: string) => [`${v}${tempLabel}`, name]} />
                  <Legend />
                  <Line type="monotone" dataKey={t("Avg Temp", "Temp. Prom")} stroke="#00C2A8" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey={t("Sea Temp", "Temp. Mar")} stroke="#00D1FF" strokeWidth={2} dot={false} strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Rainfall Chart */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="font-display">{t("Monthly Rainfall", "Lluvia Mensual")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis unit={precipLabel} tick={{ fontSize: 12 }} />
                  <Tooltip {...CHART_TOOLTIP} cursor={TOOLTIP_CURSOR} formatter={(v: number, name: string) => [`${v}${precipLabel}`, name]} />
                  <Bar dataKey={t("Rainfall", "Lluvia")} fill="#3B82F6" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Monthly cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {data.map((month) => (
              <Card key={month.id} className="glass-card">
                <CardHeader className="pb-3">
                  <CardTitle className="text-xl font-display text-primary">{month.monthName}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-y-5 gap-x-4">
                    <div className="flex items-start gap-3">
                      <ThermometerSun className="w-5 h-5 text-amber-500 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-muted-foreground">{t("Avg Temp", "Temp. Prom.")}</div>
                        <div className="text-base font-bold">{displayTemp(month.avgTempC)}</div>
                        {month.minTempC != null && month.maxTempC != null && (
                          <div className="text-xs text-muted-foreground">{displayTemp(month.minTempC)} – {displayTemp(month.maxTempC)}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Droplets className="w-5 h-5 text-blue-500 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-muted-foreground">{t("Rainfall", "Lluvia")}</div>
                        <div className="text-base font-bold">{displayPrecip(month.precipitationMm)}</div>
                        {month.rainyDays != null && (
                          <div className="text-xs text-muted-foreground">{month.rainyDays} {t("rainy days", "días con lluvia")}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Sun className="w-5 h-5 text-yellow-500 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-muted-foreground">{t("Sunshine", "Horas de sol")}</div>
                        <div className="text-base font-bold">{month.sunshineHours != null ? `${month.sunshineHours}h` : "-"}</div>
                        {month.avgHumidityPct != null && (
                          <div className="text-xs text-muted-foreground">{month.avgHumidityPct}% {t("humidity", "humedad")}</div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Waves className="w-5 h-5 text-cyan-500 mt-0.5" />
                      <div>
                        <div className="text-xs font-medium text-muted-foreground">{t("Sea Temp", "Temp. Mar")}</div>
                        <div className="text-base font-bold">{displayTemp(month.avgSeaTempC ?? null)}</div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t("No data available for this year.", "No hay datos disponibles para este año.")}
        </div>
      )}
    </PageWrapper>
  );
}
