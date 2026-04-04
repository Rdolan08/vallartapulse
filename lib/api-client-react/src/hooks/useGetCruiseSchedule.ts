import { useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export interface CruiseArrival {
  ship: string;
  shipUrl: string;
  line: string;
  passengers: number;
  date: string;   // "YYYY-MM-DD"
  time: string;   // "HH:MM"
}

export function useGetCruiseSchedule() {
  return useQuery<CruiseArrival[]>({
    queryKey: ["cruise-schedule"],
    queryFn: () => customFetch<CruiseArrival[]>("/api/metrics/cruise-schedule"),
    staleTime: 12 * 60 * 60 * 1000, // 12 hours
    retry: 1,
  });
}
