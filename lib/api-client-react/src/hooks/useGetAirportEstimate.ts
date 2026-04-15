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
  /** True when the calendar month is fully elapsed but official data not yet published. */
  monthComplete: boolean;
  lastUpdated: string;
}

/** Single estimate for the current calendar month. */
export function useGetAirportEstimate() {
  return useQuery<AirportEstimate>({
    queryKey: ["airport-estimate"],
    queryFn:  () => customFetch<AirportEstimate>("/api/metrics/airport/estimate"),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}

/** All months in the current year without an official GAP total, oldest first. */
export function useGetPendingAirportEstimates() {
  return useQuery<AirportEstimate[]>({
    queryKey: ["airport-estimates-pending"],
    queryFn:  () => customFetch<AirportEstimate[]>("/api/metrics/airport/estimates"),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}
