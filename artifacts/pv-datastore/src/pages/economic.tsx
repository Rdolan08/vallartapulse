import { useState } from "react";
import { useGetEconomicMetrics } from "@workspace/api-client-react";
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
  LineChart,
  Line,
  Legend,
} from "recharts";
import { formatNumber } from "@/lib/utils";
import { ExternalLink } from "lucide-react";

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = Array.from({ length: CURRENT_YEAR - 2019 }, (_, i) => CURRENT_YEAR - i);

const INDICATOR_LABELS: Record<string, { en: string; es: string; short: string }> = {
  tourism_gdp_contribution_mxn: {
    en: "Tourism GDP Contribution",
    es: "Contribución del Turismo al PIB",
    short: "Tourism GDP",
  },
  total_employment: {
    en: "Total Tourism Employment",
    es: "Empleo Total en Turismo",
    short: "Employment",
  },
  avg_monthly_wage_mxn: {
    en: "Average Monthly Wage",
    es: "Salario Mensual Promedio",
    short: "Avg Wage",
  },
  hotel_investment_mxn: {
    en: "Hotel Investment",
    es: "Inversión Hotelera",
    short: "Hotel Inv.",
  },
  real_estate_transactions: {
    en: "Real Estate Transactions",
    es: "Transacciones Inmobiliarias",
    short: "RE Transactions",
  },
};

const COLORS = ["#6366f1", "#10b981", "#f59e0b", "#ef4444", "#3b82f6"];

function kpiLabel(indicator: string, lang: string): string {
  const entry = INDICATOR_LABELS[indicator];
  if (!entry) return indicator;
  return lang === "es" ? entry.es : entry.en;
}

function formatValue(value: number, unit: string): string {
  if (unit === "MXN millions") return `$${formatNumber(value)}M`;
  if (unit === "MXN") return `$${formatNumber(value)}`;
  if (unit === "workers" || unit === "transactions") return formatNumber(value);
  return formatNumber(value);
}

