import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/language-context";

interface StatCardProps {
  titleEn: string;
  titleEs: string;
  value: string | number;
  change?: number;
  changeLabelEn?: string;
  changeLabelEs?: string;
  icon: React.ReactNode;
  trend?: "up_good" | "down_good" | "neutral";
}

export function StatCard({
  titleEn,
  titleEs,
  value,
  change,
  changeLabelEn = "vs last year",
  changeLabelEs = "vs año anterior",
  icon,
  trend = "up_good",
}: StatCardProps) {
  const { t } = useLanguage();

  const isPositive = change ? change > 0 : false;
  const isNeutral = change === 0 || change === undefined;

  let trendColor = "#9AA5B1";
  if (!isNeutral) {
    if (trend === "up_good") trendColor = isPositive ? "#34D399" : "#F87171";
    if (trend === "down_good") trendColor = isPositive ? "#F87171" : "#34D399";
  }

  return (
    <div className="glass-card overflow-hidden group" style={{ padding: "1.5rem", position: "relative" }}>
      {/* Background icon */}
      <div
        className="absolute top-0 right-0 p-5 pointer-events-none"
        style={{
          opacity: 0.07,
          transition: "opacity 0.4s ease, transform 0.4s ease",
        }}
      >
        <div className="w-14 h-14">{icon}</div>
      </div>

      <div className="relative flex flex-col gap-4" style={{ zIndex: 1 }}>
        {/* Label */}
        <p
          className="text-xs font-semibold uppercase tracking-[0.1em] leading-none"
          style={{ color: "#9AA5B1" }}
        >
          {t(titleEn, titleEs)}
        </p>

        {/* Value */}
        <div
          className="text-4xl font-bold leading-none"
          style={{ color: "#F5F7FA", letterSpacing: "-0.02em" }}
        >
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
      </div>
    </div>
  );
}
