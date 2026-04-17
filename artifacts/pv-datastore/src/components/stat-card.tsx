import { ArrowDownIcon, ArrowUpIcon, MinusIcon, ChevronRight } from "lucide-react";
import { Link } from "wouter";
import { useLanguage } from "@/contexts/language-context";

interface StatCardProps {
  titleEn: string;
  titleEs: string;
  value: string | number;
  change?: number;
  changeLabelEn?: string;
  changeLabelEs?: string;
  footnoteEn?: string;
  footnoteEs?: string;
  icon: React.ReactNode;
  trend?: "up_good" | "down_good" | "neutral";
  href?: string;
}

export function StatCard({
  titleEn,
  titleEs,
  value,
  change,
  changeLabelEn = "vs last year",
  changeLabelEs = "vs año anterior",
  footnoteEn,
  footnoteEs,
  icon,
  trend = "up_good",
  href,
}: StatCardProps) {
  const { t } = useLanguage();

  const isPositive = change ? change > 0 : false;
  const isNeutral = change === 0 || change === undefined;

  let trendColor = "#9AA5B1";
  if (!isNeutral) {
    if (trend === "up_good") trendColor = isPositive ? "#34D399" : "#F87171";
    if (trend === "down_good") trendColor = isPositive ? "#F87171" : "#34D399";
  }

  const inner = (
    <div
      className="glass-card overflow-hidden group relative h-full"
      style={{ padding: "1.5rem", cursor: href ? "pointer" : "default" }}
    >
      {/* Subtle teal border glow on hover — only when linkable */}
      {href && (
        <div
          className="absolute inset-0 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
          style={{
            boxShadow: "inset 0 0 0 1px rgba(0,194,168,0.4)",
            background: "radial-gradient(circle at 50% 0%, rgba(0,194,168,0.05) 0%, transparent 70%)",
          }}
        />
      )}

      {/* Background icon */}
      <div className="absolute top-0 right-0 p-5 pointer-events-none" style={{ opacity: 0.07 }}>
        <div className="w-14 h-14">{icon}</div>
      </div>

      {/* Chevron — top right, fades in on hover */}
      {href && (
        <div className="absolute top-3 right-3 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-200 text-primary">
          <ChevronRight className="w-4 h-4" />
        </div>
      )}

      <div className="relative flex flex-col gap-4" style={{ zIndex: 1 }}>
        {/* Label */}
        <p className="text-xs font-semibold uppercase tracking-[0.1em] leading-none" style={{ color: "#9AA5B1" }}>
          {t(titleEn, titleEs)}
        </p>

        {/* Value */}
        <div className="text-4xl font-bold leading-none" style={{ color: "#F5F7FA", letterSpacing: "-0.02em" }}>
          {value}
        </div>

        {/* Change badge */}
        {change !== undefined && (
          <div className="flex items-center gap-2 text-sm font-medium">
            <span className="flex items-center gap-0.5" style={{ color: trendColor }}>
              {isPositive ? (
                <ArrowUpIcon className="w-3.5 h-3.5" />
              ) : change < 0 ? (
                <ArrowDownIcon className="w-3.5 h-3.5" />
              ) : (
                <MinusIcon className="w-3.5 h-3.5" />
              )}
              {Math.abs(change)}%
            </span>
            <span style={{ color: "rgba(154,165,177,0.65)", fontSize: "12px" }}>
              {t(changeLabelEn, changeLabelEs)}
            </span>
          </div>
        )}

        {/* Footnote — data source or qualifier */}
        {(footnoteEn || footnoteEs) && (
          <p style={{ color: "rgba(154,165,177,0.5)", fontSize: "9px", textTransform: "uppercase", letterSpacing: "0.06em", lineHeight: 1.3 }}>
            {t(footnoteEn ?? "", footnoteEs ?? "")}
          </p>
        )}

        {/* "View details" label — fades in at the bottom on hover */}
        {href && (
          <div className="flex items-center gap-0.5 text-xs font-semibold text-primary opacity-0 group-hover:opacity-100 transition-opacity duration-200">
            {t("View details", "Ver detalles")} <ChevronRight className="w-3 h-3" />
          </div>
        )}
      </div>
    </div>
  );

  if (!href) return inner;

  return (
    <Link href={href} className="block h-full outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-2xl">
      {inner}
    </Link>
  );
}