export default function Economic() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(CURRENT_YEAR);

  const { data, isLoading, error } = useGetEconomicMetrics({ year });

  // For trend chart: fetch all years
  const { data: allData } = useGetEconomicMetrics({});

  const trendData = (() => {
    if (!allData) return [];
    const byYear: Record<number, Record<string, number>> = {};
    for (const row of allData) {
      if (!byYear[row.year]) byYear[row.year] = { year: row.year };
      byYear[row.year][row.indicator] = row.value;
    }
    return Object.values(byYear).sort((a, b) => (a.year as number) - (b.year as number));
  })();

  return (
    <PageWrapper>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t("Economic Indicators", "Indicadores Económicos")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {lang === "es" ? "Datos macroeconómicos de " : "Macroeconomic health data from "}
            <a
              href="https://www.economia.gob.mx/datamexico/es/profile/geo/puerto-vallarta"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              Data México <ExternalLink className="w-3 h-3" />
            </a>
            {" "}{lang === "es" ? "e" : "and"}{" "}
            <a
              href="https://www.inegi.org.mx/app/areasgeograficas?ag=14067"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline inline-flex items-center gap-0.5"
            >
              INEGI <ExternalLink className="w-3 h-3" />
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
              {y}
            </option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {[...Array(5)].map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-72 w-full rounded-2xl" />
          <Skeleton className="h-72 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium mb-2">
            {t("Unable to load economic data", "No se pudieron cargar los datos económicos")}
          </div>
          <p className="text-sm text-muted-foreground/60">
            /api/metrics/economic?year={year}
          </p>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-6">
          {/* KPI Cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {data.map((metric, idx) => (
              <Card key={metric.id} className="glass-card border-0">
                <CardContent className="pt-5 pb-4 px-4">
                  <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 leading-tight">
                    {kpiLabel(metric.indicator, lang)}
                  </div>
                  <div
                    className="text-2xl font-bold mb-1"
                    style={{ color: COLORS[idx % COLORS.length] }}
                  >
                    {formatValue(metric.value, metric.unit)}
                  </div>
                  <div className="text-xs text-muted-foreground/70">{metric.unit}</div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Bar Chart — selected year snapshot */}
          <Card className="glass-card border-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold">
                {t(`${year} Snapshot by Indicator`, `Resumen ${year} por Indicador`)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart
                  data={data.map((m) => ({
                    name:
                      INDICATOR_LABELS[m.indicator]?.short ||
                      m.indicator,
                    value: m.value,
                    unit: m.unit,
                  }))}
                  margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    stroke="transparent"
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(v) =>
                      v >= 1_000_000
                        ? `${(v / 1_000_000).toFixed(1)}M`
                        : v >= 1_000
                        ? `${(v / 1_000).toFixed(0)}k`
                        : String(v)
                    }
                    stroke="transparent"
                    width={48}
                  />
                  <Tooltip
                    formatter={(value: number, _name: string, props: any) =>
                      [formatValue(value, props.payload.unit), t("Value", "Valor")]
                    }
                    contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 4px 24px rgba(0,0,0,0.10)" }}
                  />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#6366f1" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Line Chart — tourism GDP trend over all years */}
          {trendData.length > 0 && (
            <Card className="glass-card border-0">
              <CardHeader className="pb-2">
                <CardTitle className="text-base font-semibold">
                  {t(
                    "Tourism GDP Contribution & Employment Trend",
                    "Tendencia del PIB Turístico y Empleo"
                  )}
                </CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t("Data México / INEGI — 2020–present", "Data México / INEGI — 2020–presente")}
                </p>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart
                    data={trendData}
                    margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,0,0,0.06)" />
                    <XAxis
                      dataKey="year"
                      tick={{ fontSize: 11 }}
                      stroke="transparent"
                    />
                    <YAxis
                      yAxisId="gdp"
                      orientation="left"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `$${(v / 1000).toFixed(0)}B`}
                      stroke="transparent"
                      width={52}
                    />
                    <YAxis
                      yAxisId="emp"
                      orientation="right"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`}
                      stroke="transparent"
                      width={40}
                    />
                    <Tooltip
                      formatter={(value: number, name: string) => {
                        if (name === "tourism_gdp_contribution_mxn")
                          return [`$${formatNumber(value)}M MXN`, t("Tourism GDP", "PIB Turístico")];
                        if (name === "total_employment")
                          return [formatNumber(value), t("Employment", "Empleo")];
                        return [value, name];
                      }}
                      contentStyle={{ borderRadius: "12px", border: "none", boxShadow: "0 4px 24px rgba(0,0,0,0.10)" }}
                    />
                    <Legend
                      formatter={(value: string) => {
                        if (value === "tourism_gdp_contribution_mxn")
                          return t("Tourism GDP (MXN M)", "PIB Turístico (MXN M)");
                        if (value === "total_employment")
                          return t("Employment", "Empleo");
                        return value;
                      }}
                    />
                    <Line
                      yAxisId="gdp"
                      type="monotone"
                      dataKey="tourism_gdp_contribution_mxn"
                      stroke="#6366f1"
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                      activeDot={{ r: 6 }}
                    />
                    <Line
                      yAxisId="emp"
                      type="monotone"
                      dataKey="total_employment"
                      stroke="#10b981"
                      strokeWidth={2.5}
                      dot={{ r: 4 }}
                      activeDot={{ r: 6 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}

          {/* Detail table */}
          <Card className="glass-card border-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-base font-semibold">
                {t(`${year} Indicator Detail`, `Detalle de Indicadores ${year}`)}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/50">
                      <th className="text-left py-2 pr-4 font-semibold text-muted-foreground">
                        {t("Indicator", "Indicador")}
                      </th>
                      <th className="text-right py-2 pr-4 font-semibold text-muted-foreground">
                        {t("Value", "Valor")}
                      </th>
                      <th className="text-left py-2 font-semibold text-muted-foreground">
                        {t("Unit", "Unidad")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((metric) => (
                      <tr
                        key={metric.id}
                        className="border-b border-border/30 hover:bg-secondary/20 transition-colors"
                      >
                        <td className="py-2.5 pr-4 font-medium">
                          {lang === "es" && metric.descriptionEs
                            ? metric.descriptionEs
                            : kpiLabel(metric.indicator, lang)}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono text-foreground">
                          {metric.value.toLocaleString()}
                        </td>
                        <td className="py-2.5 text-muted-foreground">{metric.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground/60 mt-3">
                {t("Source:", "Fuente:")} {data[0]?.source}
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t("No data available for this year.", "No hay datos disponibles para este año.")}
        </div>
      )}
    </PageWrapper>
  );
}
