import { useState } from "react";
import { useGetRentalMarketMetrics } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";

export default function RentalMarket() {
  const { t } = useLanguage();
  const [year, setYear] = useState<number>(new Date().getFullYear());
  const [neighborhood, setNeighborhood] = useState<string>("Zona Romantica");
  
  const { data, isLoading, error } = useGetRentalMarketMetrics({ year, neighborhood });

  return (
    <PageWrapper>
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
            {t('Rental Market', 'Mercado de Renta')}
          </h1>
          <p className="text-muted-foreground mt-1">
            {t('Short-term rental analytics from Airbnb and VRBO.', 'Análisis de rentas a corto plazo de Airbnb y VRBO.')}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select 
            value={neighborhood}
            onChange={(e) => setNeighborhood(e.target.value)}
            className="glass-panel px-4 py-2 rounded-xl text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="Zona Romantica">Zona Romantica</option>
            <option value="Marina Vallarta">Marina Vallarta</option>
            <option value="Versalles">Versalles</option>
            <option value="Centro">Centro</option>
          </select>
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
                  <th className="px-6 py-4">{t('Platform', 'Plataforma')}</th>
                  <th className="px-6 py-4">{t('Active Listings', 'Anuncios Activos')}</th>
                  <th className="px-6 py-4">{t('Avg Rate', 'Tarifa Promedio')}</th>
                  <th className="px-6 py-4">{t('Occupancy', 'Ocupación')}</th>
                </tr>
              </thead>
              <tbody>
                {data.map((row) => (
                  <tr key={row.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                    <td className="px-6 py-4 font-medium">{row.monthName}</td>
                    <td className="px-6 py-4 capitalize">
                      <span className={`px-2 py-1 rounded-md text-xs font-semibold ${row.platform === 'airbnb' ? 'bg-rose-100 text-rose-700' : 'bg-blue-100 text-blue-700'}`}>
                        {row.platform}
                      </span>
                    </td>
                    <td className="px-6 py-4">{formatNumber(row.activeListings)}</td>
                    <td className="px-6 py-4 font-semibold text-primary">{formatCurrency(row.avgNightlyRateUsd)}</td>
                    <td className="px-6 py-4">{formatPercent(row.occupancyRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t('No data available for these filters.', 'No hay datos disponibles para estos filtros.')}
        </div>
      )}
    </PageWrapper>
  );
}
