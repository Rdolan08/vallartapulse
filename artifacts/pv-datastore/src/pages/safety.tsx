import { useState, useMemo } from "react";
import { useGetSafetyMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LineChart, Line,
} from "recharts";

import { MONTHLY_DATA_YEARS, LAST_COMPLETED_YEAR, yearLabel } from "@/lib/data-availability";

const YEARS = [...MONTHLY_DATA_YEARS].reverse();

const GROUP_COLORS: Record<string, string> = {
  "Violent Crime":       "#ef4444",
  "Sexual Crime":        "#f97316",
  "Domestic & Social":   "#a855f7",
  "Property Crime":      "#3b82f6",
  "Federal / Drug Crime":"#6b7280",
};

const GROUP_ORDER = [
  "Violent Crime",
  "Sexual Crime",
  "Domestic & Social",
  "Property Crime",
  "Federal / Drug Crime",
];

const GROUPS_EN = {
  "All":                  "All Categories",
  "Violent Crime":        "Violent Crime",
  "Sexual Crime":         "Sexual Crime",
  "Domestic & Social":    "Domestic & Social",
  "Property Crime":       "Property Crime",
  "Federal / Drug Crime": "Federal / Drug Crime",
};
const GROUPS_ES: Record<string, string> = {
  "All":                  "Todas las Categorías",
  "Violent Crime":        "Delitos Violentos",
  "Sexual Crime":         "Delitos Sexuales",
  "Domestic & Social":    "Violencia Doméstica y Social",
  "Property Crime":       "Delitos Patrimoniales",
  "Federal / Drug Crime": "Delitos Federales / Narcomenudeo",
};

