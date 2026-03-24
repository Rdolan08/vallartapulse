import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/language-context";
import { Menu } from "lucide-react";
import logoDark from "@assets/vallartapulse_dark_1774383836513.png";
import logoLight from "@assets/vallartapulse_light_1774383836512.png";

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { lang, toggleLanguage } = useLanguage();

  return (
    <header className="sticky top-0 z-40 w-full bg-sidebar/90 backdrop-blur-xl border-b border-border/40 h-14 flex items-center justify-between px-4 sm:px-6 lg:px-8">
      {/* Mobile logo + hamburger */}
      <div className="flex items-center gap-3 lg:hidden">
        <Button variant="ghost" size="icon" onClick={onMenuClick} className="w-8 h-8 text-muted-foreground">
          <Menu className="w-4 h-4" />
        </Button>
        <img
          src={logoDark}
          alt="VallartaPulse"
          className="h-6 w-auto dark:block hidden"
        />
        <img
          src={logoLight}
          alt="VallartaPulse"
          className="h-6 w-auto dark:hidden block"
        />
      </div>

      <div className="hidden lg:flex" />

      {/* Language toggle */}
      <div className="flex items-center">
        <div className="flex items-center gap-0.5 bg-white/5 rounded-lg p-0.5 border border-border/50">
          <button
            onClick={() => lang !== 'en' && toggleLanguage()}
            className={`px-3 py-1 text-xs font-semibold rounded-md transition-all duration-200 ${
              lang === 'en'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            EN
          </button>
          <button
            onClick={() => lang !== 'es' && toggleLanguage()}
            className={`px-3 py-1 text-xs font-semibold rounded-md transition-all duration-200 ${
              lang === 'es'
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            ES
          </button>
        </div>
      </div>
    </header>
  );
}
