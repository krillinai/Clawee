import { adminApi, authApi } from "./api";

export type Account = {
  userId: string;
  email: string;
  name: string;
  status: string;
  adminRoles?: string[];
  adminPermissions?: string[];
  applications?: { frontend: boolean; admin: boolean };
  dingtalkEnabled?: boolean;
  dingtalkBound?: boolean;
  localPasswordConfigured?: boolean;
};

type AccountResponse = {
  user_id?: string;
  userId?: string;
  email: string;
  name?: string;
  status: string;
};

type AuthResponseBody = {
  user?: AccountResponse;
  account?: AccountResponse;
  redirectTo?: string;
  redirect_to?: string;
  applications?: { frontend?: boolean; admin?: boolean };
  admin_roles?: string[];
  admin_permissions?: string[];
  dingtalk_enabled?: boolean;
  dingtalk_bound?: boolean;
  local_password_configured?: boolean;
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
    name: account.name ?? "",
    status: account.status
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
      adminPermissions: payload.admin_permissions,
      dingtalkEnabled: payload.dingtalk_enabled === true,
      dingtalkBound: payload.dingtalk_bound === true,
      localPasswordConfigured: payload.local_password_configured === true
    },
    redirectTo: payload.redirectTo ?? payload.redirect_to ?? (payload.applications?.admin === true ? "/admin" : "/app")
  };
}

export function hasAdminPermission(account: Account, permissionCode: string) {
  return account.adminPermissions?.includes(permissionCode) === true;
}

export function hasAnyAdminPermission(account: Account) {
  return (account.adminPermissions?.length ?? 0) > 0;
}

export async function registerAccount(input: { email: string; name: string; password: string }) {
  return mapAuthResponse(await authApi.post<AuthAPIResponse>("/register", input));
}

export async function login(input: { email: string; password: string }) {
  return mapAuthResponse(await authApi.post<AuthAPIResponse>("/login", input));
}

export function logout() {
  return authApi.post<void>("/logout", {});
}

export function unbindDingTalk(password: string) {
  return authApi.post<void>("/dingtalk/unbind", { password });
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
