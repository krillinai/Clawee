import { publicApi } from "./api";

export const permissions = {
  accountRead: "console:account:read",
  accountManage: "console:account:manage",
  accountMerge: "console:account:merge",
  rbacRead: "console:rbac:read",
  rbacManage: "console:rbac:manage",
  agentRead: "console:agent:read",
  agentManage: "console:agent:manage",
  agentTransfer: "console:agent:transfer",
  collectorRead: "console:collector:read",
  collectorManage: "console:collector:manage",
  mcpUpstreamRead: "console:mcp:upstream:read",
  mcpUpstreamManage: "console:mcp:upstream:manage",
  mcpCapabilityRead: "console:mcp:capability:read",
  mcpCapabilityManage: "console:mcp:capability:manage",
  mcpGrantRead: "console:mcp:grant:read",
  mcpGrantManage: "console:mcp:grant:manage",
  mcpGateRead: "console:mcp:gate:read",
  mcpGateManage: "console:mcp:gate:manage",
  mcpAuditRead: "console:mcp:audit:read",
  activityRead: "console:activity:read",
  knowledgeRead: "console:knowledge:read",
  knowledgeManage: "console:knowledge:manage",
  skillRead: "console:skill:read",
  skillManage: "console:skill:manage",
  sharedFilesRead: "console:shared_files:read",
  sharedFilesManage: "console:shared_files:manage",
  dataResourceGrantRead: "console:data_resource_grant:read",
  dataResourceGrantManage: "console:data_resource_grant:manage",
  platformBrandingManage: "console:platform_branding:manage"
} as const;

export type Permission = {
  code: string;
  module: string;
  action: string;
  name: string;
  description: string;
};

export type Role = {
  roleId: string;
  code: string;
  name: string;
  isSystem: boolean;
  permissionCodes: string[];
  createdAt: string;
  updatedAt: string;
};

export type AccountRole = {
  accountId: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  isSystem: boolean;
  createdAt: string;
};

type ListResponse<T> = { data: T[] };
type ItemResponse<T> = { data: T };

type RoleResponse = {
  role_id: string;
  code: string;
  name: string;
  is_system: boolean;
  permission_codes: string[];
  created_at: string;
  updated_at: string;
};

type AccountRoleResponse = {
	user_id: string;
  role_id: string;
  role_code: string;
  role_name: string;
  is_system: boolean;
  created_at: string;
};

const basePath = "/api/v1/admin/rbac";

export async function listPermissions(): Promise<Permission[]> {
  return (await publicApi.get<ListResponse<Permission>>(`${basePath}/permissions`)).data;
}

export async function listRoles(): Promise<Role[]> {
  return (await publicApi.get<ListResponse<RoleResponse>>(`${basePath}/roles`)).data.map(mapRole);
}

export async function createRole(input: { code: string; name: string; permissionCodes: string[] }): Promise<Role> {
  const response = await publicApi.post<ItemResponse<RoleResponse>>(`${basePath}/roles`, {
    code: input.code,
    name: input.name,
    permission_codes: input.permissionCodes
  });
  return mapRole(response.data);
}

export async function updateRole(input: { roleId: string; name: string; permissionCodes: string[] }): Promise<Role> {
  const response = await publicApi.patch<ItemResponse<RoleResponse>>(`${basePath}/roles`, {
    role_id: input.roleId,
    name: input.name,
    permission_codes: input.permissionCodes
  });
  return mapRole(response.data);
}

export function removeRole(roleId: string) {
  return publicApi.post<void>(`${basePath}/roles/remove`, { role_id: roleId });
}

export async function listAccountRoles(accountId: string): Promise<AccountRole[]> {
  const response = await publicApi.get<ListResponse<AccountRoleResponse>>(
		`${basePath}/account-roles?user_id=${encodeURIComponent(accountId)}`
  );
  return response.data.map(mapAccountRole);
}

export function assignAccountRole(accountId: string, roleId: string) {
	return publicApi.post(`${basePath}/account-roles`, { user_id: accountId, role_id: roleId });
}

export function removeAccountRole(accountId: string, roleId: string) {
	return publicApi.post<void>(`${basePath}/account-roles/remove`, { user_id: accountId, role_id: roleId });
}

function mapRole(role: RoleResponse): Role {
  return {
    roleId: role.role_id,
    code: role.code,
    name: role.name,
    isSystem: role.is_system,
    permissionCodes: role.permission_codes,
    createdAt: role.created_at,
    updatedAt: role.updated_at
  };
}

function mapAccountRole(role: AccountRoleResponse): AccountRole {
  return {
		accountId: role.user_id,
    roleId: role.role_id,
    roleCode: role.role_code,
    roleName: role.role_name,
    isSystem: role.is_system,
    createdAt: role.created_at
  };
}
