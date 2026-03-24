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
  Globe2
} from "lucide-react";
import { useLanguage } from "@/contexts/language-context";
import { cn } from "@/lib/utils";

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
    <div className="hidden lg:flex w-72 flex-col fixed inset-y-0 left-0 bg-sidebar border-r border-sidebar-border shadow-xl shadow-black/5 z-50">
      <div className="p-6 flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-ocean-dark flex items-center justify-center text-white shadow-lg shadow-primary/20">
          <Globe2 className="w-6 h-6" />
        </div>
        <div className="flex flex-col">
          <span className="font-display font-bold text-xl tracking-tight leading-none text-foreground">
            PV DataStore
          </span>
          <span className="text-xs font-medium text-muted-foreground">Puerto Vallarta</span>
        </div>
      </div>

      <div className="flex-1 px-4 space-y-1.5 overflow-y-auto pb-6">
        <div className="px-2 pb-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            {t('Analytics Platform', 'Plataforma Analítica')}
          </p>
        </div>
        
        {navItems.map((item) => {
          const isActive = location === item.href;
          const Icon = item.icon;
          return (
            <Link key={item.href} href={item.href} className="block">
              <div className={cn(
                "flex items-center gap-3 px-3 py-3 rounded-xl transition-all duration-200 cursor-pointer relative group",
                isActive 
                  ? "bg-primary/10 text-primary font-semibold" 
                  : "text-sidebar-foreground/70 hover:bg-secondary/60 hover:text-sidebar-foreground"
              )}>
                {isActive && (
                  <motion.div 
                    layoutId="active-nav" 
                    className="absolute left-0 w-1 h-6 bg-primary rounded-r-full"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.2 }}
                  />
                )}
                <Icon className={cn("w-5 h-5", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                <div className="flex flex-col">
                  <span className="text-sm">{item.labelEn}</span>
                  <span className="text-[10px] opacity-70 leading-none">{item.labelEs}</span>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
