import { useGetDataSources, useSyncDataSource } from "@workspace/api-client-react";
import { PageWrapper } from "@/components/layout/page-wrapper";
import { useLanguage } from "@/contexts/language-context";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { RefreshCw, ExternalLink, Database } from "lucide-react";
import { format } from "date-fns";

export default function Sources() {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const { data, isLoading, error, refetch } = useGetDataSources();
  const syncMutation = useSyncDataSource();

  const handleSync = (id: number, name: string) => {
    syncMutation.mutate(
      { id },
      {
        onSuccess: () => {
          toast({
            title: t('Sync Successful', 'Sincronización Exitosa'),
            description: `${name} ${t('has been updated.', 'ha sido actualizado.')}`,
          });
          refetch();
        },
        onError: () => {
          toast({
            variant: "destructive",
            title: t('Sync Failed', 'Sincronización Fallida'),
            description: t('An error occurred during synchronization.', 'Ocurrió un error durante la sincronización.'),
          });
        }
      }
    );
  };

  return (
    <PageWrapper>
      <div className="flex flex-col space-y-2 mb-8">
        <h1 className="text-3xl font-display font-bold tracking-tight text-foreground">
          {t('Data Sources Registry', 'Registro de Fuentes de Datos')}
        </h1>
        <p className="text-muted-foreground">
          {t('Manage and sync external data integrations.', 'Administrar y sincronizar integraciones de datos externos.')}
        </p>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        <div className="p-12 text-center bg-secondary/30 rounded-3xl border border-dashed">
          <div className="text-muted-foreground font-medium">API Endpoint Not Connected</div>
        </div>
      ) : data && data.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
          {data.map((source) => (
            <Card key={source.id} className="glass-card flex flex-col">
              <CardHeader className="pb-4">
                <div className="flex justify-between items-start mb-2">
                  <Badge variant="outline" className="bg-secondary/50 text-[10px] font-bold uppercase tracking-wider">
                    {source.category}
                  </Badge>
                  <Badge variant={source.status === 'active' ? 'success' : source.status === 'error' ? 'destructive' : 'warning'}>
                    {source.status}
                  </Badge>
                </div>
                <CardTitle className="text-xl font-display">
                  {lang === 'es' && source.nameEs ? source.nameEs : source.name}
                </CardTitle>
                <p className="text-sm text-muted-foreground line-clamp-2 mt-2">
                  {lang === 'es' && source.descriptionEs ? source.descriptionEs : source.description}
                </p>
              </CardHeader>
              <CardContent className="flex-1">
                <div className="space-y-3 mt-2 text-sm">
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-muted-foreground">{t('Last Synced', 'Última Sincronización')}</span>
                    <span className="font-medium">
                      {source.lastSyncedAt ? format(new Date(source.lastSyncedAt), 'PP p') : t('Never', 'Nunca')}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-b border-border/50">
                    <span className="text-muted-foreground">{t('Records', 'Registros')}</span>
                    <span className="font-medium flex items-center gap-1">
                      <Database className="w-3 h-3 text-primary" />
                      {source.recordCount ? source.recordCount.toLocaleString() : 0}
                    </span>
                  </div>
                  <div className="flex justify-between items-center py-2 border-border/50">
                    <span className="text-muted-foreground">{t('Frequency', 'Frecuencia')}</span>
                    <span className="font-medium capitalize">{source.frequency || 'Manual'}</span>
                  </div>
                </div>
              </CardContent>
              <CardFooter className="pt-4 border-t border-border/50 gap-3">
                <Button 
                  variant="outline" 
                  className="flex-1" 
                  onClick={() => handleSync(source.id, source.name)}
                  disabled={syncMutation.isPending && syncMutation.variables?.id === source.id}
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${syncMutation.isPending && syncMutation.variables?.id === source.id ? 'animate-spin' : ''}`} />
                  {t('Sync Now', 'Sincronizar')}
                </Button>
                {source.url && (
                  <Button variant="ghost" size="icon" asChild>
                    <a href={source.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="w-4 h-4" />
                    </a>
                  </Button>
                )}
              </CardFooter>
            </Card>
          ))}
        </div>
      ) : (
        <div className="p-12 text-center text-muted-foreground bg-white/50 rounded-2xl border border-dashed">
          {t('No data sources configured.', 'No hay fuentes de datos configuradas.')}
        </div>
      )}
    </PageWrapper>
  );
}
