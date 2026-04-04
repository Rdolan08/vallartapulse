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
  Info,
  Mail,
} from "lucide-react";
import { useLanguage } from "@/contexts/language-context";

interface SidebarProps {
  mobileOpen?: boolean;
  onClose?: () => void;
}

function NavItems({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const { t } = useLanguage();

  const primaryNav = [
    { href: "/", icon: LayoutDashboard, labelEn: "Dashboard", labelEs: "Tablero" },
    { href: "/tourism", icon: Map, labelEn: "Tourism Metrics", labelEs: "Métricas Turísticas" },
    { href: "/rental-market", icon: Home, labelEn: "Rental Market", labelEs: "Mercado de Renta" },
    { href: "/pricing-tool", icon: DollarSign, labelEn: "Pricing Tool", labelEs: "Herramienta de Precios", highlight: true },
    { href: "/economic", icon: TrendingUp, labelEn: "Economic", labelEs: "Económico" },
    { href: "/safety", icon: ShieldAlert, labelEn: "Safety & Crime", labelEs: "Seguridad y Crimen" },
    { href: "/weather", icon: CloudSun, labelEn: "Weather & Climate", labelEs: "Clima" },
    { href: "/sources", icon: Database, labelEn: "Data Sources", labelEs: "Fuentes de Datos" },
  ];

  const secondaryNav = [
    { href: "/about", icon: Info, labelEn: "About", labelEs: "Acerca de" },
    { href: "/contact", icon: Mail, labelEn: "Contact", labelEs: "Contacto" },
  ];

  const renderItem = (item: typeof primaryNav[0]) => {
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
  };

  return (
    <>
      <div className="px-3 pb-4">
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.14em]"
          style={{ color: "rgba(154, 165, 177, 0.5)" }}
        >
          Puerto Vallarta
        </p>
      </div>

      {primaryNav.map(renderItem)}

      {/* Divider + secondary nav */}
      <div
        className="mt-4 pt-4 mx-3"
        style={{ borderTop: "1px solid rgba(255,255,255,0.05)" }}
      >
        {secondaryNav.map(renderItem)}
      </div>
    </>
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
      </div>

      {/* Mobile drawer — slides in from the left */}
      <AnimatePresence>
        {mobileOpen && (
          <>
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

            <motion.div
              key="drawer"
              className="fixed top-0 left-0 bottom-0 z-50 lg:hidden flex flex-col"
              style={{ width: "280px", ...sidebarStyle }}
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", damping: 28, stiffness: 300 }}
            >
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
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
