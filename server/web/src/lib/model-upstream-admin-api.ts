import { adminApi } from "./api";

export type ModelUpstreamAccount = {
  id: string;
  name: string;
  baseUrl: string;
  models: string[];
  syncedModels: string[];
  manualModels: string[];
  modelSyncAt: string | null;
  modelSyncError: string;
  status: "active" | "disabled";
  healthStatus: string;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ModelGroupAccount = {
  upstreamAccountId: string;
  name: string;
  baseUrl: string;
  models: string[];
  status: string;
  healthStatus: string;
  priority: number;
  weight: number;
};

export type ModelGroup = {
  id: string;
  name: string;
  routeStrategy: "failover" | "round_robin";
  defaultModel: string;
  status: "active" | "disabled";
  accounts: ModelGroupAccount[];
  createdAt: string;
  updatedAt: string;
};

type ModelUpstreamAccountResponse = {
  id: string;
  name: string;
  base_url: string;
  models?: string[];
  synced_models?: string[];
  manual_models?: string[];
  model_sync_at?: string | null;
  model_sync_error?: string;
  status: "active" | "disabled";
  health_status?: string;
  has_api_key?: boolean;
  created_at: string;
  updated_at: string;
};

type ModelGroupAccountResponse = {
  upstream_account_id: string;
  name: string;
  base_url: string;
  models?: string[];
  status: string;
  health_status?: string;
  priority: number;
  weight: number;
};

type ModelGroupResponse = {
  id: string;
  name: string;
  route_strategy: "failover" | "round_robin";
  default_model: string;
  status: "active" | "disabled";
  accounts?: ModelGroupAccountResponse[];
  created_at: string;
  updated_at: string;
};

function mapAccount(item: ModelUpstreamAccountResponse): ModelUpstreamAccount {
  const models = item.models ?? [];
  const syncedModels = item.synced_models ?? [];
  const manualModels = item.manual_models ?? (syncedModels.length ? [] : models);
  return {
    id: item.id,
    name: item.name,
    baseUrl: item.base_url,
    models,
    syncedModels,
    manualModels,
    modelSyncAt: item.model_sync_at ?? null,
    modelSyncError: item.model_sync_error ?? "",
    status: item.status,
    healthStatus: item.health_status ?? "unknown",
    hasApiKey: item.has_api_key === true,
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

function mapGroup(item: ModelGroupResponse): ModelGroup {
  return {
    id: item.id,
    name: item.name,
    routeStrategy: item.route_strategy,
    defaultModel: item.default_model,
    status: item.status,
    accounts: (item.accounts ?? []).map((account) => ({
      upstreamAccountId: account.upstream_account_id,
      name: account.name,
      baseUrl: account.base_url,
      models: account.models ?? [],
      status: account.status,
      healthStatus: account.health_status ?? "unknown",
      priority: account.priority,
      weight: account.weight
    })),
    createdAt: item.created_at,
    updatedAt: item.updated_at
  };
}

export async function listModelUpstreamAccounts() {
  const response = await adminApi.get<{ items: ModelUpstreamAccountResponse[] }>("/model-proxy/upstream-accounts");
  return response.items.map(mapAccount);
}

export async function createModelUpstreamAccount(input: {
  name: string;
  baseUrl: string;
  apiKey: string;
  syncedModels?: string[];
  manualModels: string[];
  status: "active" | "disabled";
}) {
  return mapAccount(await adminApi.post<ModelUpstreamAccountResponse>("/model-proxy/upstream-accounts", {
    name: input.name,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    models: input.manualModels,
    synced_models: input.syncedModels,
    manual_models: input.manualModels,
    status: input.status
  }));
}

export async function updateModelUpstreamAccount(input: {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  syncedModels?: string[];
  manualModels: string[];
  status: "active" | "disabled";
}) {
  return mapAccount(await adminApi.put<ModelUpstreamAccountResponse>("/model-proxy/upstream-accounts", {
    id: input.id,
    name: input.name,
    base_url: input.baseUrl,
    api_key: input.apiKey,
    models: input.manualModels,
    synced_models: input.syncedModels,
    manual_models: input.manualModels,
    status: input.status
  }));
}

export async function previewModelUpstreamModels(input: { baseUrl: string; apiKey: string }) {
  const response = await adminApi.post<{ models: string[] }>("/model-proxy/upstream-accounts/preview-models", {
    base_url: input.baseUrl,
    api_key: input.apiKey
  });
  return response.models ?? [];
}

export async function syncModelUpstreamAccount(id: string) {
  return mapAccount(await adminApi.post<ModelUpstreamAccountResponse>("/model-proxy/upstream-accounts/sync", { id }));
}

export async function testModelUpstreamAccount(id: string) {
  const response = await adminApi.post<{ model: string; reply: string; latency_ms: number }>("/model-proxy/upstream-accounts/test", { id });
  return {
    model: response.model,
    reply: response.reply,
    latencyMs: response.latency_ms
  };
}

export async function deleteModelUpstreamAccount(id: string) {
  await adminApi.post<void>("/model-proxy/upstream-accounts/remove", { id });
}

export async function listModelGroups() {
  const response = await adminApi.get<{ items: ModelGroupResponse[] }>("/model-proxy/groups");
  return response.items.map(mapGroup);
}

export async function createModelGroup(input: {
  name: string;
  routeStrategy: "failover" | "round_robin";
  defaultModel: string;
  status: "active" | "disabled";
  accounts: Array<{ upstreamAccountId: string; priority: number; weight: number }>;
}) {
  return mapGroup(await adminApi.post<ModelGroupResponse>("/model-proxy/groups", {
    name: input.name,
    route_strategy: input.routeStrategy,
    default_model: input.defaultModel,
    status: input.status,
    accounts: input.accounts.map((account) => ({
      upstream_account_id: account.upstreamAccountId,
      priority: account.priority,
      weight: account.weight
    }))
  }));
}

export async function updateModelGroup(input: {
  id: string;
  name: string;
  routeStrategy: "failover" | "round_robin";
  defaultModel: string;
  status: "active" | "disabled";
  accounts: Array<{ upstreamAccountId: string; priority: number; weight: number }>;
}) {
  return mapGroup(await adminApi.put<ModelGroupResponse>("/model-proxy/groups", {
    id: input.id,
    name: input.name,
    route_strategy: input.routeStrategy,
    default_model: input.defaultModel,
    status: input.status,
    accounts: input.accounts.map((account) => ({
      upstream_account_id: account.upstreamAccountId,
      priority: account.priority,
      weight: account.weight
    }))
  }));
}

export async function deleteModelGroup(id: string) {
  await adminApi.post<void>("/model-proxy/groups/remove", { id });
}
