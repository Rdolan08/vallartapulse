import { useEffect, useState } from "react";
import { Link } from "wouter";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { apiFetch } from "@/lib/api-base";
import { AlertTriangle, ArrowRight, ChevronDown, ChevronUp, Clock, TrendingDown, TrendingUp, Minus } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Level = "high" | "moderate" | "low" | "unknown";
type DemandTrend = "increasing" | "stable" | "decreasing" | "unknown";
type PricingTrend = "increasing" | "stable" | "softening" | "unknown";
type TourismLabel = "higher" | "in_line" | "slightly_lower" | "lower";

interface NeighborhoodRow {
  neighborhood: string;
  listingCount: number;
  availabilityRate: number | null;
  avgPriceUsd: number | null;
  availabilityLevel: Level;
}

interface BySourceRow {
  source: string;
  listingsPriced: number;
  avgPriceUsd: number | null;
}

interface BedBathRow {
  bedrooms: number;
  bathrooms: number;
  listingCount: number;
  avgPriceUsd: number | null;
  mostPopular: boolean;
}

interface AvailabilityTrendPoint {
  date: string;
  availabilityRate: number | null;
}

interface AvailabilityTrendResponse {
  series: AvailabilityTrendPoint[];
  neighborhoods?: string[];
}

interface RentalMarketLive {
  generatedAt: string;
  recent: {
    totalRows: number;
    availableRows: number;
    distinctListings: number;
    availabilityRate: number | null;
    avgPriceUsd: number | null;
    listingsWithPrice: number;
  };
  prior: {
    totalRows: number;
    availableRows: number;
    availabilityRate: number | null;
    avgPriceUsd: number | null;
  };
  cohort: {
    distinctListings: number;
    priceCoverage: number | null;
  };
  signals: {
    availabilityLevel: Level;
    availabilityRateDelta: number | null;
    demandTrend: DemandTrend;
    pricingTrend: PricingTrend;
    pricingTrendPct: number | null;
  };
  neighborhoods: NeighborhoodRow[];
  bySource: BySourceRow[];
  byBedBath: BedBathRow[];
  tourism: {
    currentYear: number;
    currentMonth: number;
    currentPassengers: number;
    priorYear: number;
    priorPassengers: number;
    yoyChangePct: number;
    label: TourismLabel;
  } | null;
  freshness: {
    newestScrapeAt: string | null;
    ageHours: number | null;
    isStale: boolean;
  };
}

const MONTH_NAMES_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const MONTH_NAMES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

