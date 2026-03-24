import { useState } from "react";
import { useGetTourismMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { 
  ResponsiveContainer, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip,
  Legend
} from "recharts";
import { formatNumber, formatPercent } from "@/lib/utils";

export default function Tourism() {
  const { t } = useLanguage();
  const [year, setYear] = useState<number>(2025);
  
  // Try to fetch, let it fail gracefully if endpoint not wired
  const { data, isLoading, error } = useGetTourismMetrics({ year });

  return (
    <PageWrapper>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t('Tourism Metrics', 'Métricas Turísticas')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t('Arrivals and occupancy data from DATATUR.', 'Datos de llegadas y ocupación de DATATUR.')}
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
          <Skeleton className="h-96 w-full rounded-2xl" />
          <Skeleton className="h-64 w-full rounded-2xl" />
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium mb-2">
            {t('API Endpoint Not Connected Yet', 'Endpoint de API No Conectado Aún')}
          </div>
          <p className="text-sm text-muted-foreground/70">
            /api/metrics/tourism?year={year}
          </p>
        </div>
      ) : data && data.length > 0 ? (
        <div className="space-y-6">
          <Card className="glass-card">
            <CardHeader>
              <CardTitle>{t('Tourist Arrivals by Origin', 'Llegada de Turistas por Origen')}</CardTitle>
            </CardHeader>
            <CardContent className="h-[400px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} margin={{ top: 20, right: 30, left: 20, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="monthName" axisLine={false} tickLine={false} tick={{fill: 'hsl(var(--muted-foreground))'}} dy={10} />
                  <YAxis axisLine={false} tickLine={false} tick={{fill: 'hsl(var(--muted-foreground))'}} tickFormatter={(v) => `${(v/1000).toFixed(0)}k`} />
                  <Tooltip 
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)' }}
                    cursor={{fill: 'hsl(var(--muted)/0.5)'}}
                  />
                  <Legend iconType="circle" wrapperStyle={{ paddingTop: '20px' }} />
                  <Bar dataKey="internationalArrivals" name={t('International', 'Internacional')} fill="hsl(199 89% 48%)" radius={[4, 4, 0, 0]} stackId="a" />
                  <Bar dataKey="domesticArrivals" name={t('Domestic', 'Nacional')} fill="hsl(12 76% 61%)" radius={[4, 4, 0, 0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card className="glass-card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs uppercase bg-secondary/50 text-muted-foreground border-b">
                  <tr>
                    <th className="px-6 py-4">{t('Month', 'Mes')}</th>
                    <th className="px-6 py-4">{t('Occupancy', 'Ocupación')}</th>
                    <th className="px-6 py-4">{t('Intl Arrivals', 'Llegadas Int.')}</th>
                    <th className="px-6 py-4">{t('Dom Arrivals', 'Llegadas Nac.')}</th>
                    <th className="px-6 py-4">{t('Total', 'Total')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((row) => (
                    <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-6 py-4 font-medium text-foreground">{row.monthName}</td>
                      <td className="px-6 py-4">{formatPercent(row.hotelOccupancyRate)}</td>
                      <td className="px-6 py-4">{row.internationalArrivals ? formatNumber(row.internationalArrivals) : '-'}</td>
                      <td className="px-6 py-4">{row.domesticArrivals ? formatNumber(row.domesticArrivals) : '-'}</td>
                      <td className="px-6 py-4 font-semibold">{formatNumber(row.totalArrivals)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground">
          {t('No data available for this year.', 'No hay datos disponibles para este año.')}
        </div>
      )}
    </PageWrapper>
  );
}
