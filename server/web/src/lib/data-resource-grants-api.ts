import { adminApi } from "./api";

export type DataResourceType = {
  resourceType: string;
  name: string;
  resourceCount: number;
  actionCount: number;
  userCount: number;
  updatedAt: string | null;
};

export type DataResourceGrantResource = {
  resourceType: DataResourceType["resourceType"];
  resourceId: string;
  name: string;
  grantedActions: string[];
  availableActions: DataResourceGrantActionDefinition[];
  userCount: number;
  updatedAt: string | null;
};

export type DataResourceGrantActionDefinition = {
  action: string;
  name: string;
  description: string;
  required: boolean;
  defaultChecked: boolean;
};

export type DataResourceGrantAction = {
  action: string;
  name: string;
  description: string;
  required: boolean;
  defaultChecked: boolean;
  userCount: number;
  updatedAt: string | null;
};

export type DataResourceGrantMember = {
  userId: string;
  name: string;
  email: string;
  accountStatus: string;
  actions: string[];
  updatedAt: string;
};

export type DataResourceGrantCandidate = {
  userId: string;
  name: string;
  email: string;
};

export type DataResourceGrantUser = {
  grantId: string;
  userId: string;
  name: string;
  email: string;
  accountStatus: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

type PageMeta = { page: number; page_size: number; total: number };
type ListResponse<T> = { items: T[]; meta: PageMeta };

type DataResourceTypeResponse = {
  resource_type: DataResourceType["resourceType"];
  name: string;
  resource_count: number;
  action_count: number;
  user_count: number;
  updated_at?: string;
};

type DataResourceGrantResourceResponse = {
  resource_type: DataResourceType["resourceType"];
  resource_id: string;
  name: string;
  actions: string[];
  available_actions?: DataResourceGrantActionDefinitionResponse[];
  user_count: number;
  updated_at?: string;
};

type DataResourceGrantActionDefinitionResponse = {
  action: string;
  name: string;
  description: string;
  required: boolean;
  default_checked: boolean;
};

type DataResourceGrantActionResponse = {
  action: string;
  name: string;
  description: string;
  required: boolean;
  default_checked: boolean;
  user_count: number;
  updated_at?: string;
};

type DataResourceGrantMemberResponse = {
  user_id: string;
  name: string;
  email: string;
  account_status: string;
  actions: string[];
  updated_at: string;
};

type DataResourceGrantCandidateResponse = {
  user_id: string;
  name: string;
  email: string;
};

type DataResourceGrantUserResponse = {
  grant_id: string;
  user_id: string;
  name: string;
  email: string;
  account_status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const basePath = "/data-resource-grants";

export async function listDataResourceTypes(): Promise<DataResourceType[]> {
  const response = await adminApi.get<{ items: DataResourceTypeResponse[] }>(`${basePath}/resource-types`);
  return response.items.map((item) => ({
    resourceType: item.resource_type,
    name: item.name,
    resourceCount: item.resource_count,
    actionCount: item.action_count,
    userCount: item.user_count,
    updatedAt: item.updated_at ?? null
  }));
}

export async function searchDataResourceGrantResources(input: {
  resourceType: DataResourceType["resourceType"];
  query?: string;
  page?: number;
  pageSize?: number;
}) {
  const response = await adminApi.post<ListResponse<DataResourceGrantResourceResponse>>(`${basePath}/resources/search`, {
    resource_type: input.resourceType,
    query: input.query ?? "",
    page: input.page ?? 1,
    page_size: input.pageSize ?? 20
  });
  return {
    items: response.items.map((item) => ({
      resourceType: item.resource_type,
      resourceId: item.resource_id,
      name: item.name,
      grantedActions: item.actions,
      availableActions: (item.available_actions ?? []).map(mapActionDefinition),
      userCount: item.user_count,
      updatedAt: item.updated_at ?? null
    })),
    meta: response.meta
  };
}

export async function searchDataResourceGrantActions(input: {
  resourceType: DataResourceType["resourceType"];
  resourceId: string;
}) {
  const response = await adminApi.post<{ items: DataResourceGrantActionResponse[] }>(`${basePath}/actions/search`, {
    resource_type: input.resourceType,
    resource_id: input.resourceId
  });
  return response.items.map((item) => ({
    ...mapActionDefinition(item),
    userCount: item.user_count,
    updatedAt: item.updated_at ?? null
  }));
}

export async function listDataResourceGrantMembers(input: {
  resourceType: string;
  resourceId: string;
  query?: string;
  cursor?: string;
}) {
  const page = pageFromCursor(input.cursor);
  const response = await adminApi.post<ListResponse<DataResourceGrantMemberResponse>>(`${basePath}/members/search`, {
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    query: input.query ?? "",
    page,
    page_size: 20
  });
  return {
    items: response.items.map((item) => ({
      userId: item.user_id,
      name: item.name,
      email: item.email,
      accountStatus: item.account_status,
      actions: item.actions,
      updatedAt: item.updated_at
    })),
    meta: cursorMeta(response.meta)
  };
}

export async function listDataResourceGrantMemberCandidates(input: {
  resourceType: string;
  resourceId: string;
  query?: string;
  cursor?: string;
}) {
  const page = pageFromCursor(input.cursor);
  const response = await adminApi.post<ListResponse<DataResourceGrantCandidateResponse>>(`${basePath}/member-candidates/search`, {
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    query: input.query ?? "",
    page,
    page_size: 20
  });
  return {
    items: response.items.map((item) => ({ userId: item.user_id, name: item.name, email: item.email })),
    meta: cursorMeta(response.meta)
  };
}

export function createDataResourceGrant(input: { userId: string; resourceType: string; resourceId: string; actions: string[] }) {
  return adminApi.post(`${basePath}`, dataResourceGrantMutationInput(input));
}

export function replaceDataResourceGrant(input: { userId: string; resourceType: string; resourceId: string; actions: string[] }) {
  return adminApi.patch(`${basePath}`, dataResourceGrantMutationInput(input));
}

export function removeDataResourceGrant(input: { userId: string; resourceType: string; resourceId: string }) {
  return adminApi.post<void>(`${basePath}/remove`, {
    user_id: input.userId,
    resource_type: input.resourceType,
    resource_id: input.resourceId
  });
}

export async function searchDataResourceGrantUsers(input: {
  resourceType: DataResourceType["resourceType"];
  resourceId: string;
  action: string;
  query?: string;
  page?: number;
  pageSize?: number;
}) {
  const response = await adminApi.post<ListResponse<DataResourceGrantUserResponse>>(`${basePath}/users/search`, {
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    action: input.action,
    query: input.query ?? "",
    page: input.page ?? 1,
    page_size: input.pageSize ?? 20
  });
  return {
    items: response.items.map((item) => ({
      grantId: item.grant_id,
      userId: item.user_id,
      name: item.name,
      email: item.email,
      accountStatus: item.account_status,
      createdBy: item.created_by,
      createdAt: item.created_at,
      updatedAt: item.updated_at
    })),
    meta: response.meta
  };
}

function mapActionDefinition(item: DataResourceGrantActionDefinitionResponse): DataResourceGrantActionDefinition {
  return {
    action: item.action,
    name: item.name,
    description: item.description,
    required: item.required,
    defaultChecked: item.default_checked
  };
}

function dataResourceGrantMutationInput(input: { userId: string; resourceType: string; resourceId: string; actions: string[] }) {
  return {
    user_id: input.userId,
    resource_type: input.resourceType,
    resource_id: input.resourceId,
    actions: input.actions
  };
}

function pageFromCursor(cursor?: string) {
  const page = Number.parseInt(cursor || "1", 10);
  return Number.isFinite(page) && page > 0 ? page : 1;
}

function cursorMeta(meta: PageMeta) {
  const hasNext = meta.page * meta.page_size < meta.total;
  return { next_cursor: hasNext ? String(meta.page + 1) : "", has_next: hasNext };
}
