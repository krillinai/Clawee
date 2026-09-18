import { useQuery } from "@tanstack/react-query";
import { createContext, useContext } from "react";

import { getAdminFeatureStatus, type AdminFeature } from "@/lib/admin-feature-api";

export const AdminFeaturesContext = createContext<Partial<Record<AdminFeature, boolean>> | undefined>(undefined);

export function useAdminFeatureEnabled(feature: AdminFeature) {
  return useContext(AdminFeaturesContext)?.[feature] !== false;
}

export function useAdminFeatures() {
  const query = useQuery({
    queryKey: ["admin-features"],
    queryFn: getAdminFeatureStatus,
    staleTime: 30000,
    retry: false
  });
  // 问题反馈需显式开启；旧版本未提供状态的其他功能保持原有行为。
  const isEnabled = (feature: AdminFeature) => query.isSuccess && (feature === "feedback"
    ? query.data.features?.feedback === true
    : query.data.features?.[feature] !== false);
  return { ...query, isEnabled };
}
