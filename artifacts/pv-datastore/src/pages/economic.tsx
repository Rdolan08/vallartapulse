import { useState } from "react";
import { useGetEconomicMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Economic() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  
  const { data, isLoading, error } = useGetEconomicMetrics({ year });

  return (
    <PageWrapper>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t('Economic Indicators', 'Indicadores Económicos')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t('Macroeconomic health data from Data México and INEGI.', 'Datos macroeconómicos de Data México e INEGI.')}
          </p>
        </div>
        <select 
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {[2024, 2023, 2022, 2021].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <Skeleton className="h-48 w-full rounded-2xl" />
          <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">API Endpoint Not Connected</div>
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {data.map((metric) => (
            <Card key={metric.id} className="glass-card">
              <CardHeader>
                <CardTitle className="text-lg">
                  {lang === 'es' && metric.descriptionEs ? metric.descriptionEs : metric.indicator}
                </CardTitle>
                <p className="text-sm text-muted-foreground">Q{metric.quarter} {metric.year} • {metric.source}</p>
              </CardHeader>
              <CardContent>
                <div className="text-4xl font-bold text-foreground mb-2">
                  {metric.value.toLocaleString()} <span className="text-xl text-muted-foreground font-normal">{metric.unit}</span>
                </div>
                <p className="text-sm text-muted-foreground/80">
                  {lang === 'es' ? metric.descriptionEs : metric.description}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t('No data available for this year.', 'No hay datos disponibles para este año.')}
        </div>
      )}
    </PageWrapper>
  );
}
