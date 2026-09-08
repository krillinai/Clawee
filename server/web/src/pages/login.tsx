import type { FormEvent } from "react";
import { useEffect, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { LogIn, ScanLine } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { AuthShell } from "@/components/auth-shell";
import { ErrorAlert } from "@/components/governance-ui";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authMethods, login } from "@/lib/auth-api";

const oauthErrors: Record<string, string> = {
  dingtalk_disabled: "钉钉登录暂未启用",
  oauth_provider_denied: "已取消钉钉授权",
  oauth_state_invalid: "登录请求已失效，请重试",
  dingtalk_upstream_unavailable: "钉钉服务暂时不可用",
  not_enterprise_member: "当前钉钉账号不是可用企业成员",
  dingtalk_email_missing: "企业资料未配置邮箱，请联系管理员",
  account_binding_required: "请先使用原密码登录并绑定钉钉",
  auto_provision_disabled: "账户尚未开通，请联系管理员",
  system_not_initialized: "系统尚未初始化",
  account_disabled: "账户已被禁用",
  identity_conflict: "钉钉身份已绑定其他账户",
  unauthorized: "登录状态已失效，请重新登录",
  internal_error: "登录失败，请稍后重试"
};

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [dingtalkEnabled, setDingtalkEnabled] = useState(false);
  const [oauthStarting, setOauthStarting] = useState(false);

  useEffect(() => {
    void authMethods().then((methods) => setDingtalkEnabled(methods.dingtalk.enabled)).catch(() => undefined);
    const query = new URLSearchParams(location.search);
    if (query.get("oauth_provider") === "dingtalk") {
      const code = query.get("oauth_error") ?? "";
      setError(oauthErrorMessage(code));
    }
  }, [location.search]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const response = await login({ email, password });
      queryClient.removeQueries({ queryKey: ["auth"] });
      navigate(loginDestination(location.state, response.redirectTo), { replace: true });
    } catch {
      setError("邮箱或密码不正确");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div className="w-full max-w-[400px]">
        <header>
          <h1 className="text-2xl font-semibold leading-8">登录管理台</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            使用企业账号登录，系统会根据账号角色进入对应工作台。
          </p>
        </header>
        <form className="mt-8 flex flex-col gap-6" onSubmit={handleSubmit}>
          <FieldGroup className="gap-5">
            <Field className="gap-2">
              <FieldLabel htmlFor="login-email">邮箱地址</FieldLabel>
              <Input
                autoComplete="email"
                id="login-email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="login-password">密码</FieldLabel>
              <Input
                autoComplete="current-password"
                id="login-password"
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </Field>
          </FieldGroup>
          {error ? <ErrorAlert>{error}</ErrorAlert> : null}
          <div className="flex flex-col gap-3">
            <Button className="w-full" disabled={submitting} type="submit" variant="primary">
              <LogIn aria-hidden="true" data-icon="inline-start" />
              {submitting ? "登录中..." : "登录"}
            </Button>
            {dingtalkEnabled ? (
              <Button
                className="w-full"
                disabled={oauthStarting}
                onClick={() => {
                  setOauthStarting(true);
                  window.location.assign(dingtalkStartURL(location.state));
                }}
                type="button"
                variant="outline"
              >
                <ScanLine aria-hidden="true" data-icon="inline-start" />
                {oauthStarting ? "正在跳转..." : "钉钉登录"}
              </Button>
            ) : null}
          </div>
          <p className="text-center text-sm text-muted-foreground">
            还没有账号？
            <Link className="ml-1 font-medium text-primary hover:underline" to="/register">
              注册账号
            </Link>
          </p>
        </form>
        <p className="mt-8 text-center text-xs leading-5 text-muted-foreground">
          Agent 访问凭证与管理台登录会话相互独立。
        </p>
      </div>
    </AuthShell>
  );
}

export function oauthErrorMessage(code: string) {
  return oauthErrors[code] ?? oauthErrors.internal_error;
}

export function dingtalkStartURL(state: unknown) {
  return `/api/v1/auth/dingtalk/start?redirect=${encodeURIComponent(oauthRedirect(state))}`;
}

function oauthRedirect(state: unknown) {
  if (!state || typeof state !== "object" || !("from" in state)) {
    return "/admin";
  }
  const from = (state as { from?: unknown }).from;
  if (typeof from !== "string" || from.includes("://") || from.startsWith("//") || /[\r\n]/.test(from)) {
    return "/admin";
  }
  return from === "/app" || from.startsWith("/app/") || from === "/admin" || from.startsWith("/admin/") ? from : "/admin";
}

function loginDestination(state: unknown, fallback: string) {
  if (!state || typeof state !== "object" || !("from" in state)) {
    return fallback;
  }
  const from = (state as { from?: unknown }).from;
  return typeof from === "string" && (from === "/admin" || from.startsWith("/admin/")) ? from : fallback;
}
