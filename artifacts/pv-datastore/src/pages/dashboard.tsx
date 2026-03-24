import { useGetDashboardSummary } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { StatCard } from "@/components/stat-card";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { 
  Building2, 
  Home, 
  Plane, 
  Ship, 
  ShieldAlert, 
  ThermometerSun 
} from "lucide-react";
import { 
  ResponsiveContainer, 
  AreaChart, 
  Area, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip as RechartsTooltip 
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// Mock data for charts since summary endpoint doesn't return time-series
const mockTrendData = [
  { month: 'Jan', occupancy: 78, rate: 120 },
  { month: 'Feb', occupancy: 82, rate: 135 },
  { month: 'Mar', occupancy: 85, rate: 140 },
  { month: 'Apr', occupancy: 80, rate: 125 },
  { month: 'May', occupancy: 65, rate: 95 },
  { month: 'Jun', occupancy: 55, rate: 85 },
];

export default function Dashboard() {
  const { t } = useLanguage();
  const { data, isLoading, error } = useGetDashboardSummary();

  return (
    <PageWrapper>
      <div className="flex flex-col space-y-2 mb-8">
        <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
          {t('Platform Overview', 'Resumen de la Plataforma')}
        </h1>
        <p className="text-muted-foreground">
          {t('Key performance indicators for Puerto Vallarta real estate and tourism.', 'Indicadores clave de rendimiento para bienes raíces y turismo en Puerto Vallarta.')}
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <div className="p-8 text-center bg-destructive/10 text-destructive rounded-2xl border border-destructive/20">
          <p className="font-semibold">{t('Failed to load dashboard data.', 'Error al cargar datos del tablero.')}</p>
        </div>
      ) : data ? (
        <div className="space-y-8">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
            <StatCard
              titleEn="Hotel Occupancy"
              titleEs="Ocupación Hotelera"
              value={formatPercent(data.hotelOccupancyRate)}
              change={data.hotelOccupancyChange}
              icon={<Building2 className="text-primary" />}
              trend="up_good"
            />
            <StatCard
              titleEn="Avg Nightly Rate"
              titleEs="Tarifa Promedio por Noche"
              value={formatCurrency(data.avgNightlyRate)}
              change={data.avgNightlyRateChange}
              icon={<Home className="text-accent" />}
              trend="up_good"
            />
            <StatCard
              titleEn="Active Listings"
              titleEs="Anuncios Activos"
              value={formatNumber(data.activeListings)}
              change={data.activeListingsChange}
              icon={<Home className="text-emerald-500" />}
              trend="up_good"
            />
            <StatCard
              titleEn="Tourist Arrivals"
              titleEs="Llegada de Turistas"
              value={formatNumber(data.touristArrivals)}
              change={data.touristArrivalsChange}
              icon={<Plane className="text-blue-500" />}
              trend="up_good"
            />
            <StatCard
              titleEn="Cruise Visitors"
              titleEs="Visitantes de Cruceros"
              value={formatNumber(data.cruiseVisitors)}
              icon={<Ship className="text-indigo-500" />}
              trend="up_good"
            />
            <StatCard
              titleEn="Crime Index"
              titleEs="Índice de Criminalidad"
              value={data.crimeIndex.toFixed(1)}
              change={data.crimeIndexChange}
              icon={<ShieldAlert className="text-rose-500" />}
              trend="down_good"
            />
            <StatCard
              titleEn="Avg Temperature"
              titleEs="Temperatura Promedio"
              value={`${data.avgTemperatureC.toFixed(1)}°C`}
              icon={<ThermometerSun className="text-amber-500" />}
              trend="neutral"
            />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="font-display">
                  {t('Tourism Trend (YTD)', 'Tendencia Turística (YTD)')}
                </CardTitle>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={mockTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorOcc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(199 89% 48%)" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(199 89% 48%)" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
                    <RechartsTooltip 
                      contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)' }}
                      cursor={{ stroke: 'hsl(var(--muted))', strokeWidth: 2 }}
                    />
                    <Area type="monotone" dataKey="occupancy" name={t('Occupancy %', 'Ocupación %')} stroke="hsl(199 89% 48%)" strokeWidth={3} fillOpacity={1} fill="url(#colorOcc)" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            
            <Card className="glass-card">
              <CardHeader>
                <CardTitle className="font-display">
                  {t('Average Nightly Rate', 'Tarifa Promedio por Noche')}
                </CardTitle>
              </CardHeader>
              <CardContent className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={mockTrendData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(12 76% 61%)" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="hsl(12 76% 61%)" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                    <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} dy={10} />
                    <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
                    <RechartsTooltip 
                      contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 25px -5px rgba(0,0,0,0.1)' }}
                      formatter={(val: number) => [`$${val}`, t('Rate', 'Tarifa')]}
                    />
                    <Area type="monotone" dataKey="rate" stroke="hsl(12 76% 61%)" strokeWidth={3} fillOpacity={1} fill="url(#colorRate)" />
                  </AreaChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>
        </div>
      ) : null}
    </PageWrapper>
  );
}
