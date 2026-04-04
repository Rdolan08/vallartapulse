import { useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export type EstimateStatus     = "estimated" | "official";
export type EstimateConfidence = "low" | "medium" | "high";

export interface AirportEstimate {
  airportCode: "PVR";
  month: number;
  year: number;
  daysElapsed: number;
  daysInMonth: number;
  officialPassengers: number | null;
  estimatedPassengersToDate: number;
  projectedFullMonthPassengers: number;
  averageDailyPassengersToDate: number;
  sameMonthLastYearPassengers: number | null;
  estimatedVsSameMonthLastYearPct: number | null;
  estimateGapVsLastOfficialMonthPct: number | null;
  confidence: EstimateConfidence;
  status: EstimateStatus;
  lastUpdated: string;
}

export function useGetAirportEstimate() {
  return useQuery<AirportEstimate>({
    queryKey: ["airport-estimate"],
    queryFn: () => customFetch<AirportEstimate>("/api/metrics/airport/estimate"),
    staleTime: 60 * 60 * 1000, // re-fetch at most once per hour (estimate barely changes intra-day)
    retry: 1,
  });
}
