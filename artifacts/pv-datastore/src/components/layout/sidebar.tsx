import { Link, useLocation } from "wouter";
import { motion } from "framer-motion";
import {
  LayoutDashboard,
  Map,
  Home,
  TrendingUp,
  ShieldAlert,
  CloudSun,
  Database,
} from "lucide-react";
import { useLanguage } from "@/contexts/language-context";
import { cn } from "@/lib/utils";
import logoDark from "@assets/vallartapulse_dark_cropped_1774384760536.png";
import logoLight from "@assets/vallartapulse_light_cropped_1774384760536.png";

export function Sidebar() {
  const [location] = useLocation();
  const { t } = useLanguage();

  const navItems = [
    { href: "/", icon: LayoutDashboard, labelEn: "Dashboard", labelEs: "Tablero" },
    { href: "/tourism", icon: Map, labelEn: "Tourism Metrics", labelEs: "Métricas Turísticas" },
    { href: "/rental-market", icon: Home, labelEn: "Rental Market", labelEs: "Mercado de Renta" },
    { href: "/economic", icon: TrendingUp, labelEn: "Economic", labelEs: "Económico" },
    { href: "/safety", icon: ShieldAlert, labelEn: "Safety & Crime", labelEs: "Seguridad y Crimen" },
    { href: "/weather", icon: CloudSun, labelEn: "Weather & Climate", labelEs: "Clima" },
    { href: "/sources", icon: Database, labelEn: "Data Sources", labelEs: "Fuentes de Datos" },
  ];

  return (
    <div
      className="hidden lg:flex w-72 flex-col fixed inset-y-0 left-0 z-50"
      style={{
        background: "#0A1E27",
        borderRight: "1px solid rgba(255,255,255,0.05)",
        boxShadow: "4px 0 24px rgba(0,0,0,0.4)",
      }}
    >
      {/* Logo — 80px tall to match header */}
      <div
        className="flex items-center px-6"
        style={{
          height: "80px",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <img
          src={logoDark}
          alt="VallartaPulse"
          className="dark:block hidden"
          style={{ height: "52px", width: "auto" }}
        />
        <img
          src={logoLight}
          alt="VallartaPulse"
          className="dark:hidden block"
          style={{ height: "52px", width: "auto" }}
        />
      </div>

      {/* Nav */}
      <div className="flex-1 px-3 pt-5 space-y-0.5 overflow-y-auto pb-6">
        <div className="px-3 pb-4">
          <p
            className="text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: "rgba(154, 165, 177, 0.5)" }}
          >
            {t("Analytics Platform", "Plataforma Analítica")}
          </p>
        </div>

        {navItems.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="block">
              <div
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 cursor-pointer relative group",
                  isActive ? "font-semibold" : ""
                )}
                style={{
                  background: isActive ? "rgba(0,194,168,0.1)" : "transparent",
                  color: isActive ? "#00C2A8" : "rgba(245,247,250,0.55)",
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "rgba(255,255,255,0.04)";
                    (e.currentTarget as HTMLDivElement).style.color =
                      "rgba(245,247,250,0.85)";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    (e.currentTarget as HTMLDivElement).style.background =
                      "transparent";
                    (e.currentTarget as HTMLDivElement).style.color =
                      "rgba(245,247,250,0.55)";
                  }
                }}
              >
                {isActive && (
                  <motion.div
                    layoutId="active-nav"
                    className="absolute left-0 top-1/2 -translate-y-1/2 rounded-r-full"
                    style={{ width: "2px", height: "20px", background: "#00C2A8" }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                  />
                )}
                <Icon
                  className="w-4 h-4 flex-shrink-0"
                  style={{ color: isActive ? "#00C2A8" : "rgba(154,165,177,0.7)" }}
                />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm leading-tight">{item.labelEn}</span>
                  <span className="text-[10px] leading-none mt-0.5" style={{ opacity: 0.4 }}>
                    {item.labelEs}
                  </span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Footer tagline */}
      <div
        className="px-6 py-4"
        style={{ borderTop: "1px solid rgba(255,255,255,0.04)" }}
      >
        <p className="text-[10px] leading-relaxed" style={{ color: "rgba(154,165,177,0.35)" }}>
          Real-time insights for Puerto Vallarta's
          <br />
          rental &amp; tourism market
        </p>
      </div>
    </div>
  );
}
