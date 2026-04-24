import { useEffect, useState } from "react";
import { useGetDataSources, useSyncDataSource } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { RefreshCw, ExternalLink, Database, Zap, Clock, CheckCircle2, AlertCircle, Info, Activity } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { format, formatDistanceToNow, isAfter, subHours, subDays } from "date-fns";
import { cn } from "@/lib/utils";
import { apiUrl, apiFetch } from "@/lib/api-base";

function freshnessBadge(lastSyncedAt: string | null | undefined): "fresh" | "stale" | "never" {
  if (!lastSyncedAt) return "never";
  const date = new Date(lastSyncedAt);
  if (isAfter(date, subHours(new Date(), 24))) return "fresh";
  if (isAfter(date, subDays(new Date(), 7))) return "stale";
  return "stale";
}

interface PipelineFreshness {
  alertLevel: "ok" | "warn" | "fail";
  alertReason: string;
  listingsTotal?: number;
  // Airbnb-pricing-only fields (optional on other endpoints):
  listingsQuotedEver?: number;
  listingsNeverQuoted?: number;
  newestQuoteAt?: string | null;
  // Airbnb per-night quote activity over the last 24h. Surfaced in the
  // tooltip so the unavailable rows the new fast-path now writes aren't
  // misread as scrape failures, and so the booked-rate inference signal
  // is visible at a glance.
  quotesLast24h?: number;
  quotesPricedLast24h?: number;
  quotesUnavailableLast24h?: number;
  presumedBookingsLast24h?: number;
  // VV-pricing-only:
  listingsCovered?: number;
  // VRBO + VV pricing:
  newestScrapeAt?: string | null;
  // Common stale-counter (omitted for non-cohort pipelines like pricing-tool):
  listingsStale14d?: number;
  // Pricing-tool uptime probe (no cohort, just last successful smoke hit):
  lastSuccessAt?: string | null;
}

type PipelineMode = "cohort" | "uptime";

interface PipelineCardConfig {
  endpoint: string;
  labelEn: string;
  labelEs: string;
  /**
   * "cohort"  → headline is "{label} — N listings stale > 14 days"
   *             (Airbnb / VRBO / VV pricing pipelines).
   * "uptime"  → headline is "{label} — last successful check {ago}"
   *             (pricing-tool smoke probe; no listing cohort).
   */
  mode: PipelineMode;
  /** Where the "newest" timestamp lives in the response shape (cohort mode). */
  newestField?: "newestQuoteAt" | "newestScrapeAt";
  /** Plain noun for the "newest" line (cohort mode). */
  newestLabelEn?: string;
  newestLabelEs?: string;
  /**
   * Override status when the pipeline is intentionally not running (its
   * scheduler is paused, no adapter exists yet, etc.). When set, the
   * status light renders yellow with this label regardless of what the
   * freshness endpoint reports — the underlying alert is still surfaced
   * in the tooltip so nothing is hidden.
   */
  overrideStatus?: { kind: "paused" | "blocked" | "planned"; reasonEn: string; reasonEs: string };
}

const PIPELINES: PipelineCardConfig[] = [
  {
    // Airbnb CALENDAR — availability + nightly_price_usd written to
    // rental_prices_by_date by the Mac-mini-driven scraper. Operational
    // (run #2 on 2026-04-19 wrote 59,130 rows for 162/507 listings).
    // Distinct from the per-night QUOTE pipeline below, which is paused.
    endpoint: "/api/ingest/airbnb-calendar-freshness",
    labelEn: "Airbnb calendar",
    labelEs: "Calendario de Airbnb",
    mode: "cohort",
    newestField: "newestScrapeAt",
    newestLabelEn: "Newest scrape",
    newestLabelEs: "Extracción más reciente",
  },
  {
    // Airbnb LISTING BASELINE — rental_listings.nightly_price_usd refreshed
    // nightly by the detail-enrichment priority queue. This is the price
    // source the comp engine actually uses for Airbnb today
    // (priceSource='static_displayed'). Surfacing it explicitly so owners
    // don't read the paused per-night card below as "Airbnb pricing in
    // comps is stale" — the baseline that feeds comps IS fresh.
    endpoint: "/api/ingest/airbnb-baseline-freshness",
    labelEn: "Airbnb listing baseline (feeds comps)",
    labelEs: "Precio base de Airbnb (alimenta comparables)",
    mode: "cohort",
    newestField: "newestScrapeAt",
    newestLabelEn: "Newest baseline",
    newestLabelEs: "Base más reciente",
  },
  {
    // Airbnb per-night quotes — RE-ENABLED 2026-04-23. The GraphQL quote
    // adapter shipped, the unavailable fast-path landed in 68475e8, and
    // a daily cron at 09:00 UTC now feeds listing_price_quotes. The
    // tooltip surfaces both the priced/unavailable split (so the new
    // unavailable rows aren't misread as failures) and any presumed
    // bookings inferred over the last 24h.
    endpoint: "/api/ingest/airbnb-pricing-freshness",
    labelEn: "Airbnb per-night quotes",
    labelEs: "Cotizaciones por noche de Airbnb",
    mode: "cohort",
    newestField: "newestQuoteAt",
    newestLabelEn: "Newest quote",
    newestLabelEs: "Cotización más reciente",
  },
  {
    endpoint: "/api/ingest/pvrpv-pricing-freshness",
    labelEn: "PVRPV pricing",
    labelEs: "Precios de PVRPV",
    mode: "cohort",
    newestField: "newestQuoteAt",
    newestLabelEn: "Newest quote",
    newestLabelEs: "Cotización más reciente",
  },
  // VRBO pill removed 2026-04-23 — paused indefinitely (residential proxy
  // cannot defeat the anti-bot challenge). The freshness endpoint is
  // preserved for future re-enablement; just not surfaced on /sources
  // until VRBO discovery + pricing actually resume.
  {
    endpoint: "/api/ingest/vacation-vallarta-pricing-freshness",
    labelEn: "Vacation Vallarta pricing",
    labelEs: "Precios de Vacation Vallarta",
    mode: "cohort",
    newestField: "newestScrapeAt",
    newestLabelEn: "Newest refresh",
    newestLabelEs: "Actualización más reciente",
    overrideStatus: {
      kind: "planned",
      reasonEn: "Calendar adapter exists; no scheduled job wired yet",
      reasonEs: "El adaptador de calendario existe; aún no hay tarea programada",
    },
  },
  {
    endpoint: "/api/health/pricing-tool",
    labelEn: "Pricing tool",
    labelEs: "Herramienta de precios",
    mode: "uptime",
  },
];

