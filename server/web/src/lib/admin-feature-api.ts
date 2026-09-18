import { adminApi } from "./api";

export type AdminFeature = "accounts" | "account_governance" | "rbac" | "data_permissions" | "platform_branding" | "client_downloads" | "mcp" | "activity" | "agent_management" | "knowledge" | "skills" | "skill_sources" | "shared_files" | "shared_file_storage" | "shared_file_migrations" | "feedback";

export type AdminFeatureStatus = {
  features?: Partial<Record<AdminFeature, boolean>>;
};

export function getAdminFeatureStatus() {
  return adminApi.get<AdminFeatureStatus>("/status");
}
