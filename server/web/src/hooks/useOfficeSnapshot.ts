import { useQuery } from "@tanstack/react-query";

import { getMyOfficeSnapshot, getOfficeSnapshot } from "../lib/office-api";

export const officeQueryKey = ["office"] as const;
export const appOfficeQueryKey = ["app-office"] as const;

export function useOfficeSnapshot(scope: "admin" | "app" = "admin") {
  return useQuery({
    queryKey: scope === "app" ? appOfficeQueryKey : officeQueryKey,
    queryFn: scope === "app" ? getMyOfficeSnapshot : getOfficeSnapshot,
  });
}
