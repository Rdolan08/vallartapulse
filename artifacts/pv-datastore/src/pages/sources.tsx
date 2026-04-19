import { useEffect, useState } from "react";
import { useGetDataSources, useSyncDataSource } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { RefreshCw, ExternalLink, Database, Zap, Clock, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { format, formatDistanceToNow, isAfter, subHours, subDays } from "date-fns";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api-base";

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
  listingsTotal: number;
  // Airbnb-pricing-only fields (optional on other endpoints):
  listingsQuotedEver?: number;
  listingsNeverQuoted?: number;
  newestQuoteAt?: string | null;
  // VV-pricing-only:
  listingsCovered?: number;
  // VRBO + VV pricing:
  newestScrapeAt?: string | null;
  // Common:
  listingsStale14d: number;
}

interface PipelineCardConfig {
  endpoint: string;
  labelEn: string;
  labelEs: string;
  /** Where the "newest" timestamp lives in the response shape. */
  newestField: "newestQuoteAt" | "newestScrapeAt";
  /** Plain noun for the "newest" line. */
  newestLabelEn: string;
  newestLabelEs: string;
}

const PIPELINES: PipelineCardConfig[] = [
  {
    endpoint: "/api/ingest/airbnb-pricing-freshness",
    labelEn: "Airbnb pricing",
    labelEs: "Precios de Airbnb",
    newestField: "newestQuoteAt",
    newestLabelEn: "Newest quote",
    newestLabelEs: "Cotización más reciente",
  },
  {
    endpoint: "/api/ingest/vrbo-scrape-freshness",
    labelEn: "VRBO scrape",
    labelEs: "Extracción de VRBO",
    newestField: "newestScrapeAt",
    newestLabelEn: "Newest scrape",
    newestLabelEs: "Extracción más reciente",
  },
  {
    endpoint: "/api/ingest/vacation-vallarta-pricing-freshness",
    labelEn: "Vacation Vallarta pricing",
    labelEs: "Precios de Vacation Vallarta",
    newestField: "newestScrapeAt",
    newestLabelEn: "Newest refresh",
    newestLabelEs: "Actualización más reciente",
  },
];

/**
 * Pipeline-health card. Renders one freshness banner driven by a
 * pipeline-specific freshness endpoint. All endpoints share the same
 * `alertLevel` / `alertReason` / `listingsTotal` / `listingsStale14d`
 * vocabulary so a multi-day silent outage in any pricing pipeline is
 * visible within one cycle.
 */
function PipelineHealthCard({
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
    fetch(apiUrl(cfg.endpoint))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: PipelineFreshness) => {
        if (!cancelled) setData(j);
      })
      .catch(() => {
        if (!cancelled) setErrored(true);
      });
    return () => {
      cancelled = true;
    };
  }, [cfg.endpoint]);

  if (errored) return null;
  if (!data) {
    return <Skeleton className="h-20 rounded-xl" />;
  }

  const tone =
    data.alertLevel === "fail"
      ? "bg-destructive/10 border-destructive/40 text-destructive"
      : data.alertLevel === "warn"
        ? "bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300"
        : "bg-primary/5 border-primary/20 text-foreground";

  const Icon = data.alertLevel === "ok" ? CheckCircle2 : AlertCircle;
  const label = lang === "es" ? cfg.labelEs : cfg.labelEn;
  const newestRaw =
    (cfg.newestField === "newestQuoteAt" ? data.newestQuoteAt : data.newestScrapeAt) ?? null;

  const headline = t(
    `${label} — ${data.listingsStale14d} listings stale > 14 days`,
    `${label} — ${data.listingsStale14d} anuncios sin actualizar > 14 días`,
  );

  return (
    <div className={cn("flex items-start gap-3 rounded-xl border px-4 py-3 text-sm", tone)}>
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 space-y-1">
        <div className="font-medium">{headline}</div>
        <div className="text-xs opacity-80">
          {t("Cohort", "Cohorte")}: {data.listingsTotal.toLocaleString()} ·{" "}
          {lang === "es" ? cfg.newestLabelEs : cfg.newestLabelEn}:{" "}
          {newestRaw
            ? formatDistanceToNow(new Date(newestRaw), { addSuffix: true })
            : t("never", "nunca")}
        </div>
        {data.alertReason && (
          <div className="text-xs font-medium">{data.alertReason}</div>
        )}
      </div>
    </div>
  );
}

/**
 * Stack of pass/fail banners — one per pricing/calendar pipeline
 * (Airbnb, VRBO, Vacation Vallarta). Same shape signal across all
 * three so the dashboard never has a blind spot.
 */
function PipelinesHealth({
  t,
  lang,
}: {
  t: (en: string, es: string) => string;
  lang: "en" | "es";
}) {
  return (
    <div className="space-y-3 mb-6">
      {PIPELINES.map((cfg) => (
        <PipelineHealthCard key={cfg.endpoint} cfg={cfg} t={t} lang={lang} />
      ))}
    </div>
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
                    {/* Last synced */}
                    <div className="flex justify-between items-center py-2.5 border-b border-border/50">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        {t("Last Synced", "Última Sincronización")}
                      </span>
                      <span className={cn(
                        "font-medium text-xs flex items-center gap-1.5",
                        freshness === "fresh" && "text-primary",
                        freshness === "never" && "text-muted-foreground italic"
                      )}>
                        {source.lastSyncedAt
                          ? formatDistanceToNow(new Date(source.lastSyncedAt), { addSuffix: true })
                          : t("Never", "Nunca")}
                      </span>
                    </div>

                    {/* Records */}
                    <div className="flex justify-between items-center py-2.5 border-b border-border/50">
                      <span className="text-muted-foreground flex items-center gap-1.5">
                        <Database className="w-3 h-3" />
                        {t("Records", "Registros")}
                      </span>
                      <span className="font-medium tabular-nums">
                        {(source.recordCount ?? 0).toLocaleString()}
                      </span>
                    </div>

                    {/* Frequency */}
                    <div className="flex justify-between items-center py-2.5">
                      <span className="text-muted-foreground">
                        {t("Frequency", "Frecuencia")}
                      </span>
                      <span className="font-medium capitalize">
                        {source.frequency || "Manual"}
                      </span>
                    </div>
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
