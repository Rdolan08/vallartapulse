import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/language-context";
import { Globe2, Menu } from "lucide-react";

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { lang, toggleLanguage, t } = useLanguage();

  return (
    <header className="sticky top-0 z-40 w-full glass-panel border-b-0 border-x-0 rounded-none h-16 flex items-center justify-between px-4 sm:px-6 lg:px-8">
      <div className="flex items-center gap-4 lg:hidden">
        <Button variant="ghost" size="icon" onClick={onMenuClick}>
          <Menu className="w-5 h-5" />
        </Button>
        <div className="flex items-center gap-2">
          <Globe2 className="w-6 h-6 text-primary" />
          <span className="font-display font-bold text-lg">PV DataStore</span>
        </div>
      </div>
      
      <div className="hidden lg:flex items-center">
        {/* Invisible spacer for desktop to push content right */}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 bg-secondary/50 rounded-full p-1 border border-border/50">
          <button
            onClick={() => lang !== 'en' && toggleLanguage()}
            className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-300 ${
              lang === 'en' ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            EN
          </button>
          <button
            onClick={() => lang !== 'es' && toggleLanguage()}
            className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-300 ${
              lang === 'es' ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            ES
          </button>
        </div>
      </div>
    </header>
  );
}
