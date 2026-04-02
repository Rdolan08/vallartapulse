import { Link, useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  Map,
  Home,
  TrendingUp,
  ShieldAlert,
  CloudSun,
  Database,
  X,
  DollarSign,
} from "lucide-react";
import { useLanguage } from "@/contexts/language-context";
import { useState } from "react";
import founderPhoto from "@assets/60F21D23-B299-493B-AB91-0FC4E4DD5DA1_1775158046764.png";

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const { t } = useLanguage();

  const navItems = [
    { href: "/", icon: LayoutDashboard, labelEn: "Dashboard", labelEs: "Tablero" },
    { href: "/tourism", icon: Map, labelEn: "Tourism Metrics", labelEs: "Métricas Turísticas" },
    { href: "/rental-market", icon: Home, labelEn: "Rental Market", labelEs: "Mercado de Renta" },
    { href: "/pricing-tool", icon: DollarSign, labelEn: "Pricing Tool", labelEs: "Herramienta de Precios", highlight: true },
    { href: "/economic", icon: TrendingUp, labelEn: "Economic", labelEs: "Económico" },
    { href: "/safety", icon: ShieldAlert, labelEn: "Safety & Crime", labelEs: "Seguridad y Crimen" },
    { href: "/weather", icon: CloudSun, labelEn: "Weather & Climate", labelEs: "Clima" },
    { href: "/sources", icon: Database, labelEn: "Data Sources", labelEs: "Fuentes de Datos" },
  ];

  return (
    <>
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
        const isHighlight = (item as { highlight?: boolean }).highlight;
        return (
          <Link
            key={item.href}
            href={item.href}
            className="block"
            onClick={onNavigate}
          >
            <div
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 cursor-pointer relative"
              style={{
                background: isActive
                  ? "rgba(0,194,168,0.1)"
                  : isHighlight && !isActive
                  ? "rgba(0,194,168,0.04)"
                  : "transparent",
                color: isActive ? "#00C2A8" : "rgba(245,247,250,0.55)",
                fontWeight: isActive ? 600 : 400,
                border: isHighlight && !isActive ? "1px solid rgba(0,194,168,0.12)" : "1px solid transparent",
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLDivElement).style.background = "rgba(255,255,255,0.04)";
                  (e.currentTarget as HTMLDivElement).style.color = "rgba(245,247,250,0.85)";
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  (e.currentTarget as HTMLDivElement).style.background = "transparent";
                  (e.currentTarget as HTMLDivElement).style.color = "rgba(245,247,250,0.55)";
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
              <div className="flex flex-col min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm leading-tight">{item.labelEn}</span>
                  {isHighlight && !isActive && (
                    <span
                      className="text-[9px] font-bold px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ background: "rgba(0,194,168,0.2)", color: "#00C2A8", letterSpacing: "0.05em" }}
                    >
                      NEW
                    </span>
                  )}
                </div>
                <span className="text-[10px] leading-none mt-0.5" style={{ opacity: 0.4 }}>
                  {item.labelEs}
                </span>
              </div>
            </div>
          </Link>
        );
      })}
    </>
  );
}

function AboutSection() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="px-4 py-4"
      style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}
    >
      <p
        className="text-[9px] font-semibold uppercase tracking-[0.14em] mb-3"
        style={{ color: "rgba(154,165,177,0.4)" }}
      >
        About Us
      </p>

      {/* Collapsed: photo + name + toggle */}
      <div className="flex items-center gap-3">
        <img
          src={founderPhoto}
          alt="Ryan Dolan"
          className="rounded-full object-cover flex-shrink-0"
          style={{ width: "38px", height: "38px", objectPosition: "center top" }}
        />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold leading-tight" style={{ color: "rgba(245,247,250,0.85)" }}>
            Ryan Dolan
          </p>
          <p className="text-[10px] leading-tight mt-0.5" style={{ color: "rgba(154,165,177,0.5)" }}>
            Founder
          </p>
        </div>
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] px-2 py-1 rounded transition-colors flex-shrink-0"
          style={{
            color: "#00C2A8",
            background: "rgba(0,194,168,0.08)",
            border: "1px solid rgba(0,194,168,0.15)",
          }}
        >
          {expanded ? "Less" : "More"}
        </button>
      </div>

      {/* Expanded bio */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 space-y-2">
              <p className="text-[10px] leading-relaxed" style={{ color: "rgba(154,165,177,0.65)" }}>
                Ryan is an owner at{" "}
                <span style={{ color: "rgba(245,247,250,0.8)" }}>Ciye</span>, an upcoming development on Lázaro Cárdenas Park in Puerto Vallarta's Zona Romántica.
              </p>
              <p className="text-[10px] leading-relaxed" style={{ color: "rgba(154,165,177,0.65)" }}>
                After 20+ years in AI, data, and technology — including leadership roles in the U.S. federal government — he built Vallarta Pulse to bring smarter, data-driven insight to Puerto Vallarta's rapidly growing rental market.
              </p>
              <p className="text-[10px] leading-relaxed" style={{ color: "rgba(154,165,177,0.65)" }}>
                He lives in Minneapolis with his husband Chris and daughter Olivia, and splits his time between the U.S. and Puerto Vallarta.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const sidebarStyle = {
  background: "#0A1E27",
  borderRight: "1px solid rgba(255,255,255,0.05)",
  boxShadow: "4px 0 24px rgba(0,0,0,0.4)",
};

export function Sidebar({ mobileOpen = false, onClose }: SidebarProps) {
  return (
    <>
      {/* Desktop sidebar — always visible on lg+ */}
      <div
        className="hidden lg:flex w-72 flex-col fixed inset-y-0 left-0 z-50"
        style={sidebarStyle}
      >
        <div className="flex-1 px-3 pt-8 space-y-0.5 overflow-y-auto pb-6">
          <NavItems />
        </div>
        <AboutSection />
      </div>

      {/* Mobile drawer — slides in from the left */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            {/* Backdrop */}
            <motion.div
              key="backdrop"
              className="fixed inset-0 z-40 lg:hidden"
              style={{ background: "rgba(0,0,0,0.6)", backdropFilter: "blur(2px)" }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={onClose}
            />

            {/* Drawer panel */}
            <motion.div
              key="drawer"
              className="fixed top-0 left-0 bottom-0 z-50 lg:hidden flex flex-col"
              style={{ width: "280px", ...sidebarStyle }}
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 300 }}
            >
              {/* Close button row */}
              <div className="flex items-center justify-between px-4 pt-5 pb-3">
                <p
                  className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                  style={{ color: "rgba(154, 165, 177, 0.5)" }}
                >
                  Menu
                </p>
                <button
                  onClick={onClose}
                  className="w-8 h-8 flex items-center justify-center rounded-lg transition-colors"
                  style={{ color: "rgba(154,165,177,0.7)" }}
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="flex-1 px-3 space-y-0.5 overflow-y-auto pb-6">
                <NavItems onNavigate={onClose} />
              </div>

              <AboutSection />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
