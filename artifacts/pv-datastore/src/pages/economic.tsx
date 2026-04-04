import { useMemo } from "react";
import { useGetEconomicMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Cell,
} from "recharts";
import { ExternalLink } from "lucide-react";
import { formatNumber } from "@/lib/utils";

const TOOLTIP_STYLE = {
  borderRadius: "12px",
  border: "none",
  boxShadow: "0 10px 25px -5px rgba(0,0,0,0.18)",
  background: "#0F2A36",
  color: "#F5F7FA",
};

const SECTOR_COLORS = ["#00C2A8", "#3B82F6", "#F59E0B", "#6366F1", "#EC4899", "#94A3B8"];

function pick(rows: { indicator: string; year: number; value: number }[], indicator: string) {
  return rows.filter((r) => r.indicator === indicator).sort((a, b) => a.year - b.year);
}

function latest(rows: { indicator: string; year: number; value: number }[], indicator: string) {
  const matches = pick(rows, indicator);
  return matches.length > 0 ? matches[matches.length - 1].value : null;
}

export default function Economic() {
  const { t, lang } = useLanguage();
  const { data: raw, isLoading } = useGetEconomicMetrics({});

  const rows = useMemo(
    () => (raw ?? []).map((r) => ({ ...r, value: Number(r.value) })),
    [raw]
  );

  // ── Population growth ─────────────────────────────────────────────────────
  const popData = pick(rows, "population").map((r) => ({
    year: r.year,
    population: r.value,
    label: r.year >= 2025 ? `${r.year}E` : String(r.year),
  }));

  // ── Formal employment trend ───────────────────────────────────────────────
  const employData = pick(rows, "imss_formal_workers").map((r) => ({
    year: r.year,
    workers: r.value,
  }));

  // ── Sector breakdown ─────────────────────────────────────────────────────
  const sectorIndicators = [
    { key: "sector_pct_tourism_hospitality", label: t("Tourism & Hospitality", "Turismo y Hotelería") },
    { key: "sector_pct_retail",              label: t("Retail Commerce",         "Comercio al Menudeo") },
    { key: "sector_pct_construction",        label: t("Construction",             "Construcción") },
    { key: "sector_pct_real_estate_services",label: t("Real Estate & Services",   "Serv. Inmobiliarios") },
    { key: "sector_pct_health_education",    label: t("Health & Education",        "Salud y Educación") },
    { key: "sector_pct_other",               label: t("Manufacturing & Other",     "Manufactura y Otros") },
  ];
  const sectorData = sectorIndicators
    .map(({ key, label }) => {
      const val = latest(rows, key);
      return val !== null ? { sector: label, pct: val } : null;
    })
    .filter(Boolean) as { sector: string; pct: number }[];

  // ── Wage comparison ───────────────────────────────────────────────────────
  const wageYears = [2020, 2021, 2022, 2023, 2024, 2025];
  const wageData = wageYears.map((y) => {
    const avgRow = rows.find((r) => r.indicator === "avg_daily_wage_mxn" && r.year === y);
    const minRow = rows.find((r) => r.indicator === "national_min_wage_mxn" && r.year === y);
    return {
      year: y,
      avgFormal: avgRow ? avgRow.value : null,
      minWage:   minRow ? minRow.value : null,
    };
  });

  // ── KPI snapshot values ───────────────────────────────────────────────────
  const population  = latest(rows, "population");             // 2025 est
  const pop2020     = rows.find((r) => r.indicator === "population" && r.year === 2020)?.value ?? null;
  const formalJobs  = latest(rows, "imss_formal_workers");    // 2024 est
  const businesses  = latest(rows, "active_businesses");
  const tourism     = latest(rows, "tourism_gdp_share_pct");
  const informality = latest(rows, "informality_rate_pct");

  // pop growth 2000→2025 (matches the displayed 2025 estimate headline figure)
  const pop2000 = rows.find((r) => r.indicator === "population" && r.year === 2000)?.value ?? null;
  const popGrowthTotal = population && pop2000 ? (((population - pop2000) / pop2000) * 100).toFixed(0) : null;

  return (
    <PageWrapper>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
          {t("Economic Overview", "Panorama Económico")}
        </h1>
        <p className="text-muted-foreground mt-1">
          {lang === "es"
            ? "Indicadores de negocios, empleo y demografía para el municipio de Puerto Vallarta. Fuentes: "
            : "Business, employment & demographic indicators for Puerto Vallarta municipality. Sources: "}
          {[
            { label: "INEGI", href: "https://www.inegi.org.mx/app/mapa/denue/" },
            { label: "IMSS",  href: "https://www.imss.gob.mx/prensa/archivo/202401/001" },
            { label: "CONEVAL", href: "https://www.coneval.org.mx/Medicion/Paginas/Medici%C3%B3n.aspx" },
            { label: "CONASAMI", href: "https://www.gob.mx/conasami" },
          ].map(({ label, href }, i, arr) => (
            <span key={label}>
              <a href={href} target="_blank" rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5">
                {label} <ExternalLink className="w-3 h-3" />
              </a>
              {i < arr.length - 1 ? ", " : "."}
            </span>
          ))}
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-32 rounded-2xl" />)}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-72 rounded-2xl" />)}
          </div>
        </div>
      ) : (
        <div className="space-y-6">

          {/* ── KPI Cards ──────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
            {[
              {
                label: t("Population", "Población"),
                value: population ? `~${formatNumber(Math.round(population / 1000) * 1000)}` : "—",
                sub: popGrowthTotal ? `+${popGrowthTotal}% since 2000` : "CONAPO 2025 est.",
                color: "#00C2A8",
                up: true,
              },
              {
                label: t("Formal Workers", "Empleo Formal"),
                value: formalJobs ? `~${formatNumber(Math.round(formalJobs / 100) * 100)}` : "—",
                sub: t("IMSS-registered, 2024 est.", "Asegurados IMSS, est. 2024"),
                color: "#3B82F6",
                up: true,
              },
              {
                label: t("Active Businesses", "Unidades Económicas"),
                value: businesses ? `${formatNumber(businesses)}+` : "—",
                sub: t("DENUE 2023 update", "DENUE actualización 2023"),
                color: "#F59E0B",
                up: null,
              },
              {
                label: t("Tourism Share of Economy", "Peso del Turismo"),
                value: tourism ? `~${tourism}%` : "—",
                sub: t("of local economic output", "del producto económico local"),
                color: "#6366F1",
                up: null,
              },
              {
                label: t("Informal Employment", "Informalidad Laboral"),
                value: informality ? `${informality}%` : "—",
                sub: t("of working population (ENOE 2020)", "de la PEA (ENOE 2020)"),
                color: "#EC4899",
                up: false,
              },
            ].map(({ label, value, sub, color, up }) => (
              <div key={label} className="glass-card flex flex-col gap-2" style={{ padding: "1.25rem" }}>
                <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "#9AA5B1" }}>
                  {label}
                </span>
                <div className="text-2xl font-bold" style={{ color, letterSpacing: "-0.02em" }}>
                  {value}
                </div>
                <span className={`text-xs ${up === true ? "text-emerald-400" : up === false ? "text-amber-400" : "text-muted-foreground/70"}`}>
                  {sub}
                </span>
              </div>
            ))}
          </div>

          {/* ── 2×2 chart grid ─────────────────────────────────────────── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

            {/* Chart 1: Population growth */}
            <Card className="glass-card border-0">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">
                      {t("Population Growth 1970–2025", "Crecimiento Poblacional 1970–2025")}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t(
                        "INEGI decennial censuses + intercensal counts (exact) · CONAPO 2025 projection · 12× growth in 55 years",
                        "Censos decenales INEGI + conteos intercensales (exactos) · proyección CONAPO 2025 · crecimiento 12× en 55 años"
                      )}
                    </p>
                  </div>
                  <a href="https://www.inegi.org.mx/programas/ccpv/2020/" target="_blank" rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 shrink-0">
                    INEGI <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={popData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="popGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#00C2A8" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#00C2A8" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="label" axisLine={false} tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <YAxis axisLine={false} tickLine={false} width={52}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number, _: string, entry: { payload?: { label?: string } }) => [
                        formatNumber(v),
                        entry?.payload?.label?.endsWith("E")
                          ? t("Population (est.)", "Población (est.)")
                          : t("Population (exact)", "Población (exacto)")
                      ]} />
                    <Area type="monotone" dataKey="population" stroke="#00C2A8" strokeWidth={2.5}
                      fill="url(#popGrad)" dot={{ r: 4, fill: "#00C2A8", strokeWidth: 0 }}
                      activeDot={{ r: 6 }} />
                  </AreaChart>
                </ResponsiveContainer>
                <div className="mt-2 grid grid-cols-3 gap-2 text-center">
                  {[
                    { year: "1970", val: "24,155", note: t("Fishing town", "Villa pesquera") },
                    { year: "1990", val: "111,457", note: t("Tourism boom", "Boom turístico") },
                    { year: "2020", val: "292,192", note: t("INEGI Census", "Censo INEGI") },
                  ].map(({ year, val, note }) => (
                    <div key={year} className="rounded-lg bg-muted/20 px-2 py-1.5">
                      <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wider">{year}</div>
                      <div className="text-sm font-bold text-foreground">{val}</div>
                      <div className="text-[10px] text-muted-foreground/70">{note}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Chart 2: Formal employment trend */}
            <Card className="glass-card border-0">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">
                      {t("Formal Employment 2019–2024", "Empleo Formal IMSS 2019–2024")}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("IMSS-insured workers — shows COVID-19 impact and recovery",
                         "Trabajadores asegurados al IMSS — impacto COVID-19 y recuperación")}
                    </p>
                  </div>
                  <a href="https://www.imss.gob.mx/prensa/archivo" target="_blank" rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 shrink-0">
                    IMSS <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={240}>
                  <AreaChart data={employData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="empGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#3B82F6" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="year" axisLine={false} tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <YAxis axisLine={false} tickLine={false} domain={["auto", "auto"]} width={52}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number) => [formatNumber(v), t("Formal workers", "Trabajadores formales")]} />
                    <Area type="monotone" dataKey="workers" stroke="#3B82F6" strokeWidth={2.5}
                      fill="url(#empGrad)" dot={{ r: 4, fill: "#3B82F6", strokeWidth: 0 }}
                      activeDot={{ r: 6 }} />
                  </AreaChart>
                </ResponsiveContainer>
                <p className="text-xs text-muted-foreground/60 text-center mt-1">
                  {t("2020 dip reflects COVID-19 pandemic job losses in PVR's tourism-heavy economy",
                     "La caída de 2020 refleja el impacto del COVID-19 en la economía turística de PVR")}
                </p>
              </CardContent>
            </Card>

            {/* Chart 3: Sector employment breakdown */}
            <Card className="glass-card border-0">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">
                      {t("Employment by Sector", "Empleo por Sector Económico")}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("Share of formal workers across economic sectors (INEGI Censo Económico 2019)",
                         "Distribución del empleo formal por sector (INEGI Censo Económico 2019)")}
                    </p>
                  </div>
                  <a href="https://www.inegi.org.mx/programas/ce/2019/" target="_blank" rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 shrink-0">
                    INEGI <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={240}>
                  <BarChart data={sectorData} layout="vertical"
                    margin={{ top: 4, right: 40, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" horizontal={false} />
                    <XAxis type="number" axisLine={false} tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      tickFormatter={(v) => `${v}%`} domain={[0, 45]} />
                    <YAxis type="category" dataKey="sector" axisLine={false} tickLine={false} width={130}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number) => [`${v}%`, t("Employment share", "Participación laboral")]} />
                    <Bar dataKey="pct" radius={[0, 4, 4, 0]}>
                      {sectorData.map((_, i) => (
                        <Cell key={i} fill={SECTOR_COLORS[i % SECTOR_COLORS.length]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Chart 4: Wage growth */}
            <Card className="glass-card border-0">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="text-base font-semibold">
                      {t("Daily Wage Trends 2020–2025 (MXN)", "Salarios Diarios 2020–2025 (MXN)")}
                    </CardTitle>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("Average formal wage (est.) vs national minimum wage (exact)",
                         "Salario formal promedio (est.) vs salario mínimo nacional (exacto)")}
                    </p>
                  </div>
                  <a href="https://www.gob.mx/conasami" target="_blank" rel="noopener noreferrer"
                    className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1 shrink-0">
                    CONASAMI <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={wageData} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="year" axisLine={false} tickLine={false}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} />
                    <YAxis axisLine={false} tickLine={false} width={44}
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                      tickFormatter={(v) => `$${v}`} />
                    <Tooltip contentStyle={TOOLTIP_STYLE}
                      formatter={(v: number, name: string) =>
                        [`$${v} MXN/day`, name === "avgFormal"
                          ? t("Avg Formal Wage (est.)", "Salario Formal Prom. (est.)")
                          : t("Min Wage (exact)", "Salario Mínimo (exacto)")]} />
                    <Legend wrapperStyle={{ paddingTop: 12, fontSize: 12 }}
                      formatter={(val) =>
                        val === "avgFormal"
                          ? t("Avg Formal Wage (est.)", "Salario Formal Prom. (est.)")
                          : t("National Min Wage (exact)", "Salario Mínimo Nacional (exacto)")} />
                    <Line type="monotone" dataKey="avgFormal" stroke="#00C2A8" strokeWidth={2.5}
                      dot={{ r: 3, fill: "#00C2A8" }} activeDot={{ r: 5 }} />
                    <Line type="monotone" dataKey="minWage" stroke="#F59E0B" strokeWidth={2}
                      strokeDasharray="5 3" dot={{ r: 3, fill: "#F59E0B" }} activeDot={{ r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
                <p className="text-xs text-muted-foreground/60 text-center mt-1">
                  {t(
                    "Mexico has raised the minimum wage ~125% since 2020 — a major structural shift.",
                    "México ha aumentado el salario mínimo ~125% desde 2020 — un cambio estructural importante."
                  )}
                </p>
              </CardContent>
            </Card>

          </div>

          {/* ── Context data cards ─────────────────────────────────────── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              {
                label: t("Poverty Rate", "Tasa de Pobreza"),
                value: "33.4%",
                sub: "CONEVAL 2020 (est.)",
                href: "https://www.coneval.org.mx/Medicion/Paginas/Medici%C3%B3n.aspx",
                color: "#F59E0B",
              },
              {
                label: t("Extreme Poverty", "Pobreza Extrema"),
                value: "5.1%",
                sub: "CONEVAL 2020 (est.)",
                href: "https://www.coneval.org.mx/Medicion/Paginas/Medici%C3%B3n.aspx",
                color: "#EF4444",
              },
              {
                label: t("Economic Units (2019)", "Unidades Económicas (2019)"),
                value: "17,786",
                sub: t("INEGI Censo Económico 2019 (exact)", "INEGI Censo Económico 2019 (exacto)"),
                href: "https://www.inegi.org.mx/programas/ce/2019/",
                color: "#6366F1",
              },
              {
                label: t("Formal Workers (2019 Census)", "Trabajadores Formales (Censo 2019)"),
                value: "78,447",
                sub: t("dependent workers across all sectors", "trabajadores dependientes en todos los sectores"),
                href: "https://www.inegi.org.mx/programas/ce/2019/",
                color: "#3B82F6",
              },
            ].map(({ label, value, sub, href, color }) => (
              <a key={label} href={href} target="_blank" rel="noopener noreferrer"
                className="glass-card flex flex-col gap-1.5 hover:border-primary/30 transition-colors no-underline"
                style={{ padding: "1.1rem" }}>
                <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: "#9AA5B1" }}>
                  {label}
                </span>
                <div className="text-xl font-bold" style={{ color }}>{value}</div>
                <span className="text-xs text-muted-foreground/70 flex items-center gap-1">
                  {sub} <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                </span>
              </a>
            ))}
          </div>

          {/* ── Data notes ──────────────────────────────────────────────── */}
          <div className="glass-card text-xs text-muted-foreground/70 space-y-1" style={{ padding: "1rem 1.25rem" }}>
            <p className="font-semibold text-muted-foreground text-xs uppercase tracking-wider mb-2">
              {t("Data Notes", "Notas de Datos")}
            </p>
            <p>• {t("Population figures from INEGI census/conteo years (1970, 1980, 1990, 1995, 2000, 2005, 2010, 2015, 2020) are exact as published. 2025 is CONAPO projection. PVR grew 12× in 55 years — from a fishing village of 24K to a metro area of 320K+ (2025 est.).", "Las cifras de población de censos/conteos INEGI (1970–2020) son exactas. 2025 es proyección CONAPO. PVR creció 12× en 55 años.")}</p>
            <p>• {t("Formal employment figures are estimates derived from IMSS published municipal reports; 2020–2024 values carry ±3% margin.", "El empleo formal son estimaciones de informes municipales del IMSS; 2020–2024 tienen margen de ±3%.")}</p>
            <p>• {t("Sector employment shares are from INEGI Censo Económico 2019 (78,447 workers across 17,786 units).", "Las participaciones sectoriales provienen del Censo Económico 2019 del INEGI.")}</p>
            <p>• {t("National minimum wage figures (CONASAMI) are exact. Average formal wage is estimated at ~2.1–2.3× minimum for PVR's tourism workforce.", "El salario mínimo (CONASAMI) es exacto. El salario formal promedio es estimado en ~2.1–2.3× el mínimo.")}</p>
            <p>• {t("Puerto Vallarta has no official municipal-level GDP. Tourism GDP share is a SECTUR/DATATUR sectoral estimate.", "Puerto Vallarta no tiene PIB municipal oficial. El peso del turismo es estimación sectorial SECTUR/DATATUR.")}</p>
          </div>

        </div>
      )}
    </PageWrapper>
  );
}
