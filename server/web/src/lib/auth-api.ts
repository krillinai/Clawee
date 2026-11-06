import { adminApi, authApi } from "./api";

export type Account = {
  userId: string;
  email: string;
  phone?: string;
  name: string;
  status: string;
  adminRoles?: string[];
  adminRoleNames?: string[];
  adminPermissions?: string[];
  applications?: { frontend: boolean; admin: boolean };
  dingtalkEnabled?: boolean;
  dingtalkBound?: boolean;
  localPasswordConfigured?: boolean;
  modelGatewayEnabled?: boolean;
  avatarUrl?: string;
};

type AccountResponse = {
  user_id?: string;
  userId?: string;
  email: string;
  phone?: string;
  name?: string;
  status: string;
  avatar_url?: string;
};

type AuthResponseBody = {
  user?: AccountResponse;
  account?: AccountResponse;
  redirectTo?: string;
  redirect_to?: string;
  applications?: { frontend?: boolean; admin?: boolean };
  admin_roles?: string[];
  admin_role_names?: string[];
  admin_permissions?: string[];
  dingtalk_enabled?: boolean;
  dingtalk_bound?: boolean;
  local_password_configured?: boolean;
  model_gateway_enabled?: boolean;
};

type AuthAPIResponse = AuthResponseBody & { data?: AuthResponseBody };

export type AuthResponse = {
  user: Account;
  redirectTo: string;
};

function mapAccount(account: AccountResponse): Account {
  return {
    userId: account.userId ?? account.user_id ?? "",
    email: account.email,
    ...(account.phone ? { phone: account.phone } : {}),
    name: account.name ?? "",
    status: account.status,
    avatarUrl: account.avatar_url
  };
}

function mapAuthResponse(response: AuthAPIResponse): AuthResponse {
  const payload = response.data ?? response;
  const account = payload.user ?? payload.account;
  if (!account) {
    throw new Error("auth response missing user");
  }
  return {
    user: {
      ...mapAccount(account),
      applications: payload.applications
        ? { frontend: payload.applications.frontend !== false, admin: payload.applications.admin === true }
        : undefined,
      adminRoles: payload.admin_roles,
      adminRoleNames: payload.admin_role_names,
      adminPermissions: payload.admin_permissions,
      dingtalkEnabled: payload.dingtalk_enabled === true,
      dingtalkBound: payload.dingtalk_bound === true,
      localPasswordConfigured: payload.local_password_configured === true,
      modelGatewayEnabled: payload.model_gateway_enabled !== false
    },
    redirectTo: payload.redirectTo ?? payload.redirect_to ?? (payload.applications?.admin === true ? "/admin" : "/app")
  };
}

export function hasAdminPermission(account: Account, permissionCode: string) {
  const granted = account.adminPermissions ?? [];
  if (granted.includes(permissionCode)) return true;
  const segments = permissionCode.split(":");
  if (segments.length < 3) return false;
  segments[segments.length - 1] = "manage";
  return granted.includes(segments.join(":"));
}

export function hasAnyAdminPermission(account: Account) {
  return (account.adminPermissions?.length ?? 0) > 0;
}

export function accountIdentifierInput(value: string): { email: string } | { phone: string } {
  const identifier = value.trim();
  return identifier.includes('@') ? { email: identifier } : { phone: identifier };
}

export async function registerAccount(input: { email?: string; phone?: string; name: string; password: string }) {
  return mapAuthResponse(await authApi.post<AuthAPIResponse>("/register", input));
}

export async function login(input: { email?: string; phone?: string; password: string }) {
  return mapAuthResponse(await authApi.post<AuthAPIResponse>("/login", input));
}

export function logout() {
  return authApi.post<void>("/logout", {});
}

export function uploadAccountAvatar(file: File) {
  const body = new FormData();
  body.set("avatar", file);
  return authApi.postForm<{ avatar_url?: string }>("/avatar", body);
}

export function deleteAccountAvatar() {
  return authApi.delete("/avatar");
}

export async function currentAccount() {
  return mapAuthResponse(await authApi.get<AuthAPIResponse>("/me"));
}

export function validateAdminSession() {
  return adminApi.get<{ service: string; status: string }>("/status");
}

export async function authMethods() {
  const response = await authApi.get<{
    data?: { password?: boolean; dingtalk?: { enabled?: boolean } };
    password?: boolean;
    dingtalk?: { enabled?: boolean };
  }>("/methods");
  const payload = response.data ?? response;
  return { password: payload.password !== false, dingtalk: { enabled: payload.dingtalk?.enabled === true } };
}
