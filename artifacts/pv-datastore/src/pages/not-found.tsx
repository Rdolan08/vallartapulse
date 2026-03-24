import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useLanguage } from "@/contexts/language-context";

export default function NotFound() {
  const { t } = useLanguage();

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background p-4">
      <div className="text-center space-y-6 max-w-md w-full glass-panel p-10 rounded-3xl">
        <h1 className="text-6xl font-display font-bold text-primary">404</h1>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-foreground">
            {t('Page not found', 'Página no encontrada')}
          </h2>
          <p className="text-muted-foreground">
            {t("The dashboard view you're looking for doesn't exist or has been moved.", "La vista del tablero que buscas no existe o ha sido movida.")}
          </p>
        </div>
        <div className="pt-4">
          <Link href="/">
            <Button size="lg" className="w-full">
              {t('Return to Dashboard', 'Volver al Tablero')}
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
