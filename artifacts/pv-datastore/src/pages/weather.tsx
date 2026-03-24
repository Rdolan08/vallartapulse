import { useState } from "react";
import { useGetWeatherMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ThermometerSun, Droplets, Sun, Waves } from "lucide-react";

export default function Weather() {
  const { t } = useLanguage();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  
  const { data, isLoading, error } = useGetWeatherMetrics({ year });

  return (
    <PageWrapper>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t('Weather & Climate', 'Clima y Tiempo')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t('Historical and seasonal climate data from NOAA.', 'Datos climáticos históricos y estacionales de la NOAA.')}
          </p>
        </div>
        <select 
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {[2024, 2023, 2022].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">API Endpoint Not Connected</div>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-6">
          {/* Detailed monthly table or grid view */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
            {data.map((month) => (
              <Card key={month.id} className="glass-card">
                <CardHeader className="pb-4">
                  <CardTitle className="text-xl font-display text-primary">{month.monthName}</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-y-6 gap-x-4">
                    <div className="flex items-start gap-3">
                      <ThermometerSun className="w-5 h-5 text-amber-500 mt-0.5" />
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">{t('Avg Temp', 'Temp. Prom')}</div>
                        <div className="text-lg font-bold">{month.avgTempC}°C</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Droplets className="w-5 h-5 text-blue-500 mt-0.5" />
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">{t('Rainfall', 'Precipitación')}</div>
                        <div className="text-lg font-bold">{month.precipitationMm}mm</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Sun className="w-5 h-5 text-yellow-500 mt-0.5" />
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">{t('Sunshine', 'Sol')}</div>
                        <div className="text-lg font-bold">{month.sunshineHours || '-'}h</div>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <Waves className="w-5 h-5 text-cyan-500 mt-0.5" />
                      <div>
                        <div className="text-sm font-medium text-muted-foreground">{t('Sea Temp', 'Temp. Mar')}</div>
                        <div className="text-lg font-bold">{month.avgSeaTempC || '-'}°C</div>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t('No data available for this year.', 'No hay datos disponibles para este año.')}
        </div>
      )}
    </PageWrapper>
  );
}
