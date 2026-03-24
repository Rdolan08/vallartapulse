import { Card, CardContent } from "@/components/ui/card";
import { ArrowDownIcon, ArrowUpIcon, MinusIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLanguage } from "@/contexts/language-context";

interface StatCardProps {
  titleEn: string;
  titleEs: string;
  value: string | number;
  change?: number;
  changeLabelEn?: string;
  changeLabelEs?: string;
  icon: React.ReactNode;
  trend?: 'up_good' | 'down_good' | 'neutral';
}

export function StatCard({ 
  titleEn, titleEs, value, change, changeLabelEn = "vs last year", changeLabelEs = "vs año anterior", icon, trend = 'up_good' 
}: StatCardProps) {
  const { t } = useLanguage();
  
  const isPositive = change ? change > 0 : false;
  const isNeutral = change === 0 || change === undefined;
  
  let trendColor = "text-muted-foreground";
  if (!isNeutral) {
    if (trend === 'up_good') trendColor = isPositive ? "text-emerald-600" : "text-rose-600";
    if (trend === 'down_good') trendColor = isPositive ? "text-rose-600" : "text-emerald-600";
  }

  return (
    <Card className="glass-card overflow-hidden group">
      <CardContent className="p-6 relative">
        <div className="absolute top-0 right-0 p-6 opacity-10 group-hover:opacity-20 group-hover:scale-110 transition-all duration-500">
          <div className="w-16 h-16">{icon}</div>
        </div>
        
        <div className="flex flex-col space-y-4 relative z-10">
          <div className="space-y-1">
            <h3 className="font-display font-medium text-muted-foreground tracking-tight">
              {t(titleEn, titleEs)}
            </h3>
            <div className="text-3xl font-bold text-foreground">
              {value}
            </div>
          </div>
          
          {change !== undefined && (
            <div className="flex items-center space-x-2 text-sm font-medium">
              <span className={cn("flex items-center", trendColor)}>
                {isPositive ? <ArrowUpIcon className="w-4 h-4 mr-1" /> : 
                 change < 0 ? <ArrowDownIcon className="w-4 h-4 mr-1" /> : 
                 <MinusIcon className="w-4 h-4 mr-1" />}
                {Math.abs(change)}%
              </span>
              <span className="text-muted-foreground opacity-80">
                {t(changeLabelEn, changeLabelEs)}
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