function fmtPct(v: number | null, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}
function fmtSignedPct(v: number | null, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(digits)}%`;
}
function fmtUsd(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `$${Math.round(v).toLocaleString()}`;
}
function fmtNumber(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return Math.round(v).toLocaleString();
}
function fmtAge(hours: number | null): { en: string; es: string } {
  if (hours == null || !Number.isFinite(hours)) return { en: "unknown", es: "desconocido" };
  if (hours < 1) return { en: "just now", es: "justo ahora" };
  if (hours < 24) {
    const h = Math.round(hours);
    return { en: `${h}h ago`, es: `hace ${h}h` };
  }
  const d = Math.round(hours / 24);
  return { en: `${d}d ago`, es: `hace ${d}d` };
}

export default function RentalMarket() {
  const { t, lang } = useLanguage();
  const [data, setData] = useState<RentalMarketLive | null>(null);
  const [trend, setTrend] = useState<AvailabilityTrendPoint[] | null>(null);
  const [trendNeighborhoods, setTrendNeighborhoods] = useState<string[]>([]);
  const [trendNeighborhood, setTrendNeighborhood] = useState<string>("all");
  const [trendLoading, setTrendLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      apiFetch<RentalMarketLive>("/api/metrics/rental-market-live"),
      apiFetch<AvailabilityTrendResponse>("/api/metrics/rental-availability-trend").catch(
        () => ({ series: [] as AvailabilityTrendPoint[], neighborhoods: [] as string[] }),
      ),
    ])
      .then(([d, tr]) => {
        if (cancelled) return;
        setData(d);
        setTrend(tr.series);
        setTrendNeighborhoods(tr.neighborhoods ?? []);
        setError(null);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message ?? "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  // Refetch trend series when the neighborhood filter changes (skip the
  // "all" default on initial mount — that's covered by the load above).
  useEffect(() => {
    if (trendNeighborhood === "all") return;
    let cancelled = false;
    setTrendLoading(true);
    const qs = `?neighborhood=${encodeURIComponent(trendNeighborhood)}`;
    apiFetch<AvailabilityTrendResponse>(`/api/metrics/rental-availability-trend${qs}`)
      .then((tr) => {
        if (cancelled) return;
        setTrend(tr.series);
      })
      .catch(() => {
        if (cancelled) return;
        setTrend([]);
      })
      .finally(() => {
        if (!cancelled) setTrendLoading(false);
      });
    return () => { cancelled = true; };
  }, [trendNeighborhood]);

  // When the user switches back to "all", reload the metro-wide series.
  useEffect(() => {
    if (trendNeighborhood !== "all") return;
    if (loading) return; // initial load already populates the metro series
    let cancelled = false;
    setTrendLoading(true);
    apiFetch<AvailabilityTrendResponse>("/api/metrics/rental-availability-trend")
      .then((tr) => {
        if (cancelled) return;
        setTrend(tr.series);
      })
      .catch(() => {
        if (cancelled) return;
        setTrend([]);
      })
      .finally(() => {
        if (!cancelled) setTrendLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trendNeighborhood]);

  const now = new Date();
  const currentMonthLabel =
    lang === "es"
      ? `${MONTH_NAMES_ES[now.getMonth()]} ${now.getFullYear()}`
      : `${MONTH_NAMES_EN[now.getMonth()]} ${now.getFullYear()}`;

  return (
    <PageWrapper>
      <div className="mb-8">
        <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
          {t("Rental Market", "Mercado de Renta")} — {currentMonthLabel}
        </h1>
        <p className="text-muted-foreground mt-1">
          {t(
            "Live availability, pricing, and demand signals computed in real time from the tracked Puerto Vallarta short-term rental cohort.",
            "Disponibilidad, precios y señales de demanda en tiempo real, calculados directamente sobre la cohorte rastreada de rentas a corto plazo en Puerto Vallarta.",
          )}
        </p>
      </div>

      {loading ? (
        <div className="space-y-6">
          <Skeleton className="h-32 w-full rounded-2xl" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
          </div>
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : error || !data ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">
            {t("Failed to load live market data.", "Error al cargar datos del mercado en vivo.")}
          </div>
          {error && <div className="text-xs text-muted-foreground mt-2">{error}</div>}
        </div>
      ) : (
        <div className="space-y-8">
          <FreshnessBanner data={data} t={t} lang={lang} />
          <CurrentMarketSignal data={data} t={t} lang={lang} currentMonthLabel={currentMonthLabel} />

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <MarketAvailability data={data} t={t} />
            <PricingSignal data={data} t={t} />
            <TourismImpact data={data} t={t} lang={lang} />
          </div>

          <AvailabilityTrendChart
            series={trend ?? []}
            t={t}
            lang={lang}
            neighborhoods={trendNeighborhoods}
            selected={trendNeighborhood}
            onChange={setTrendNeighborhood}
            loading={trendLoading}
          />

          <PricingBreakdown data={data} t={t} />

          <ActionableGuidance data={data} t={t} />
          <MarketSegmentation data={data} t={t} lang={lang} />
          <CTASection t={t} />
        </div>
      )}
    </PageWrapper>
  );
}

/* ─────────────────────────── Section components ─────────────────────────── */

function FreshnessBanner({
  data, t, lang,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
  lang: "en" | "es";
}) {
  const age = fmtAge(data.freshness.ageHours);
  if (data.freshness.isStale) {
    return (
      <div className="flex items-start gap-3 p-4 rounded-2xl border border-amber-300/60 bg-amber-50 dark:bg-amber-900/20">
        <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
        <div>
          <div className="font-semibold text-amber-900 dark:text-amber-200">
            {t("Data refresh lag detected", "Retraso en la actualización de datos detectado")}
          </div>
          <div className="text-sm text-amber-800/80 dark:text-amber-200/80">
            {t("Newest scrape: ", "Última captura: ")}{lang === "es" ? age.es : age.en}
            {data.freshness.newestScrapeAt &&
              ` · ${new Date(data.freshness.newestScrapeAt).toLocaleString(lang === "es" ? "es-MX" : "en-US")}`}
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <Clock className="w-3.5 h-3.5" />
      {t("Data updated: ", "Datos actualizados: ")}
      {data.freshness.newestScrapeAt
        ? new Date(data.freshness.newestScrapeAt).toLocaleString(lang === "es" ? "es-MX" : "en-US")
        : "—"}
      <span>·</span>
      <span>{lang === "es" ? age.es : age.en}</span>
    </div>
  );
}

function CurrentMarketSignal({
  data, t, lang, currentMonthLabel,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
  lang: "en" | "es";
  currentMonthLabel: string;
}) {
  const { availabilityLevel, demandTrend, availabilityRateDelta } = data.signals;

  const levelLabelEn = {
    high: "higher availability (soft demand)",
    moderate: "moderate availability",
    low: "low availability (strong demand)",
    unknown: "insufficient data to classify availability",
  }[availabilityLevel];
  const levelLabelEs = {
    high: "alta disponibilidad (demanda débil)",
    moderate: "disponibilidad moderada",
    low: "baja disponibilidad (demanda fuerte)",
    unknown: "datos insuficientes para clasificar disponibilidad",
  }[availabilityLevel];

  const trendEn = {
    increasing: "demand is increasing",
    stable: "demand is stable",
    decreasing: "demand is decreasing",
    unknown: "demand trend is undetermined",
  }[demandTrend];
  const trendEs = {
    increasing: "la demanda está aumentando",
    stable: "la demanda es estable",
    decreasing: "la demanda está disminuyendo",
    unknown: "la tendencia de la demanda es indeterminada",
  }[demandTrend];

  const interpEn = {
    high: "owners face more competition and softer pricing power",
    moderate: "the market is broadly balanced",
    low: "owners can hold or push rates with confidence",
    unknown: "more data is needed before drawing a conclusion",
  }[availabilityLevel];
  const interpEs = {
    high: "los propietarios enfrentan más competencia y menor poder para subir precios",
    moderate: "el mercado está en general equilibrado",
    low: "los propietarios pueden mantener o subir tarifas con confianza",
    unknown: "se necesitan más datos antes de concluir",
  }[availabilityLevel];

  return (
    <Card className="glass-card">
      <CardContent className="pt-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground mb-2">
          <TrendIcon trend={demandTrend} />
          {t("Current Market Signal", "Señal Actual del Mercado")}
        </div>
        <p className="text-lg leading-relaxed">
          {t(
            `For ${currentMonthLabel}, ${trendEn}. Availability across the tracked cohort is ${levelLabelEn}, indicating that ${interpEn}.`,
            `Para ${currentMonthLabel}, ${trendEs}. La disponibilidad en la cohorte rastreada es ${levelLabelEs}, lo que indica que ${interpEs}.`,
          )}
        </p>
        <div className="text-xs text-muted-foreground mt-3">
          {t(
            `Based on ${fmtNumber(data.recent.distinctListings)} listings · ${fmtNumber(data.recent.totalRows)} listing-nights in the next 30 days · `,
            `Basado en ${fmtNumber(data.recent.distinctListings)} anuncios · ${fmtNumber(data.recent.totalRows)} noches-anuncio en los próximos 30 días · `,
          )}
          {availabilityRateDelta != null
            ? t(
                `availability shifted ${fmtSignedPct(availabilityRateDelta)} vs the following 30-day window.`,
                `la disponibilidad cambió ${fmtSignedPct(availabilityRateDelta)} vs la ventana de 30 días siguiente.`,
              )
            : t("trend baseline unavailable.", "línea base de tendencia no disponible.")}
        </div>
      </CardContent>
    </Card>
  );
}

function MarketAvailability({
  data, t,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
}) {
  const rate = data.recent.availabilityRate;
  const interpEn = rate == null
    ? "Insufficient data to assess market conditions."
    : rate > 0.65
      ? "This indicates a relatively soft market."
      : rate < 0.5
        ? "This indicates strong demand conditions."
        : "This indicates balanced market conditions.";
  const interpEs = rate == null
    ? "Datos insuficientes para evaluar condiciones del mercado."
    : rate > 0.65
      ? "Esto indica un mercado relativamente suave."
      : rate < 0.5
        ? "Esto indica condiciones de demanda fuerte."
        : "Esto indica condiciones de mercado equilibradas.";

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display text-base">
          {t("Market Availability", "Disponibilidad del Mercado")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-primary">{fmtPct(rate, 1)}</div>
        <p className="text-sm text-muted-foreground mt-2">
          {t(
            `~${fmtPct(rate, 0)} of nights across tracked listings are currently available in the next 30 days.`,
            `~${fmtPct(rate, 0)} de las noches en los anuncios rastreados están actualmente disponibles en los próximos 30 días.`,
          )}
        </p>
        <p className="text-sm mt-3">{t(interpEn, interpEs)}</p>
      </CardContent>
    </Card>
  );
}

function PricingSignal({
  data, t,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
}) {
  const { pricingTrend, pricingTrendPct } = data.signals;
  const cov = data.cohort.priceCoverage;

  const trendLabelEn = {
    increasing: "Pricing is increasing",
    stable: "Pricing is stable",
    softening: "Pricing is softening",
    unknown: "Trend baseline unavailable",
  }[pricingTrend];
  const trendLabelEs = {
    increasing: "Los precios están subiendo",
    stable: "Los precios son estables",
    softening: "Los precios están bajando",
    unknown: "Línea base de tendencia no disponible",
  }[pricingTrend];

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display text-base">
          {t("Pricing Signal", "Señal de Precios")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-primary">{fmtUsd(data.recent.avgPriceUsd)}</div>
        <p className="text-sm text-muted-foreground mt-2">
          {t(
            `Blended average nightly rate across Airbnb + PVRPV listings with active pricing data (${fmtPct(cov, 0)} of cohort). Per-source and per-configuration breakdown shown below.`,
            `Tarifa promedio combinada por noche en anuncios de Airbnb + PVRPV con datos de precio activos (${fmtPct(cov, 0)} de la cohorte). Desglose por fuente y configuración abajo.`,
          )}
        </p>
        <div className="flex items-center gap-2 mt-3 text-sm">
          <TrendIcon
            trend={
              pricingTrend === "increasing" ? "increasing"
                : pricingTrend === "softening" ? "decreasing"
                  : pricingTrend === "stable" ? "stable" : "unknown"
            }
          />
          <span className="font-semibold">{t(trendLabelEn, trendLabelEs)}</span>
          {pricingTrendPct != null && (
            <span className="text-muted-foreground">({fmtSignedPct(pricingTrendPct)})</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          {t("Relative to the 30-day window beyond.", "Relativo a la ventana de 30 días posterior.")}
        </p>
      </CardContent>
    </Card>
  );
}

function SourceBreakdownCard({
  data, t, sourceLabel,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
  sourceLabel: (s: string) => string;
}) {
  const total = data.bySource.reduce((acc, r) => acc + r.listingsPriced, 0);
  const prices = data.bySource.map((r) => r.avgPriceUsd);
  const minPrice = prices.length ? Math.min(...prices) : 0;
  const maxPrice = prices.length ? Math.max(...prices) : 0;
  const blendedAvg = total > 0
    ? data.bySource.reduce((acc, r) => acc + r.avgPriceUsd * r.listingsPriced, 0) / total
    : 0;

  // Brand-ish colors per source
  const sourceColor = (s: string) =>
    s === "airbnb" ? "#FF5A5F" : s === "pvrpv" ? "#00C2A8" : s === "vrbo" ? "#3B82F6" : "#94A3B8";

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display">
          {t("Pricing by Source", "Precios por Fuente")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t(
            "Average nightly rate split across the platforms feeding the cohort.",
            "Tarifa promedio por noche separada por las plataformas que alimentan la cohorte.",
          )}
        </p>
      </CardHeader>

      <CardContent className="pt-0 flex flex-col gap-5">
        {/* Cohort summary chip row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-xl bg-black/20 border border-white/[0.06] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Total Priced", "Con Precio")}
            </div>
            <div className="text-xl font-bold text-foreground tabular-nums mt-0.5">
              {fmtNumber(total)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t("listings", "anuncios")}
            </div>
          </div>
          <div className="rounded-xl bg-black/20 border border-white/[0.06] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Blended Avg", "Promedio Mezclado")}
            </div>
            <div className="text-xl font-bold text-primary tabular-nums mt-0.5">
              {fmtUsd(blendedAvg)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {t("per night", "por noche")}
            </div>
          </div>
          <div className="rounded-xl bg-black/20 border border-white/[0.06] p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Spread", "Rango")}
            </div>
            <div className="text-xl font-bold text-foreground tabular-nums mt-0.5">
              {fmtUsd(maxPrice - minPrice)}
            </div>
            <div className="text-[10px] text-muted-foreground mt-0.5">
              {fmtUsd(minPrice)} – {fmtUsd(maxPrice)}
            </div>
          </div>
        </div>

        {/* Visual market-share stacked bar */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("Market Share — Priced Cohort", "Cuota — Cohorte con Precio")}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {t("by listing count", "por cantidad de anuncios")}
            </span>
          </div>
          <div className="flex h-3 w-full rounded-full overflow-hidden bg-black/30 border border-white/[0.04]">
            {data.bySource.map((row) => {
              const pct = total > 0 ? (row.listingsPriced / total) * 100 : 0;
              return (
                <div
                  key={row.source}
                  style={{ width: `${pct}%`, background: sourceColor(row.source) }}
                  title={`${sourceLabel(row.source)} ${pct.toFixed(1)}%`}
                />
              );
            })}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {data.bySource.map((row) => {
              const pct = total > 0 ? (row.listingsPriced / total) * 100 : 0;
              return (
                <div key={row.source} className="flex items-center gap-1.5 text-xs">
                  <span
                    className="w-2.5 h-2.5 rounded-sm"
                    style={{ background: sourceColor(row.source) }}
                  />
                  <span className="font-medium text-foreground">{sourceLabel(row.source)}</span>
                  <span className="text-muted-foreground tabular-nums">{pct.toFixed(1)}%</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Per-source detailed cards */}
        <div className="flex flex-col gap-2.5">
          {data.bySource.map((row) => {
            const pct = total > 0 ? (row.listingsPriced / total) * 100 : 0;
            const vsBlend = blendedAvg > 0 ? ((row.avgPriceUsd - blendedAvg) / blendedAvg) * 100 : 0;
            return (
              <div
                key={row.source}
                className="rounded-xl border border-white/[0.06] bg-black/20 p-3.5"
              >
                <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <span
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ background: sourceColor(row.source) }}
                    />
                    <span className="font-semibold text-foreground">{sourceLabel(row.source)}</span>
                    <span className="text-xs text-muted-foreground">
                      · {fmtNumber(row.listingsPriced)} {t("listings", "anuncios")}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span className="text-lg font-bold text-primary tabular-nums">
                      {fmtUsd(row.avgPriceUsd)}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      /{t("nt", "nt")}
                    </span>
                  </div>
                </div>
                {/* Price bar relative to max */}
                <div className="h-1.5 w-full bg-white/[0.04] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${maxPrice > 0 ? (row.avgPriceUsd / maxPrice) * 100 : 0}%`,
                      background: sourceColor(row.source),
                      opacity: 0.7,
                    }}
                  />
                </div>
                <div className="flex items-center justify-between mt-1.5 text-[11px] text-muted-foreground">
                  <span>
                    {pct.toFixed(1)}% {t("of priced cohort", "de la cohorte")}
                  </span>
                  <span className={vsBlend >= 0 ? "text-emerald-400" : "text-amber-400"}>
                    {vsBlend >= 0 ? "+" : ""}{vsBlend.toFixed(1)}% {t("vs blended", "vs mezclado")}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function PricingBreakdown({
  data, t,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
}) {
  if (data.bySource.length === 0 && data.byBedBath.length === 0) return null;

  const sourceLabel = (s: string) =>
    s === "airbnb" ? "Airbnb" : s === "pvrpv" ? "PVRPV" : s === "vrbo" ? "VRBO" : s;

  const top = data.byBedBath.find((b) => b.mostPopular) ?? data.byBedBath[0];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* By source */}
      <SourceBreakdownCard data={data} t={t} sourceLabel={sourceLabel} />

      {/* By configuration */}
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="font-display">
            {t("Pricing by Configuration", "Precios por Configuración")}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t(
              "Most common bed/bath combinations in the priced cohort, ranked by listing count.",
              "Combinaciones más comunes de recámara/baño en la cohorte con precio, ordenadas por cantidad de anuncios.",
            )}
          </p>
        </CardHeader>
        <CardContent className="pt-0">
          {top && (
            <div className="mb-4 p-3 rounded-xl bg-primary/5 border border-primary/20">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {t("Most popular configuration", "Configuración más popular")}
              </div>
              <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                <span className="text-2xl font-bold text-primary">
                  {top.bedrooms} {t("BR", "Rec")} / {top.bathrooms} {t("BA", "Baño")}
                </span>
                <span className="text-lg font-semibold">{fmtUsd(top.avgPriceUsd)}/{t("night", "noche")}</span>
                <span className="text-xs text-muted-foreground">
                  {fmtNumber(top.listingCount)} {t("listings", "anuncios")}
                </span>
              </div>
            </div>
          )}
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-muted-foreground border-b">
              <tr>
                <th className="py-2 text-left">{t("Configuration", "Configuración")}</th>
                <th className="py-2 text-right">{t("Listings", "Anuncios")}</th>
                <th className="py-2 text-right">{t("Avg nightly", "Promedio noche")}</th>
              </tr>
            </thead>
            <tbody>
              {data.byBedBath.map((row) => (
                <tr key={`${row.bedrooms}-${row.bathrooms}`} className="border-b last:border-0">
                  <td className="py-3 font-medium">
                    {row.bedrooms} {t("BR", "Rec")} / {row.bathrooms} {t("BA", "Baño")}
                  </td>
                  <td className="py-3 text-right">{fmtNumber(row.listingCount)}</td>
                  <td className="py-3 text-right font-semibold">{fmtUsd(row.avgPriceUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function TourismImpact({
  data, t, lang,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
  lang: "en" | "es";
}) {
  const tour = data.tourism;
  if (!tour) {
    return (
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="font-display text-base">
            {t("Tourism Impact", "Impacto Turístico")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t(
              "Year-over-year airport-passenger comparison unavailable for the latest reported month.",
              "Comparación interanual de pasajeros del aeropuerto no disponible para el último mes reportado.",
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  const labelEn = {
    higher: "higher",
    in_line: "broadly in line with",
    slightly_lower: "slightly lower than",
    lower: "meaningfully lower than",
  }[tour.label];
  const labelEs = {
    higher: "mayor",
    in_line: "en general en línea con",
    slightly_lower: "ligeramente menor que",
    lower: "significativamente menor que",
  }[tour.label];

  const interpEn = {
    higher: "This is supporting stronger rental demand.",
    in_line: "Demand is broadly in line with prior year.",
    slightly_lower: "Slightly softer than last year, with mild downward pressure.",
    lower: "This is contributing to softer rental demand.",
  }[tour.label];
  const interpEs = {
    higher: "Esto está apoyando una demanda de renta más fuerte.",
    in_line: "La demanda está en general en línea con el año anterior.",
    slightly_lower: "Ligeramente más suave que el año pasado, con presión a la baja moderada.",
    lower: "Esto está contribuyendo a una demanda de renta más suave.",
  }[tour.label];

  const monthName =
    lang === "es" ? MONTH_NAMES_ES[tour.currentMonth - 1] : MONTH_NAMES_EN[tour.currentMonth - 1];

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display text-base">
          {t("Tourism Impact", "Impacto Turístico")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-3xl font-bold text-primary">{fmtSignedPct(tour.yoyChangePct, 1)}</div>
        <p className="text-sm text-muted-foreground mt-2">
          {t(
            `${monthName} ${tour.currentYear} airport passengers ${labelEn} ${monthName} ${tour.priorYear} (${fmtNumber(tour.currentPassengers)} vs ${fmtNumber(tour.priorPassengers)}).`,
            `Pasajeros del aeropuerto en ${monthName} ${tour.currentYear} ${labelEs} ${monthName} ${tour.priorYear} (${fmtNumber(tour.currentPassengers)} vs ${fmtNumber(tour.priorPassengers)}).`,
          )}
        </p>
        <p className="text-sm mt-3">{t(interpEn, interpEs)}</p>
      </CardContent>
    </Card>
  );
}

function ActionableGuidance({
  data, t,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
}) {
  const lvl = data.signals.availabilityLevel;
  const itemsEn = {
    high: ["Expect longer booking windows", "Pricing pressure trends downward", "Higher competition for guests"],
    moderate: ["Balanced market conditions", "Stable pricing expected", "Maintain current strategy"],
    low: ["Strong demand environment", "Pricing power increases", "Consider rate increases for unbooked nights"],
    unknown: ["Insufficient data for guidance", "Check back as more listings are scanned"],
  }[lvl];
  const itemsEs = {
    high: ["Espere ventanas de reserva más largas", "Presión a la baja en precios", "Mayor competencia por huéspedes"],
    moderate: ["Condiciones de mercado equilibradas", "Precios estables esperados", "Mantenga estrategia actual"],
    low: ["Entorno de demanda fuerte", "Mayor poder de fijación de precios", "Considere subir tarifas en noches no reservadas"],
    unknown: ["Datos insuficientes para guía", "Vuelva cuando se hayan escaneado más anuncios"],
  }[lvl];

  return (
    <Card className="glass-card">
      <CardHeader>
        <CardTitle className="font-display">
          {t("Actionable Guidance", "Guía Práctica")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-2">
          {itemsEn.map((en, i) => (
            <li key={en} className="flex items-start gap-2 text-sm">
              <span className="text-primary mt-1">•</span>
              <span>{t(en, itemsEs[i])}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function MarketSegmentation({
  data, t, lang,
}: {
  data: RentalMarketLive;
  t: (en: string, es: string) => string;
  lang: "en" | "es";
}) {
  const [expanded, setExpanded] = useState(false);

  if (data.neighborhoods.length === 0) {
    return null;
  }

  const labelEn = (lvl: Level) =>
    ({ high: "Soft demand", moderate: "Balanced", low: "Strong demand", unknown: "—" }[lvl]);
  const labelEs = (lvl: Level) =>
    ({ high: "Demanda débil", moderate: "Equilibrada", low: "Demanda fuerte", unknown: "—" }[lvl]);

  const visible = expanded ? data.neighborhoods : data.neighborhoods.slice(0, 5);
  const hasMore = data.neighborhoods.length > 5;

  return (
    <Card className="glass-card overflow-hidden">
      <CardHeader>
        <CardTitle className="font-display">
          {t("Market Segmentation", "Segmentación del Mercado")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t(
            "Top neighborhoods by tracked listing count. Sell-through = share of past 30-day inventory that booked; higher = stronger demand.",
            "Principales colonias por número de anuncios rastreados. Ventas = porcentaje del inventario de los últimos 30 días que se reservó; mayor = demanda más fuerte.",
          )}
        </p>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left">
          <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
            <tr>
              <th className="px-6 py-3">{t("Neighborhood", "Colonia")}</th>
              <th className="px-6 py-3 text-right">{t("Listings", "Anuncios")}</th>
              <th className="px-6 py-3 text-right">
                {t("Sell-through (past 30d)", "Ventas (últ. 30 días)")}
              </th>
              <th className="px-6 py-3 text-right">{t("Avg Nightly", "Promedio Noche")}</th>
              <th className="px-6 py-3">{t("Signal", "Señal")}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((n) => (
              <tr key={n.neighborhood} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                <td className="px-6 py-4 font-medium">{n.neighborhood}</td>
                <td className="px-6 py-4 text-right">{fmtNumber(n.listingCount)}</td>
                <td className="px-6 py-4 text-right">
                  {n.availabilityRate == null ? "—" : fmtPct(1 - n.availabilityRate, 1)}
                </td>
                <td className="px-6 py-4 text-right">{fmtUsd(n.avgPriceUsd)}</td>
                <td className="px-6 py-4">
                  <span className={
                    n.availabilityLevel === "low" ? "text-emerald-600 font-semibold"
                      : n.availabilityLevel === "high" ? "text-amber-600 font-semibold"
                        : "text-muted-foreground"
                  }>
                    {lang === "es" ? labelEs(n.availabilityLevel) : labelEn(n.availabilityLevel)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="px-6 py-3 border-t bg-secondary/20 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs gap-1"
          >
            {expanded ? (
              <>
                <ChevronUp className="w-3.5 h-3.5" />
                {t("Show less", "Mostrar menos")}
              </>
            ) : (
              <>
                <ChevronDown className="w-3.5 h-3.5" />
                {t(
                  `Show more (${data.neighborhoods.length - 5} more)`,
                  `Mostrar más (${data.neighborhoods.length - 5} más)`,
                )}
              </>
            )}
          </Button>
        </div>
      )}
    </Card>
  );
}

function AvailabilityTrendChart({
  series, t, lang, neighborhoods, selected, onChange, loading,
}: {
  series: AvailabilityTrendPoint[];
  t: (en: string, es: string) => string;
  lang: "en" | "es";
  neighborhoods: string[];
  selected: string;
  onChange: (v: string) => void;
  loading: boolean;
}) {
  const valid = series.filter((p) => p.availabilityRate != null) as Array<{
    date: string;
    availabilityRate: number;
  }>;

  // Forward-looking window: compare near-term availability (next 7 nights)
  // against the full 30-day window. Near-term tighter than the full window
  // => bookings are landing close-in => strengthening demand.
  let interpEn = "Availability over the next 30 days is loading…";
  let interpEs = "La disponibilidad de los próximos 30 días está cargando…";
  let fullPeriodAvg: number | null = null;
  if (valid.length >= 8) {
    const avg = (xs: { availabilityRate: number }[]) =>
      xs.reduce((s, p) => s + p.availabilityRate, 0) / xs.length;
    const nearTermAvg = avg(valid.slice(0, 7));
    fullPeriodAvg = avg(valid);
    const delta = nearTermAvg - fullPeriodAvg;

    const scope = selected === "all"
      ? { en: "Availability over the next 30 days", es: "La disponibilidad de los próximos 30 días" }
      : { en: `In ${selected}, availability over the next 30 days`, es: `En ${selected}, la disponibilidad de los próximos 30 días` };

    if (delta < -0.05) {
      interpEn = `${scope.en.replace(/^./, (c) => c.toUpperCase())} is tighter near-term than later dates, indicating strengthening demand.`;
      interpEs = `${scope.es.replace(/^./, (c) => c.toUpperCase())} es más limitada a corto plazo que en fechas posteriores, lo que indica una demanda más fuerte.`;
    } else if (delta > 0.05) {
      interpEn = `${scope.en.replace(/^./, (c) => c.toUpperCase())} is higher near-term than later dates, indicating weaker short-term demand.`;
      interpEs = `${scope.es.replace(/^./, (c) => c.toUpperCase())} es mayor a corto plazo que en fechas posteriores, lo que indica una demanda a corto plazo más débil.`;
    } else {
      interpEn = `${scope.en.replace(/^./, (c) => c.toUpperCase())} indicates stable demand.`;
      interpEs = `${scope.es.replace(/^./, (c) => c.toUpperCase())} indica una demanda estable.`;
    }
  }

  const chartData = valid.map((p) => ({
    date: p.date,
    rate: Number((p.availabilityRate * 100).toFixed(1)),
  }));

  const fmtAxisDate = (iso: string) => {
    const d = new Date(iso + "T00:00:00");
    const m = (lang === "es" ? MONTH_NAMES_ES : MONTH_NAMES_EN)[d.getMonth()].slice(0, 3);
    return `${m} ${d.getDate()}`;
  };

  const avgPct = fullPeriodAvg != null ? Number((fullPeriodAvg * 100).toFixed(1)) : null;

  return (
    <Card className="glass-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <CardTitle className="font-display text-base">
              {t("Next 30 Days Availability", "Disponibilidad — Próximos 30 Días")}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {t("(forward window)", "(ventana hacia adelante)")}
              </span>
            </CardTitle>
            <p className="text-sm mt-1">{t(interpEn, interpEs)}</p>
          </div>
          <div className="shrink-0">
            <Select value={selected} onValueChange={onChange}>
              <SelectTrigger className="w-[200px] h-9 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t("All neighborhoods", "Todos los barrios")}
                </SelectItem>
                {neighborhoods.map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {valid.length === 0 ? (
          <div className="h-64 w-full flex items-center justify-center text-sm text-muted-foreground">
            {loading
              ? t("Loading…", "Cargando…")
              : t(
                  "No forward availability data for this neighborhood yet.",
                  "Aún no hay datos de disponibilidad futura para este barrio.",
                )}
          </div>
        ) : (
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
              <defs>
                <linearGradient id="availTrendFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5eead4" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#5eead4" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={fmtAxisDate}
                tick={{ fontSize: 11, fill: "rgba(245,247,250,0.7)", fontWeight: 500, style: { textShadow: "none" } }}
                stroke="rgba(255,255,255,0.08)"
                tickLine={false}
                tickMargin={10}
                minTickGap={24}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 11, fill: "rgba(245,247,250,0.7)", fontWeight: 500, style: { textShadow: "none" } }}
                stroke="rgba(255,255,255,0.08)"
                tickLine={false}
                axisLine={false}
                width={44}
              />
              <Tooltip
                formatter={(v: number) => [`${v.toFixed(1)}%`, t("Availability", "Disponibilidad")]}
                labelFormatter={(l: string) => fmtAxisDate(l)}
                contentStyle={{
                  backgroundColor: "hsl(var(--popover))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Area
                type="monotone"
                dataKey="rate"
                stroke="#5eead4"
                strokeWidth={2.5}
                fill="url(#availTrendFill)"
                dot={false}
                activeDot={{ r: 5, fill: "#5eead4", stroke: "#0f172a", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function CTASection({ t }: { t: (en: string, es: string) => string }) {
  return (
    <Card className="glass-card bg-gradient-to-br from-primary/10 to-primary/5">
      <CardContent className="pt-6">
        <h3 className="text-xl font-display font-bold">
          {t("Apply this to your property", "Aplica esto a tu propiedad")}
        </h3>
        <p className="text-sm text-muted-foreground mt-2 max-w-xl">
          {t(
            "Use the pricing tool to generate a rate based on real-time demand, comparable listings, and availability trends.",
            "Usa la herramienta de precios para generar una tarifa basada en demanda en tiempo real, anuncios comparables y tendencias de disponibilidad.",
          )}
        </p>
        <Link href="/pricing-tool">
          <Button className="mt-4 gap-2">
            {t("Use Pricing Tool", "Usar Herramienta de Precios")}
            <ArrowRight className="w-4 h-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  );
}

function TrendIcon({ trend }: { trend: DemandTrend }) {
  if (trend === "increasing") return <TrendingUp className="w-4 h-4 text-emerald-600" />;
  if (trend === "decreasing") return <TrendingDown className="w-4 h-4 text-amber-600" />;
  if (trend === "stable") return <Minus className="w-4 h-4 text-muted-foreground" />;
  return <Minus className="w-4 h-4 text-muted-foreground" />;
}
