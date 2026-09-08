import type { FormEvent } from "react";
import { useState } from "react";

import { ShieldCheck, UserPlus } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";

import { AuthShell } from "@/components/auth-shell";
import { ErrorAlert } from "@/components/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { registerAccount } from "@/lib/auth-api";

export function RegisterPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const normalizedName = name.trim();
    if (!normalizedName) return;
    setSubmitting(true);
    try {
      const response = await registerAccount({ email: email.trim(), name: normalizedName, password });
      navigate(response.redirectTo, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "注册失败");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthShell>
      <div className="w-full max-w-[400px]">
        <header>
          <h1 className="text-2xl font-semibold leading-8">注册账号</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            创建管理台账号，系统会根据当前账号状态自动分配角色。
          </p>
        </header>
        <form className="mt-8 flex flex-col gap-6" onSubmit={handleSubmit}>
          <FieldGroup className="gap-5">
            <Field className="gap-2">
              <FieldLabel htmlFor="register-email">邮箱地址</FieldLabel>
              <Input
                autoComplete="email"
                id="register-email"
                name="email"
                onChange={(event) => setEmail(event.target.value)}
                required
                type="email"
                value={email}
              />
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="register-name">姓名</FieldLabel>
              <Input
                autoComplete="name"
                id="register-name"
                name="name"
                onChange={(event) => setName(event.target.value)}
                required
                type="text"
                value={name}
              />
            </Field>
            <Field className="gap-2">
              <FieldLabel htmlFor="register-password">密码</FieldLabel>
              <Input
                autoComplete="new-password"
                id="register-password"
                name="password"
                onChange={(event) => setPassword(event.target.value)}
                required
                type="password"
                value={password}
              />
            </Field>
          </FieldGroup>
          <Alert variant="muted">
            <ShieldCheck aria-hidden="true" />
            <AlertTitle>角色分配规则</AlertTitle>
            <AlertDescription>
              系统没有账号时，首个账号成为管理员；后续注册账号默认为普通用户。
            </AlertDescription>
          </Alert>
          {error ? <ErrorAlert>{error}</ErrorAlert> : null}
          <Button className="w-full" disabled={submitting || !name.trim()} type="submit" variant="primary">
            <UserPlus aria-hidden="true" data-icon="inline-start" />
            {submitting ? "注册中..." : "注册并进入"}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            已有账号？
            <Link className="ml-1 font-medium text-primary hover:underline" to="/login">
              返回登录
            </Link>
          </p>
        </form>
      </div>
    </AuthShell>
  );
}