export default function Safety() {
  const { t, lang } = useLanguage();
  const [year, setYear]       = useState<number>(LAST_COMPLETED_YEAR);
  const [group, setGroup]     = useState<string>("All");

  const { data, isLoading, error } = useGetSafetyMetrics({ year });

  const filtered = useMemo(() => {
    if (!data) return [];
    return group === "All" ? data : data.filter(r => r.categoryGroup === group);
  }, [data, group]);

  // Totals by category (for bar chart)
  const categoryTotals = useMemo(() => {
    const map: Record<string, { count: number; group: string; es: string }> = {};
    for (const r of filtered) {
      if (!map[r.category]) map[r.category] = { count: 0, group: r.categoryGroup ?? "", es: r.categoryEs ?? r.category };
      map[r.category].count += r.incidentCount;
    }
    return Object.entries(map)
      .map(([cat, v]) => ({ category: cat, categoryEs: v.es, total: v.count, group: v.group }))
      .sort((a, b) => b.total - a.total);
  }, [filtered]);

  // Monthly trend (all categories summed)
  const monthlyTrend = useMemo(() => {
    const monthMap: Record<number, { name: string; total: number }> = {};
    for (const r of filtered) {
      if (!monthMap[r.month]) monthMap[r.month] = { name: r.monthName.slice(0, 3), total: 0 };
      monthMap[r.month].total += r.incidentCount;
    }
    return Object.entries(monthMap)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, v]) => v);
  }, [filtered]);

  // Grand total
  const grandTotal = useMemo(() => filtered.reduce((s, r) => s + r.incidentCount, 0), [filtered]);

  // Groups present in data
  const availableGroups = useMemo(() => {
    if (!data) return [];
    return ["All", ...GROUP_ORDER.filter(g => data.some(r => r.categoryGroup === g))];
  }, [data]);

  const groupLabel = (g: string) =>
    lang === "es" ? GROUPS_ES[g] ?? g : GROUPS_EN[g] ?? g;

  return (
    <PageWrapper>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t("Safety & Crime", "Seguridad y Crimen")}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t(
              "Municipal incident data from SESNSP — Puerto Vallarta, Jalisco.",
              "Datos de incidencia delictiva municipal de SESNSP — Puerto Vallarta, Jalisco."
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {YEARS.map((y) => <option key={y} value={y}>{yearLabel(y)}</option>)}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
          </div>
          <Skeleton className="h-[300px] w-full rounded-2xl" />
          <Skeleton className="h-[260px] w-full rounded-2xl" />
          <Skeleton className="h-[400px] w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">
            {t("Failed to load data.", "Error al cargar datos.")}
          </div>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-8">

          {/* Group filter tabs */}
          <div className="flex flex-wrap gap-2">
            {availableGroups.map((g) => (
              <button
                key={g}
                onClick={() => setGroup(g)}
                className="px-3 py-1.5 rounded-full text-xs font-semibold transition-all border"
                style={
                  group === g
                    ? {
                        background: g === "All" ? "#00C2A8" : GROUP_COLORS[g] ?? "#00C2A8",
                        color: "#fff",
                        borderColor: "transparent",
                      }
                    : {
                        background: "transparent",
                        color: "rgba(245,247,250,0.6)",
                        borderColor: "rgba(255,255,255,0.1)",
                      }
                }
              >
                {groupLabel(g)}
              </button>
            ))}
          </div>

          {/* KPI strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <Card className="glass-card">
              <CardContent className="pt-5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  {t("Total Incidents", "Total Incidentes")}
                </div>
                <div className="text-2xl font-bold text-rose-500 mt-1">{formatNumber(grandTotal)}</div>
                <div className="text-xs text-muted-foreground mt-1">{t("YTD", "Lo que va del año")}</div>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="pt-5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  {t("Categories", "Categorías")}
                </div>
                <div className="text-2xl font-bold text-primary mt-1">
                  {categoryTotals.length}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{t("offense types", "tipos de delito")}</div>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="pt-5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  {t("Top Category", "Categoría Principal")}
                </div>
                <div className="text-lg font-bold text-foreground mt-1 truncate">
                  {lang === "es"
                    ? categoryTotals[0]?.categoryEs
                    : categoryTotals[0]?.category}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {formatNumber(categoryTotals[0]?.total ?? 0)} {t("cases", "casos")}
                </div>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="pt-5">
                <div className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  {t("Monthly Avg", "Promedio Mensual")}
                </div>
                <div className="text-2xl font-bold text-amber-400 mt-1">
                  {formatNumber(Math.round(grandTotal / (monthlyTrend.length || 1)))}
                </div>
                <div className="text-xs text-muted-foreground mt-1">{t("incidents/month", "incidentes/mes")}</div>
              </CardContent>
            </Card>
          </div>

          {/* Monthly trend line */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="font-display">
                {t("Monthly Incident Trend", "Tendencia Mensual de Incidentes")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={220}>
                <LineChart data={monthlyTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                  <XAxis dataKey="name" tick={{ fontSize: 12, fill: "rgba(245,247,250,0.5)" }} />
                  <YAxis tick={{ fontSize: 12, fill: "rgba(245,247,250,0.5)" }} />
                  <Tooltip
                    contentStyle={{ background: "#163C4A", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                    labelStyle={{ color: "#F5F7FA" }}
                  />
                  <Line type="monotone" dataKey="total" stroke="#ef4444" strokeWidth={2} dot={false}
                    name={t("Total Incidents", "Total Incidentes")} />
                </LineChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Bar chart by category */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="font-display">
                {t("Incidents by Category (YTD)", "Incidentes por Categoría (Acumulado)")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={Math.max(280, categoryTotals.length * 28)}>
                <BarChart
                  data={categoryTotals.map(c => ({
                    ...c,
                    label: lang === "es" ? c.categoryEs : c.category,
                  }))}
                  layout="vertical"
                  margin={{ left: 8, right: 16 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11, fill: "rgba(245,247,250,0.5)" }} />
                  <YAxis type="category" dataKey="label" width={160} tick={{ fontSize: 11, fill: "rgba(245,247,250,0.65)" }} />
                  <Tooltip
                    contentStyle={{ background: "#163C4A", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8 }}
                    labelStyle={{ color: "#F5F7FA" }}
                    formatter={(v) => [formatNumber(v as number), t("Incidents", "Incidentes")]}
                  />
                  <Bar dataKey="total" radius={[0, 4, 4, 0]}
                    fill="#3b82f6"
                    label={{ position: "right", fontSize: 10, fill: "rgba(245,247,250,0.5)" }}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* Detail table */}
          <Card className="glass-card overflow-hidden">
            <CardHeader>
              <CardTitle className="font-display">
                {t("Monthly Breakdown", "Detalle Mensual")}
              </CardTitle>
            </CardHeader>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
                  <tr>
                    <th className="px-5 py-3">{t("Month", "Mes")}</th>
                    <th className="px-5 py-3">{t("Category", "Categoría")}</th>
                    <th className="px-5 py-3">{t("Group", "Grupo")}</th>
                    <th className="px-5 py-3">{t("Incidents", "Incidentes")}</th>
                    <th className="px-5 py-3">{t("Rate /100k", "Tasa /100k")}</th>
                    <th className="px-5 py-3">{t("YoY", "Cambio Anual")}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((row) => {
                    const yoy = Number(row.changeVsPriorYear);
                    return (
                      <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-5 py-3 font-medium">{row.monthName}</td>
                        <td className="px-5 py-3">
                          <span className="flex items-center gap-2">
                            <span
                              className="w-2 h-2 rounded-full flex-shrink-0"
                              style={{ background: GROUP_COLORS[row.categoryGroup ?? ""] ?? "#6b7280" }}
                            />
                            {lang === "es" && row.categoryEs ? row.categoryEs : row.category}
                          </span>
                        </td>
                        <td className="px-5 py-3">
                          <span
                            className="text-xs px-2 py-0.5 rounded-full font-medium"
                            style={{
                              background: `${GROUP_COLORS[row.categoryGroup ?? ""] ?? "#6b7280"}22`,
                              color: GROUP_COLORS[row.categoryGroup ?? ""] ?? "#6b7280",
                            }}
                          >
                            {lang === "es" ? GROUPS_ES[row.categoryGroup ?? ""] ?? row.categoryGroup : row.categoryGroup}
                          </span>
                        </td>
                        <td className="px-5 py-3 font-semibold text-rose-500">{formatNumber(row.incidentCount)}</td>
                        <td className="px-5 py-3 text-muted-foreground">
                          {row.incidentsPer100k ? Number(row.incidentsPer100k).toFixed(1) : "—"}
                        </td>
                        <td className={`px-5 py-3 font-medium text-sm ${yoy > 0 ? "text-rose-500" : "text-emerald-500"}`}>
                          {row.changeVsPriorYear != null
                            ? `${yoy > 0 ? "+" : ""}${yoy.toFixed(1)}%`
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>

          {/* Source note */}
          <p className="text-xs text-muted-foreground text-center pb-2">
            {t(
              "Source: SESNSP — Incidencia Delictiva del Fuero Común, Puerto Vallarta municipality. Population: 297,383 (INEGI 2020).",
              "Fuente: SESNSP — Incidencia Delictiva del Fuero Común, municipio de Puerto Vallarta. Población: 297,383 (INEGI 2020)."
            )}
          </p>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t("No data available for this year.", "No hay datos disponibles para este año.")}
        </div>
      )}
    </PageWrapper>
  );
}
