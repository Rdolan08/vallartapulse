import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/language-context";
import { Menu } from "lucide-react";
import logoDark from "@assets/vallartapulse_dark_cropped_1774384760536.png";
import logoLight from "@assets/vallartapulse_light_cropped_1774384760536.png";

export function Topbar({ onMenuClick }: { onMenuClick?: () => void }) {
  const { lang, toggleLanguage } = useLanguage();

  return (
    <header
      className="sticky top-0 z-40 w-full flex items-center justify-between px-6 lg:px-8"
      style={{
        height: "80px",
        background: "#0A1E27",
        borderBottom: "1px solid rgba(255,255,255,0.05)",
        backdropFilter: "blur(16px)",
        WebkitBackdropFilter: "blur(16px)",
      }}
    >
      {/* Mobile: hamburger + logo */}
      <div className="flex items-center gap-4 lg:hidden">
        <Button
          variant="ghost"
          size="icon"
          onClick={onMenuClick}
          className="w-9 h-9"
          style={{ color: "rgba(154,165,177,0.8)" }}
        >
          <Menu className="w-5 h-5" />
        </Button>
        <img
          src={logoDark}
          alt="VallartaPulse"
          className="dark:block hidden"
          style={{ height: "40px", width: "auto", maxWidth: "180px" }}
        />
        <img
          src={logoLight}
          alt="VallartaPulse"
          className="dark:hidden block"
          style={{ height: "40px", width: "auto", maxWidth: "180px" }}
        />
      </div>

      {/* Desktop spacer */}
      <div className="hidden lg:flex" />

      {/* Language toggle */}
      <div className="flex items-center">
        <div
          className="flex items-center gap-0.5 rounded-lg p-0.5"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.07)",
          }}
        >
          <button
            onClick={() => lang !== "en" && toggleLanguage()}
            className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all duration-200"
            style={
              lang === "en"
                ? { background: "#00C2A8", color: "#0A1E27" }
                : { color: "rgba(154,165,177,0.8)" }
            }
          >
            EN
          </button>
          <button
            onClick={() => lang !== "es" && toggleLanguage()}
            className="px-3 py-1.5 text-xs font-semibold rounded-md transition-all duration-200"
            style={
              lang === "es"
                ? { background: "#00C2A8", color: "#0A1E27" }
                : { color: "rgba(154,165,177,0.8)" }
            }
          >
            ES
          </button>
        </div>
      </div>
    </header>
  );
}
