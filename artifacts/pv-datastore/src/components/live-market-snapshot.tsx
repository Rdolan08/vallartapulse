import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, Activity, Home, DollarSign, Layers } from "lucide-react";
import { useLanguage } from "@/contexts/language-context";
import { apiFetch } from "@/lib/api-base";
import { Skeleton } from "@/components/ui/skeleton";

type LiveData = {
  generatedAt: string;
  recent: { availableNights: number; totalNights: number; availabilityPct: number };
  signals: { availabilityTrendPct: number };
  bySource: Array<{ source: string; listingsPriced: number; avgPriceUsd: number }>;
  byBedBath: Array<{
    bedrooms: number;
    bathrooms: number;
    listingCount: number;
    avgPriceUsd: number;
    mostPopular: boolean;
  }>;
  freshness: { hoursSinceLastUpdate: number | null };
};

function fmtUsd(n: number) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function LiveMarketSnapshot() {
  const { t } = useLanguage();
  const [data, setData] = useState<LiveData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/metrics/rental-market-live")
      .then((res) => res.json())
      .then((d: LiveData) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return null;

  if (!data) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <Skeleton className="h-6 w-48 mb-4" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      </div>
    );
  }

  const top = data.byBedBath.find((b) => b.mostPopular) ?? data.byBedBath[0];
  const airbnb = data.bySource.find((s) => s.source === "airbnb");
  const pvrpv = data.bySource.find((s) => s.source === "pvrpv");
  const fresh = data.freshness.hoursSinceLastUpdate;
  const freshLabel =
    fresh == null
      ? t("Awaiting data", "Esperando datos")
      : fresh < 1
      ? t("Updated <1h ago", "Actualizado <1h")
      : fresh < 48
      ? t(`Updated ${Math.round(fresh)}h ago`, `Actualizado hace ${Math.round(fresh)}h`)
      : t(`${Math.round(fresh)}h since last update`, `${Math.round(fresh)}h desde actualización`);
  const isFresh = fresh != null && fresh < 48;

  return (
    <Link href="/rental-market" className="block group">
      <div
        className="relative overflow-hidden rounded-2xl p-5 lg:p-6 transition-all group-hover:border-primary/40"
        style={{
          background:
            "linear-gradient(135deg, rgba(0,194,168,0.08) 0%, rgba(10,30,39,0.6) 60%)",
          border: "1px solid rgba(0,194,168,0.20)",
        }}
      >
        {/* Header strip */}
        <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2.5 w-2.5">
              {isFresh && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
              )}
              <span
                className={`relative inline-flex rounded-full h-2.5 w-2.5 ${
                  isFresh ? "bg-emerald-400" : "bg-amber-400"
                }`}
              />
            </span>
            <span className="text-xs font-bold uppercase tracking-widest text-primary">
              {t("Live Market Snapshot", "Vista en Vivo del Mercado")}
            </span>
            <span className="text-xs text-muted-foreground hidden sm:inline">· {freshLabel}</span>
          </div>
          <span className="flex items-center gap-1 text-xs font-semibold text-primary group-hover:gap-2 transition-all">
            {t("Open Rental Market", "Abrir Mercado de Renta")}
            <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </div>

        {/* 4 tiles */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
          {/* Availability */}
          <Tile
            icon={<Activity className="w-4 h-4" />}
            label={t("Availability — Next 30d", "Disponibilidad — Próx. 30d")}
            value={`${data.recent.availabilityPct.toFixed(1)}%`}
            sub={
              data.signals.availabilityTrendPct >= 0
                ? t(
                    `+${data.signals.availabilityTrendPct.toFixed(1)} pts vs days 31-60`,
                    `+${data.signals.availabilityTrendPct.toFixed(1)} pts vs días 31-60`,
                  )
                : t(
                    `${data.signals.availabilityTrendPct.toFixed(1)} pts vs days 31-60`,
                    `${data.signals.availabilityTrendPct.toFixed(1)} pts vs días 31-60`,
                  )
            }
          />

          {/* Most popular config */}
          {top && (
            <Tile
              icon={<Home className="w-4 h-4" />}
              label={t("Most Popular Config", "Configuración Más Común")}
              value={`${top.bedrooms}BR/${top.bathrooms}BA`}
              sub={`${fmtUsd(top.avgPriceUsd)}/${t("nt", "nt")} · ${top.listingCount.toLocaleString(
                "en-US",
              )} ${t("listings", "anuncios")}`}
            />
          )}

          {/* Airbnb avg */}
          {airbnb && (
            <Tile
              icon={<DollarSign className="w-4 h-4" />}
              label={t("Airbnb Avg Nightly", "Promedio Airbnb")}
              value={fmtUsd(airbnb.avgPriceUsd)}
              sub={`${airbnb.listingsPriced.toLocaleString("en-US")} ${t(
                "listings priced",
                "con precio",
              )}`}
            />
          )}

          {/* PVRPV avg */}
          {pvrpv && (
            <Tile
              icon={<Layers className="w-4 h-4" />}
              label={t("PVRPV Avg Nightly", "Promedio PVRPV")}
              value={fmtUsd(pvrpv.avgPriceUsd)}
              sub={`${pvrpv.listingsPriced.toLocaleString("en-US")} ${t(
                "listings priced",
                "con precio",
              )}`}
            />
          )}
        </div>
      </div>
    </Link>
  );
}

function Tile({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-xl bg-black/20 border border-white/[0.06] p-3.5">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5">
        <span className="text-primary/80">{icon}</span>
        <span className="truncate">{label}</span>
      </div>
      <div className="text-xl lg:text-2xl font-bold text-foreground tabular-nums leading-tight">
        {value}
      </div>
      <div className="text-[11px] text-muted-foreground mt-1 truncate">{sub}</div>
    </div>
  );
}
