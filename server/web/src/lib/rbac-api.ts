import { publicApi } from "./api";

export const permissions = {
  accountRead: "console:account:read",
  accountManage: "console:account:manage",
  accountCreate: "console:account:create",
  accountUpdateName: "console:account:update_name",
  accountUpdateStatus: "console:account:update_status",
  accountResetPassword: "console:account:reset_password",
  accountMerge: "console:account:merge",
  rbacRead: "console:rbac:read",
  rbacManage: "console:rbac:manage",
  rbacRoleCreate: "console:rbac:role_create",
  rbacRoleUpdate: "console:rbac:role_update",
  rbacRoleDelete: "console:rbac:role_delete",
  rbacAccountRoleUpdate: "console:rbac:account_role_update",
  agentRead: "console:agent:read",
  agentManage: "console:agent:manage",
  agentCreate: "console:agent:create",
  agentDelete: "console:agent:delete",
  agentTokenReveal: "console:agent:token_reveal",
  agentTokenRotate: "console:agent:token_rotate",
  agentTokenRevoke: "console:agent:token_revoke",
  agentBind: "console:agent:bind",
  agentUnbind: "console:agent:unbind",
  agentTransfer: "console:agent:transfer",
  collectorRead: "console:collector:read",
  collectorManage: "console:collector:manage",
  collectorRegistrationCodeCreate: "console:collector:registration_code_create",
  collectorTokenRevoke: "console:collector:token_revoke",
  collectorDelete: "console:collector:delete",
  mcpUpstreamRead: "console:mcp:upstream:read",
  mcpUpstreamManage: "console:mcp:upstream:manage",
  mcpUpstreamCreate: "console:mcp:upstream:create",
  mcpUpstreamUpdate: "console:mcp:upstream:update",
  mcpUpstreamDelete: "console:mcp:upstream:delete",
  mcpUpstreamSync: "console:mcp:upstream:sync",
  mcpUpstreamUpdateStatus: "console:mcp:upstream:update_status",
  mcpCapabilityRead: "console:mcp:capability:read",
  mcpCapabilityManage: "console:mcp:capability:manage",
  mcpCapabilityUpdateStatus: "console:mcp:capability:update_status",
  mcpCapabilityRename: "console:mcp:capability:rename",
  mcpCapabilityDelete: "console:mcp:capability:delete",
  mcpCapabilityUpdateGatePolicy: "console:mcp:capability:update_gate_policy",
  mcpGrantRead: "console:mcp:grant:read",
  mcpGrantManage: "console:mcp:grant:manage",
  mcpGrantCreate: "console:mcp:grant:create",
  mcpGrantRevoke: "console:mcp:grant:revoke",
  mcpGateRead: "console:mcp:gate:read",
  mcpGateManage: "console:mcp:gate:manage",
  mcpGateApprove: "console:mcp:gate:approve",
  mcpGateReject: "console:mcp:gate:reject",
  mcpAuditRead: "console:mcp:audit:read",
  activityRead: "console:activity:read",
  knowledgeRead: "console:knowledge:read",
  knowledgeManage: "console:knowledge:manage",
  knowledgeCreate: "console:knowledge:create",
  knowledgeUpdate: "console:knowledge:update",
  knowledgeDelete: "console:knowledge:delete",
  knowledgeMemberUpdate: "console:knowledge:member_update",
  knowledgeDocumentUpload: "console:knowledge:document_upload",
  knowledgeDocumentSync: "console:knowledge:document_sync",
  knowledgeDocumentDelete: "console:knowledge:document_delete",
  skillRead: "console:skill:read",
  skillManage: "console:skill:manage",
  skillVersionUpload: "console:skill:version_upload",
  skillMove: "console:skill:move",
  skillPublish: "console:skill:publish",
  skillUnpublish: "console:skill:unpublish",
  skillSpaceCreate: "console:skill:space_create",
  skillSpaceUpdate: "console:skill:space_update",
  skillSpaceMemberUpdate: "console:skill:space_member_update",
  skillSourceCreate: "console:skill:source_create",
  skillSourceUpdate: "console:skill:source_update",
  skillSourceTokenReveal: "console:skill:source_token_reveal",
  skillSourceSync: "console:skill:source_sync",
  skillSourceScan: "console:skill:source_scan",
  skillSourceEnable: "console:skill:source_enable",
  skillSourceDisable: "console:skill:source_disable",
  skillSourceTokenRemove: "console:skill:source_token_remove",
  skillSourceBind: "console:skill:source_bind",
  skillSourceUnbind: "console:skill:source_unbind",
  sharedFilesRead: "console:shared_files:read",
  sharedFilesManage: "console:shared_files:manage",
  sharedFilesSpaceCreate: "console:shared_files:space_create",
  sharedFilesSpaceUpdate: "console:shared_files:space_update",
  sharedFilesMemberUpdate: "console:shared_files:member_update",
  sharedFilesDownload: "console:shared_files:download",
  sharedFilesUpload: "console:shared_files:upload",
  dataResourceGrantRead: "console:data_resource_grant:read",
  dataResourceGrantManage: "console:data_resource_grant:manage",
  dataResourceGrantCreate: "console:data_resource_grant:create",
  dataResourceGrantUpdate: "console:data_resource_grant:update",
  dataResourceGrantDelete: "console:data_resource_grant:delete",
  platformBrandingRead: "console:platform_branding:read",
  platformBrandingManage: "console:platform_branding:manage",
  platformBrandingUpdate: "console:platform_branding:update"
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