/**
 * Compact status light for one pipeline. Renders a colored dot + label
 * inside the consolidated PipelinesHealth tile. Hover reveals the full
 * detail (status, last refresh, cohort, underlying alert reason) so the
 * tile stays tiny without hiding any information.
 *
 * Color rules:
 *   - yellow = source intentionally not active (paused / blocked / planned)
 *   - red    = source IS active and failing (alertLevel=fail)
 *   - yellow = source IS active and meaningfully degraded
 *             (alertLevel=warn AND fewer than 90% of the cohort is fresh)
 *   - green  = source IS active and healthy
 *             (alertLevel=ok, OR alertLevel=warn with >=90% of the cohort
 *              fresh — e.g. 4/125 stale on PVRPV is 96.8% fresh, which
 *              still earns a green dot. The "4 stale" detail surfaces in
 *              the tooltip so nothing is hidden.)
 */
function PipelineStatusLight({
  cfg,
  t,
  lang,
}: {
  cfg: PipelineCardConfig;
  t: (en: string, es: string) => string;
  lang: "en" | "es";
}) {
  const [data, setData] = useState<PipelineFreshness | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<PipelineFreshness>(cfg.endpoint)
      .then((j) => {
        if (!cancelled) setData(j);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cfg.endpoint]);

  const label = lang === "es" ? cfg.labelEs : cfg.labelEn;

  // ── Color + status pill derivation ──────────────────────────────────────
  let dotClass = "bg-muted-foreground/40";
  let statusEn: string;
  let statusEs: string;

  if (cfg.overrideStatus) {
    dotClass = "bg-amber-500";
    if (cfg.overrideStatus.kind === "paused") {
      statusEn = "Paused";
      statusEs = "Pausado";
    } else if (cfg.overrideStatus.kind === "blocked") {
      statusEn = "Blocked";
      statusEs = "Bloqueado";
    } else {
      statusEn = "Planned";
      statusEs = "Planeado";
    }
  } else if (errored || !data) {
    statusEn = errored ? "Unreachable" : "Loading…";
    statusEs = errored ? "Inaccesible" : "Cargando…";
    if (errored) dotClass = "bg-muted-foreground/40";
  } else if (data.alertLevel === "fail") {
    dotClass = "bg-red-500";
    statusEn = "Failing";
    statusEs = "Fallando";
  } else {
    // For cohort-mode pipelines (Airbnb/PVRPV/VRBO/VV pricing & VRBO scrape),
    // grade against the actual fresh ratio rather than the binary warn/ok
    // verdict — a tiny tail of stale rows shouldn't flip an otherwise
    // healthy pipeline to yellow alongside the paused vendors.
    const total = data.listingsTotal ?? 0;
    const stale = data.listingsStale14d ?? 0;
    const freshRatio = total > 0 ? (total - stale) / total : 1;
    const meaningfullyDegraded =
      cfg.mode === "cohort" ? data.alertLevel === "warn" && freshRatio < 0.9 : data.alertLevel === "warn";

    if (meaningfullyDegraded) {
      dotClass = "bg-amber-500";
      statusEn = "Degraded";
      statusEs = "Degradado";
    } else {
      dotClass = "bg-emerald-500";
      statusEn = "Healthy";
      statusEs = "Sano";
    }
  }

  // ── Tooltip body — last refresh, cohort, alert reason, override note ────
  const tooltipLines: string[] = [];
  tooltipLines.push(`${t("Status", "Estado")}: ${t(statusEn, statusEs)}`);

  if (cfg.overrideStatus) {
    tooltipLines.push(
      `${t("Reason", "Motivo")}: ${
        lang === "es" ? cfg.overrideStatus.reasonEs : cfg.overrideStatus.reasonEn
      }`,
    );
  }

  if (data) {
    if (cfg.mode === "uptime") {
      const ts = data.lastSuccessAt ?? null;
      tooltipLines.push(
        `${t("Last successful check", "Última verificación exitosa")}: ${
          ts ? formatDistanceToNow(new Date(ts), { addSuffix: true }) : t("never", "nunca")
        }`,
      );
    } else {
      const newestRaw =
        (cfg.newestField === "newestQuoteAt" ? data.newestQuoteAt : data.newestScrapeAt) ?? null;
      const newestText = newestRaw
        ? formatDistanceToNow(new Date(newestRaw), { addSuffix: true })
        : t("never", "nunca");
      const total = data.listingsTotal ?? 0;
      const stale = data.listingsStale14d ?? 0;
      tooltipLines.push(
        `${t("Cohort", "Cohorte")}: ${total.toLocaleString()} · ${t("stale > 14d", "sin actualizar > 14d")}: ${stale}`,
      );
      tooltipLines.push(
        `${lang === "es" ? cfg.newestLabelEs : cfg.newestLabelEn}: ${newestText}`,
      );

      // Airbnb per-night quote activity (only present on the
      // /airbnb-pricing-freshness response). Surfaces the
      // priced/unavailable split so the new fast-path's "unavailable"
      // rows aren't misread as failures, plus today's booked-rate
      // inferences.
      if (typeof data.quotesLast24h === "number") {
        const priced = data.quotesPricedLast24h ?? 0;
        const unavailable = data.quotesUnavailableLast24h ?? 0;
        tooltipLines.push(
          `${t("Quotes (24h)", "Cotizaciones (24h)")}: ${data.quotesLast24h.toLocaleString()} (${priced.toLocaleString()} ${t("priced", "con precio")} · ${unavailable.toLocaleString()} ${t("unavailable", "no disponible")})`,
        );
      }
      if (typeof data.presumedBookingsLast24h === "number") {
        tooltipLines.push(
          `${t("Inferred bookings (24h)", "Reservas inferidas (24h)")}: ${data.presumedBookingsLast24h.toLocaleString()}`,
        );
      }
    }
    if (data.alertReason) {
      tooltipLines.push(`${t("Underlying", "Subyacente")}: ${data.alertReason}`);
    }
  } else if (errored) {
    tooltipLines.push(t("Freshness endpoint unreachable", "Endpoint de actualidad inaccesible"));
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex items-center gap-2 text-xs cursor-default">
          <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", dotClass)} aria-hidden />
          <span className="font-medium">{label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs whitespace-pre-line">
        {tooltipLines.join("\n")}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Compact pipeline-health tile. One line per pipeline (colored dot +
 * label), hover for details. Replaces the previous stack of full-width
 * banners — all six pipelines now fit inside a single tile that matches
 * the visual density of the rest of the page.
 */
function PipelinesHealth({
  t,
  lang,
}: {
  t: (en: string, es: string) => string;
  lang: "en" | "es";
}) {
  return (
    <TooltipProvider delayDuration={150}>
      <div className="rounded-xl border border-border/40 bg-card/40 px-4 py-3 mb-6">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-3">
          <Activity className="w-3.5 h-3.5" />
          {t("Pipeline status", "Estado de pipelines")}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-4 gap-y-2">
          {PIPELINES.map((cfg) => (
            <PipelineStatusLight key={cfg.endpoint} cfg={cfg} t={t} lang={lang} />
          ))}
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * Data quality panel for `rental_prices_by_date`.
 *
 * Surfaces the wholesomeness profile of the underlying price table —
 * total rows, suspicious-price counts (zero / <$20 / >$5,000), past-
 * dated rows, and scrape-age — broken out by source platform plus an
 * ALL row. Backed by `/api/ingest/rental-prices-quality`.
 *
 * Footer documents the daily age-based retention sweep so it's
 * obvious WHY past-date and stale-row counts shouldn't grow without
 * bound: the sweep deletes them on a 7-day / 90-day cadence,
 * strictly age-based, never triggered by scrape failure.
 */
interface QualityPlatform {
  sourcePlatform: string;
  totalRows: number;
  // Optional — older API deploys (before the active-cohort retrofit) don't
  // return this field. Frontend must tolerate `undefined` during the
  // Vercel-vs-Railway deploy gap, otherwise the whole panel crashes.
  distinctListings?: number;
  nullPrice: number;
  zeroPrice: number;
  lowPrice: number;
  plausiblePrice: number;
  highPrice: number;
  suspiciousTotal: number;
  pastDated: number;
  scraped30dPlus: number;
  scraped60dPlus: number;
  scraped90dPlus: number;
  oldestScrapeAt: string | null;
  newestScrapeAt: string | null;
  alertLevel: "ok" | "warn" | "fail";
}

/**
 * Pricing-coverage panel — listing-level health, NOT row counts.
 *
 * Source-of-truth: backend `/api/ingest/pricing-coverage` endpoint, which
 * UNIONs both price tables (rental_prices_by_date + listing_price_quotes)
 * to count distinct active listings priced in the last 7 days.
 *
 * Reads the only number that matters operationally: how many of the
 * active listings I track actually have an actionable price right now?
 *
 * Future extension: same backend query reshaped with
 * `GROUP BY normalized_neighborhood_bucket` for zone drill-down.
 */
interface CoveragePlatform {
  sourcePlatform: string;
  activeListings: number;
  pricedCalendar: number;
  pricedQuote: number;
  pricedAny: number;
  pctCovered: number;
}

function PricingCoveragePanel({
  t,
}: {
  t: (en: string, es: string) => string;
}) {
  const [data, setData] = useState<{ window: string; platforms: CoveragePlatform[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiFetch("/api/ingest/pricing-coverage");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { window: string; platforms: CoveragePlatform[] };
        if (!cancelled) setData(j);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const platforms = data?.platforms ?? [];
  const all = platforms.find((p) => p.sourcePlatform === "ALL");
  const perPlatform = platforms.filter((p) => p.sourcePlatform !== "ALL");

  // Headline color: green ≥80%, amber 30–79%, red <30%
  const headlineColor =
    all == null
      ? "text-muted-foreground"
      : all.pctCovered >= 80
        ? "text-emerald-400"
        : all.pctCovered >= 30
          ? "text-amber-400"
          : "text-red-400";

  return (
    <div className="rounded-2xl border border-border/40 bg-card/30 p-4 mb-4">
      <div className="flex items-baseline justify-between mb-3">
        <div className="text-xs uppercase tracking-wider text-muted-foreground font-semibold flex items-center gap-2">
          <Database className="w-3.5 h-3.5" />
          {t("Pricing coverage — active listings", "Cobertura de precios — anuncios activos")}
        </div>
        {all && (
          <div className={cn("text-xs", headlineColor)}>
            <span className="font-semibold tabular-nums">
              {all.pricedAny.toLocaleString()}
            </span>
            <span className="text-muted-foreground"> {t("of", "de")} </span>
            <span className="font-semibold tabular-nums">
              {all.activeListings.toLocaleString()}
            </span>
            <span className="text-muted-foreground"> {t("priced", "con precio")} </span>
            <span className="font-semibold tabular-nums">
              ({all.pctCovered.toFixed(1)}%)
            </span>
            <span className="text-muted-foreground"> · {t("last 7d", "últimos 7d")}</span>
          </div>
        )}
      </div>

      {loading && (
        <div className="text-xs text-muted-foreground py-2">
          {t("Loading…", "Cargando…")}
        </div>
      )}
      {err && (
        <div className="text-xs text-red-400 py-2">
          {t("Failed to load: ", "Error al cargar: ")}
          {err}
        </div>
      )}

      {!loading && !err && perPlatform.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-muted-foreground border-b border-border/30">
                <th className="text-left py-1 pr-3 font-medium">{t("Platform", "Plataforma")}</th>
                <th className="text-right py-1 px-2 font-medium">{t("Active", "Activos")}</th>
                <th className="text-right py-1 px-2 font-medium">{t("Priced (any source)", "Con precio (cualquier fuente)")}</th>
                <th className="text-right py-1 px-2 font-medium">{t("% covered", "% cubierto")}</th>
                <th className="text-right py-1 px-2 font-medium text-muted-foreground/70">{t("via calendar", "vía calendario")}</th>
                <th className="text-right py-1 px-2 font-medium text-muted-foreground/70">{t("via quotes", "vía cotizaciones")}</th>
              </tr>
            </thead>
            <tbody>
              {perPlatform.map((p) => {
                const rowColor =
                  p.pctCovered >= 80
                    ? "text-emerald-400"
                    : p.pctCovered >= 30
                      ? "text-amber-400"
                      : "text-red-400";
                return (
                  <tr key={p.sourcePlatform} className="border-b border-border/10 last:border-0">
                    <td className="py-1.5 pr-3 font-mono">{p.sourcePlatform}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-foreground">{p.activeListings.toLocaleString()}</td>
                    <td className={cn("py-1.5 px-2 text-right tabular-nums font-medium", rowColor)}>{p.pricedAny.toLocaleString()}</td>
                    <td className={cn("py-1.5 px-2 text-right tabular-nums font-medium", rowColor)}>{p.pctCovered.toFixed(1)}%</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground/70">{p.pricedCalendar.toLocaleString()}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground/70">{p.pricedQuote.toLocaleString()}</td>
                  </tr>
                );
              })}
              {all && (
                <tr className="border-t-2 border-border/30 font-medium">
                  <td className="py-1.5 pr-3 font-mono">{all.sourcePlatform}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-foreground">{all.activeListings.toLocaleString()}</td>
                  <td className={cn("py-1.5 px-2 text-right tabular-nums", headlineColor)}>{all.pricedAny.toLocaleString()}</td>
                  <td className={cn("py-1.5 px-2 text-right tabular-nums", headlineColor)}>{all.pctCovered.toFixed(1)}%</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground/70">{all.pricedCalendar.toLocaleString()}</td>
                  <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground/70">{all.pricedQuote.toLocaleString()}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DataQualityPanel({
  t,
  lang,
}: {
  t: (en: string, es: string) => string;
  lang: "en" | "es";
}) {
  const [data, setData] = useState<{ platforms: QualityPlatform[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    apiFetch("/api/ingest/rental-prices-quality")
      .then((j) => {
        if (alive) {
          setData(j);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setErr(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const platforms = data?.platforms ?? [];
  const all = platforms.find((p) => p.sourcePlatform === "ALL");
  const perPlatform = platforms.filter((p) => p.sourcePlatform !== "ALL");

  return (
    <TooltipProvider delayDuration={150}>
      <div className="rounded-xl border border-border/40 bg-card/40 px-4 py-3 mb-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            <Database className="w-3.5 h-3.5" />
            {t("Data quality — pricing tables", "Calidad de datos — tablas de precios")}
          </div>
          {all && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-[11px] font-medium px-2 py-0.5 rounded-full cursor-help",
                    all.alertLevel === "ok" && "bg-emerald-500/10 text-emerald-400",
                    all.alertLevel === "warn" && "bg-amber-500/10 text-amber-400",
                    all.alertLevel === "fail" && "bg-red-500/10 text-red-400",
                  )}
                >
                  {all.suspiciousTotal === 0
                    ? t("0 suspicious prices", "0 precios sospechosos")
                    : t(
                        `${all.suspiciousTotal.toLocaleString()} suspicious prices`,
                        `${all.suspiciousTotal.toLocaleString()} precios sospechosos`,
                      )}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm text-xs">
                {t(
                  "Suspicious = zero-priced + under $20 + over $5,000. The healthy bucket ($20–$5,000) and null-price (Airbnb's calendar legitimately omits price for many days) are excluded.",
                  "Sospechoso = precio cero + menos de $20 + más de $5,000. El rango sano ($20–$5,000) y los precios nulos (el calendario de Airbnb omite precio en muchos días, lo cual es legítimo) se excluyen.",
                )}
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {loading && (
          <div className="text-xs text-muted-foreground">
            {t("Loading data quality profile…", "Cargando perfil de calidad…")}
          </div>
        )}
        {err && (
          <div className="text-xs text-red-400">
            {t(`Failed to load: ${err}`, `Error al cargar: ${err}`)}
          </div>
        )}

        {!loading && !err && perPlatform.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-muted-foreground border-b border-border/30">
                  <th className="text-left py-1 pr-3 font-medium">{t("Platform", "Plataforma")}</th>
                  <th className="text-right py-1 px-2 font-medium">{t("Listings", "Anuncios")}</th>
                  <th className="text-right py-1 px-2 font-medium">{t("Total rows", "Filas totales")}</th>
                  <th className="text-right py-1 px-2 font-medium">{t("Plausible", "Plausibles")}</th>
                  <th className="text-right py-1 px-2 font-medium">{t("Null price", "Precio nulo")}</th>
                  <th className="text-right py-1 px-2 font-medium text-amber-400">{t("Suspicious", "Sospechosos")}</th>
                  <th className="text-right py-1 px-2 font-medium">{t("Past-dated", "Fecha pasada")}</th>
                  <th className="text-right py-1 px-2 font-medium">{t(">30d / >60d / >90d", ">30d / >60d / >90d")}</th>
                  <th className="text-left py-1 pl-2 font-medium">{t("Oldest scrape", "Extracción más antigua")}</th>
                </tr>
              </thead>
              <tbody>
                {perPlatform.map((p) => {
                  const isAirbnb = p.sourcePlatform === "airbnb";
                  return (
                  <tr key={p.sourcePlatform} className="border-b border-border/10 last:border-0">
                    <td className="py-1.5 pr-3 font-mono">{p.sourcePlatform}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-medium text-foreground">
                      {typeof p.distinctListings === "number" ? p.distinctListings.toLocaleString() : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{p.totalRows.toLocaleString()}</td>
                    <td
                      className={cn(
                        "py-1.5 px-2 text-right tabular-nums",
                        isAirbnb ? "text-muted-foreground/60" : "text-emerald-400",
                      )}
                      title={isAirbnb ? "Airbnb's calendar feed returns availability only; nightly prices live in rental_price_quotes." : undefined}
                    >
                      {isAirbnb ? "—" : p.plausiblePrice.toLocaleString()}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{p.nullPrice.toLocaleString()}</td>
                    <td
                      className={cn(
                        "py-1.5 px-2 text-right tabular-nums font-medium",
                        isAirbnb
                          ? "text-muted-foreground/60"
                          : p.suspiciousTotal === 0
                            ? "text-muted-foreground"
                            : "text-red-400",
                      )}
                      title={isAirbnb ? "N/A — no nightly prices in this table for Airbnb (see tooltip on Plausible)." : undefined}
                    >
                      {isAirbnb
                        ? "—"
                        : p.suspiciousTotal === 0
                          ? "0"
                          : `${p.zeroPrice}/${p.lowPrice}/${p.highPrice}`}
                    </td>
                    <td className={cn(
                      "py-1.5 px-2 text-right tabular-nums",
                      p.pastDated === 0 ? "text-muted-foreground" : "text-amber-400",
                    )}>
                      {p.pastDated.toLocaleString()}
                    </td>
                    <td className={cn(
                      "py-1.5 px-2 text-right tabular-nums",
                      p.scraped90dPlus === 0 ? "text-muted-foreground" : "text-red-400",
                    )}>
                      {p.scraped30dPlus.toLocaleString()} / {p.scraped60dPlus.toLocaleString()} / {p.scraped90dPlus.toLocaleString()}
                    </td>
                    <td className="py-1.5 pl-2 text-muted-foreground">
                      {p.oldestScrapeAt
                        ? formatDistanceToNow(new Date(p.oldestScrapeAt), { addSuffix: true })
                        : "—"}
                    </td>
                  </tr>
                  );
                })}
                {all && (
                  <tr className="border-t-2 border-border/30 font-medium">
                    <td className="py-1.5 pr-3 font-mono">{all.sourcePlatform}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-foreground">
                      {typeof all.distinctListings === "number" ? all.distinctListings.toLocaleString() : "—"}
                    </td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{all.totalRows.toLocaleString()}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-emerald-400">{all.plausiblePrice.toLocaleString()}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">{all.nullPrice.toLocaleString()}</td>
                    <td className={cn(
                      "py-1.5 px-2 text-right tabular-nums",
                      all.suspiciousTotal === 0 ? "text-muted-foreground" : "text-red-400",
                    )}>
                      {all.suspiciousTotal === 0
                        ? "0"
                        : `${all.zeroPrice}/${all.lowPrice}/${all.highPrice}`}
                    </td>
                    <td className={cn(
                      "py-1.5 px-2 text-right tabular-nums",
                      all.pastDated === 0 ? "text-muted-foreground" : "text-amber-400",
                    )}>
                      {all.pastDated.toLocaleString()}
                    </td>
                    <td className={cn(
                      "py-1.5 px-2 text-right tabular-nums",
                      all.scraped90dPlus === 0 ? "text-muted-foreground" : "text-red-400",
                    )}>
                      {all.scraped30dPlus.toLocaleString()} / {all.scraped60dPlus.toLocaleString()} / {all.scraped90dPlus.toLocaleString()}
                    </td>
                    <td className="py-1.5 pl-2 text-muted-foreground">
                      {all.oldestScrapeAt
                        ? formatDistanceToNow(new Date(all.oldestScrapeAt), { addSuffix: true })
                        : "—"}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-3 pt-2 border-t border-border/20 text-[10px] text-muted-foreground leading-relaxed">
          <span className="font-semibold uppercase tracking-wider">{t("Retention sweep", "Limpieza de retención")}:</span>{" "}
          {t(
            "daily 08:00 UTC — DELETE rows where date < CURRENT_DATE − 7 days OR scraped_at < NOW() − 90 days. Strictly age-based: a failed scrape never triggers a delete; missing replacement data never triggers a delete. Per-rule per-platform delete counts are logged so a quietly-dying source surfaces as a non-zero stale-row count instead of a mysterious row-count drop.",
            "diaria 08:00 UTC — DELETE filas donde date < CURRENT_DATE − 7 días O scraped_at < NOW() − 90 días. Estrictamente por edad: un scrape fallido nunca dispara un delete; la ausencia de datos de reemplazo nunca dispara un delete. Las cuentas de borrado por regla y por plataforma se registran para que una fuente que muere silenciosamente aparezca como un contador de filas obsoletas distinto de cero, en vez de una caída misteriosa del total.",
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

export default function Sources() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const { data, isLoading, error, refetch } = useGetDataSources();
  const syncMutation = useSyncDataSource();
  const [syncingAll, setSyncingAll] = useState(false);

  const handleSync = (id: number, name: string) => {
    syncMutation.mutate(
      { id },
      {
        onSuccess: (result: { message?: string }) => {
          toast({
            title: t("Sync Complete", "Sincronización Completa"),
            description: result?.message ?? `${name} ${t("has been updated.", "ha sido actualizado.")}`,
          });
          refetch();
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: t("Sync Failed", "Sincronización Fallida"),
            description: t("An error occurred during synchronization.", "Ocurrió un error durante la sincronización."),
          });
        },
      }
    );
  };

  const handleSyncAll = async () => {
    setSyncingAll(true);
    try {
      const res = await fetch(apiUrl("/api/sources/sync-all"), { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        toast({
          title: t("All Sources Synced", "Todas las Fuentes Sincronizadas"),
          description: t(
            `${json.totalSources} sources refreshed.`,
            `${json.totalSources} fuentes actualizadas.`
          ),
        });
        refetch();
      } else {
        throw new Error(json.error ?? "Unknown error");
      }
    } catch {
      toast({
        variant: "destructive",
        title: t("Sync Failed", "Sincronización Fallida"),
        description: t("Could not sync all sources.", "No se pudieron sincronizar todas las fuentes."),
      });
    } finally {
      setSyncingAll(false);
    }
  };

  const totalRecords = data?.reduce((sum, s) => sum + (s.recordCount ?? 0), 0) ?? 0;
  const activeSources = data?.filter((s) => s.status === "active").length ?? 0;

  return (
    <PageWrapper>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-8">
        <div className="space-y-1">
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t("Data Sources Registry", "Registro de Fuentes de Datos")}
          </h1>
          <p className="text-muted-foreground">
            {t(
              "Manage and sync all external data integrations powering VallartaPulse.",
              "Administra y sincroniza las integraciones de datos que alimentan VallartaPulse."
            )}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {data && (
            <div className="hidden sm:flex items-center gap-4 text-sm text-muted-foreground border border-border/40 rounded-xl px-4 py-2 bg-card/40">
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-primary" />
                {activeSources} {t("active", "activas")}
              </span>
              <span className="w-px h-4 bg-border/50" />
              <span className="flex items-center gap-1.5">
                <Database className="w-3.5 h-3.5 text-primary" />
                {totalRecords.toLocaleString()} {t("records", "registros")}
              </span>
            </div>
          )}
          <Button
            onClick={handleSyncAll}
            disabled={syncingAll || isLoading}
            className="gap-2 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Zap className={cn("w-4 h-4", syncingAll && "animate-pulse")} />
            {syncingAll
              ? t("Syncing…", "Sincronizando…")
              : t("Sync All", "Sincronizar Todo")}
          </Button>
        </div>
      </div>

      {/* ── Pipeline health banners (Airbnb / VRBO / VV) ───────────── */}
      <PipelinesHealth t={t} lang={lang as "en" | "es"} />

      <PricingCoveragePanel t={t} />

      <DataQualityPanel t={t} lang={lang as "en" | "es"} />

      {/* ── Info banner ─────────────────────────────────────────────── */}
      <div className="flex items-start gap-3 bg-primary/5 border border-primary/15 rounded-xl px-4 py-3 mb-8 text-sm text-muted-foreground">
        <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
        <span>
          {t(
            "Sources backed by live database tables (DATATUR, SESNSP, GAP Airport, Airbnb/VRBO, Weather, Economic) recount records automatically on sync. Government and satellite sources (Transparencia PV, NASA, INEGI, OSM) refresh their timestamp — records update when new data is manually uploaded or a scraper pipeline runs.",
            "Las fuentes vinculadas a tablas en vivo (DATATUR, SESNSP, GAP Aeropuerto, Airbnb/VRBO, Clima, Económico) recontan registros automáticamente. Las fuentes gubernamentales y satelitales actualizan su marca de tiempo — los registros se actualizan con carga manual o pipeline de scraper."
          )}
        </span>
      </div>

      {/* ── Grid ────────────────────────────────────────────────────── */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <AlertCircle className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
          <div className="text-muted-foreground font-medium">
            {t("API endpoint not connected.", "Endpoint de API no conectado.")}
          </div>
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {data.map((source) => {
            const isSyncing = syncMutation.isPending && syncMutation.variables?.id === source.id;
            const freshness = freshnessBadge(source.lastSyncedAt);

            return (
              <Card key={source.id} className="glass-card flex flex-col">
                <CardHeader className="pb-4">
                  <div className="flex justify-between items-start mb-2">
                    <Badge
                      variant="outline"
                      className="bg-secondary/50 text-[10px] font-bold uppercase tracking-wider"
                    >
                      {source.category}
                    </Badge>
                    <Badge
                      variant={
                        source.status === "active"
                          ? "success"
                          : source.status === "error"
                          ? "destructive"
                          : "warning"
                      }
                    >
                      {source.status}
                    </Badge>
                  </div>
                  <CardTitle className="text-xl font-display leading-tight">
                    {lang === "es" && source.nameEs ? source.nameEs : source.name}
                  </CardTitle>
                  <p className="text-sm text-muted-foreground line-clamp-2 mt-2">
                    {lang === "es" && source.descriptionEs
                      ? source.descriptionEs
                      : source.description}
                  </p>
                </CardHeader>

                <CardContent className="flex-1">
                  <div className="space-y-0 text-sm">
                    {(() => {
                      // Two card layouts depending on whether the source is
                      // record-counted (lives in our DB) or a reference link
                      // (Inmuebles24 / NASA / OSM / Transparencia PV — these
                      // have recordCount=null in the API response).
                      const isReference = source.recordCount == null;
                      const syncedText = source.lastSyncedAt
                        ? format(new Date(source.lastSyncedAt), "MMM d, yyyy")
                        : t("Never", "Nunca");
                      const syncedAgo = source.lastSyncedAt
                        ? formatDistanceToNow(new Date(source.lastSyncedAt), { addSuffix: true })
                        : null;

                      if (isReference) {
                        // Reference / external-link source: one combined
                        // "Last verified — Apr 19, 2026" line, plus frequency.
                        // No Records row (there's nothing to count).
                        return (
                          <>
                            <div className="flex justify-between items-center py-2.5 border-b border-border/50">
                              <span className="text-muted-foreground flex items-center gap-1.5">
                                <Clock className="w-3 h-3" />
                                {t("Last verified", "Última verificación")}
                              </span>
                              <span className={cn(
                                "font-medium text-xs",
                                freshness === "fresh" && "text-primary",
                                freshness === "never" && "text-muted-foreground italic",
                              )}>
                                {syncedText}
                              </span>
                            </div>
                            <div className="flex justify-between items-center py-2.5 border-b border-border/50">
                              <span className="text-muted-foreground flex items-center gap-1.5">
                                <Database className="w-3 h-3" />
                                {t("Type", "Tipo")}
                              </span>
                              <span className="font-medium text-xs italic text-muted-foreground">
                                {t("External reference", "Referencia externa")}
                              </span>
                            </div>
                            <div className="flex justify-between items-center py-2.5">
                              <span className="text-muted-foreground">
                                {t("Frequency", "Frecuencia")}
                              </span>
                              <span className="font-medium capitalize">
                                {source.frequency || "Manual"}
                              </span>
                            </div>
                          </>
                        );
                      }

                      // Counted source: original 3-row layout (Last Synced
                      // relative + Records count + Frequency).
                      return (
                        <>
                          <div className="flex justify-between items-center py-2.5 border-b border-border/50">
                            <span className="text-muted-foreground flex items-center gap-1.5">
                              <Clock className="w-3 h-3" />
                              {t("Last Synced", "Última Sincronización")}
                            </span>
                            <span className={cn(
                              "font-medium text-xs flex items-center gap-1.5",
                              freshness === "fresh" && "text-primary",
                              freshness === "never" && "text-muted-foreground italic",
                            )}>
                              {syncedAgo ?? t("Never", "Nunca")}
                            </span>
                          </div>
                          <div className="flex justify-between items-center py-2.5 border-b border-border/50">
                            <span className="text-muted-foreground flex items-center gap-1.5">
                              <Database className="w-3 h-3" />
                              {t("Records", "Registros")}
                            </span>
                            <span className="font-medium tabular-nums">
                              {(source.recordCount ?? 0).toLocaleString()}
                            </span>
                          </div>
                          <div className="flex justify-between items-center py-2.5">
                            <span className="text-muted-foreground">
                              {t("Frequency", "Frecuencia")}
                            </span>
                            <span className="font-medium capitalize">
                              {source.frequency || "Manual"}
                            </span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </CardContent>

                <CardFooter className="pt-4 border-t border-border/50 gap-3">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => handleSync(source.id, source.name)}
                    disabled={isSyncing}
                  >
                    <RefreshCw className={cn("w-4 h-4 mr-2", isSyncing && "animate-spin")} />
                    {isSyncing ? t("Syncing…", "Sincronizando…") : t("Sync Now", "Sincronizar")}
                  </Button>
                  {source.url && (
                    <Button variant="ghost" size="icon" asChild>
                      <a href={source.url} target="_blank" rel="noopener noreferrer" title={t("Open source", "Abrir fuente")}>
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t("No data sources configured.", "No hay fuentes de datos configuradas.")}
        </div>
      )}
    </PageWrapper>
  );
}
