import { useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export interface AirportMetricRow {
  id: number;
  year: number;
  month: number;
  monthName: string;
  totalPassengers: number;
  domesticPassengers: number | null;
  internationalPassengers: number | null;
  avgDailyPassengers: number | null;
  daysInMonth: number | null;
  source: string;
  sourceUrl: string | null;
}

export interface GetAirportMetricsParams {
  year?: number;
  month?: number;
}

export function useGetAirportMetrics(params: GetAirportMetricsParams = {}) {
  const searchParams = new URLSearchParams();
  if (params.year !== undefined) searchParams.set("year", String(params.year));
  if (params.month !== undefined) searchParams.set("month", String(params.month));

  const queryString = searchParams.toString();
  const url = `/api/metrics/airport${queryString ? `?${queryString}` : ""}`;

  return useQuery<AirportMetricRow[]>({
    queryKey: ["airport-metrics", params],
    queryFn: () => customFetch<AirportMetricRow[]>(url),
  });
}
