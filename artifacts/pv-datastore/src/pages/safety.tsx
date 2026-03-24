import { useState } from "react";
import { useGetSafetyMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils";

export default function Safety() {
  const { t, lang } = useLanguage();
  const [year, setYear] = useState<number>(2025);
  
  const { data, isLoading, error } = useGetSafetyMetrics({ year });

  return (
    <PageWrapper>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t('Safety & Crime', 'Seguridad y Crimen')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t('Incident statistics from SESNSP.', 'Estadísticas de incidentes de SESNSP.')}
          </p>
        </div>
        <select 
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {[2025, 2024, 2023, 2022].map(y => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {isLoading ? (
        <div className="space-y-6">
          <Skeleton className="h-[400px] w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">API Endpoint Not Connected</div>
        </div>
      ) : data && data.length > 0 ? (
        <Card className="glass-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
                <tr>
                  <th className="px-6 py-4">{t('Month', 'Mes')}</th>
                  <th className="px-6 py-4">{t('Category', 'Categoría')}</th>
                  <th className="px-6 py-4">{t('Incidents', 'Incidentes')}</th>
                  <th className="px-6 py-4">{t('Rate per 100k', 'Tasa por 100k')}</th>
                  <th className="px-6 py-4">{t('YoY Change', 'Cambio Anual')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-6 py-4 font-medium">{row.monthName}</td>
                    <td className="px-6 py-4">
                      {lang === 'es' && row.categoryEs ? row.categoryEs : row.category}
                    </td>
                    <td className="px-6 py-4 font-semibold text-rose-600">{formatNumber(row.incidentCount)}</td>
                    <td className="px-6 py-4">{row.incidentsPer100k?.toFixed(1) || '-'}</td>
                    <td className={`px-6 py-4 font-medium ${
                      (row.changeVsPriorYear || 0) > 0 ? 'text-rose-600' : 'text-emerald-600'
                    }`}>
                      {row.changeVsPriorYear ? `${row.changeVsPriorYear > 0 ? '+' : ''}${row.changeVsPriorYear}%` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t('No data available for this year.', 'No hay datos disponibles para este año.')}
        </div>
      )}
    </PageWrapper>
  );
}
