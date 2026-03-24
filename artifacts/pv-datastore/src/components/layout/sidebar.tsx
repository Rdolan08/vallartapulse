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
import logoDark from "@assets/vallartapulse_dark_1774383836513.png";
import logoLight from "@assets/vallartapulse_light_1774383836512.png";

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
    <div className="hidden lg:flex w-72 flex-col fixed inset-y-0 left-0 bg-sidebar border-r border-sidebar-border shadow-2xl shadow-black/30 z-50">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-border/40">
        <img
          src={logoDark}
          alt="VallartaPulse"
          className="h-8 w-auto dark:block hidden"
        />
        <img
          src={logoLight}
          alt="VallartaPulse"
          className="h-8 w-auto dark:hidden block"
        />
      </div>

      {/* Nav */}
      <div className="flex-1 px-3 pt-4 space-y-0.5 overflow-y-auto pb-6">
        <div className="px-3 pb-3">
          <p className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.12em]">
            {t('Analytics Platform', 'Plataforma Analítica')}
          </p>
        </div>
        
        {navItems.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="block">
              <div className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-150 cursor-pointer relative group",
                isActive 
                  ? "bg-primary/12 text-primary font-semibold" 
                  : "text-sidebar-foreground/60 hover:bg-white/5 hover:text-sidebar-foreground"
              )}>
                {isActive && (
                  <motion.div 
                    layoutId="active-nav" 
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-primary rounded-r-full"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.15 }}
                  />
                )}
                <Icon className={cn(
                  "w-4 h-4 flex-shrink-0",
                  isActive ? "text-primary" : "text-muted-foreground/60 group-hover:text-foreground/70"
                )} />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm leading-tight">{item.labelEn}</span>
                  <span className="text-[10px] opacity-50 leading-none mt-0.5">{item.labelEs}</span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Footer */}
      <div className="px-5 py-4 border-t border-border/30">
        <p className="text-[10px] text-muted-foreground/40 leading-relaxed">
          Real-time insights for Puerto Vallarta's<br/>rental &amp; tourism market
        </p>
      </div>
    </div>
  );
}
