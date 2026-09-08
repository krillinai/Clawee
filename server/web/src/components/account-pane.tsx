import { Check, ChevronDown, Ellipsis, LayoutDashboard, Link2, LogOut, Unlink, UserRound } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";

import { ThemeSwitcher } from "@/components/theme-switcher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { hasAnyAdminPermission, logout, unbindDingTalk, type Account } from "@/lib/auth-api";

type AccountPaneProps = {
  account?: Account;
  collapseLogout?: boolean;
  showThemeSwitcher?: boolean;
  switchTo?: "admin" | "app";
};

export const dingtalkBindURL = "/api/v1/auth/dingtalk/bind/start?redirect=/app/agents";

export function startDingTalkBinding(assign: (url: string) => void = window.location.assign.bind(window.location)) {
  assign(dingtalkBindURL);
}

export function AccountPane({ account, collapseLogout = false, showThemeSwitcher = true, switchTo }: AccountPaneProps) {
  const [unbindOpen, setUnbindOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [unbindPending, setUnbindPending] = useState(false);
  const [unbindError, setUnbindError] = useState<unknown>();
  const [unboundUserID, setUnboundUserID] = useState("");
  const isAdmin = account !== undefined && hasAnyAdminPermission(account);
  const alternatePortal = switchTo === "admin" && isAdmin
    ? { href: "/admin", icon: LayoutDashboard, label: "进入管理后台" }
    : switchTo === "app"
      ? { href: "/app/agents", icon: UserRound, label: "进入用户中心" }
      : null;
  const AlternatePortalIcon = alternatePortal?.icon;
  const accountRole = account?.adminRoles?.length
    ? account.adminRoles.join(", ")
    : isAdmin ? "后台用户" : "前台用户";
  const dingtalkBound = account?.dingtalkBound === true && account.userId !== unboundUserID;

  function closeUnbind() {
    if (unbindPending) return;
    setUnbindOpen(false);
    setPassword("");
    setUnbindError(undefined);
  }

  async function submitUnbind(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!password || unbindPending) return;
    setUnbindPending(true);
    setUnbindError(undefined);
    try {
      await unbindDingTalk(password);
      setUnboundUserID(account?.userId ?? "");
      setUnbindOpen(false);
      setPassword("");
    } catch (error) {
      setUnbindError(error);
    } finally {
      setUnbindPending(false);
    }
  }

  function signOut() {
    logout().finally(() => window.location.assign("/login"));
  }

  return (
    <>
      <Card aria-label="账户信息" className="border-border/45 bg-muted/50 shadow-none" role="group">
        <CardContent className="grid gap-2.5 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <strong className="min-w-0 flex-1 truncate text-sm">{account?.name || "用户"}</strong>
            <Badge className="shrink-0" variant="muted">
              {accountRole}
            </Badge>
            {collapseLogout ? (
              <Popover>
                <PopoverTrigger asChild>
                  <Button aria-label="账户操作" size="icon" variant="ghost">
                    <Ellipsis aria-hidden="true" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-40 p-1">
                  <Button
                    aria-label="退出登录"
                    className="w-full justify-start"
                    onClick={signOut}
                    size="sm"
                    variant="ghost"
                  >
                    <LogOut aria-hidden="true" data-icon="inline-start" />
                    退出登录
                  </Button>
                </PopoverContent>
              </Popover>
            ) : null}
          </div>
          <span className="break-all font-mono text-xs text-muted-foreground">{account?.email}</span>
          {dingtalkBound ? (
            <div className="grid gap-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Check className="size-3.5" aria-hidden="true" />
                <span className="min-w-0 flex-1">已绑定钉钉</span>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button aria-label="更多钉钉操作" size="sm" variant="ghost">
                      更多
                      <ChevronDown aria-hidden="true" data-icon="inline-end" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="w-40 p-1">
                    <Button
                      aria-label="解绑钉钉"
                      className="w-full justify-start"
                      disabled={!account.localPasswordConfigured}
                      onClick={() => setUnbindOpen(true)}
                      size="sm"
                      variant="ghost"
                    >
                      <Unlink aria-hidden="true" data-icon="inline-start" />
                      解绑钉钉
                    </Button>
                  </PopoverContent>
                </Popover>
              </div>
              {!account.localPasswordConfigured ? (
                <p className="text-xs text-muted-foreground">当前账户仅支持钉钉登录，请先联系管理员设置本地密码。</p>
              ) : null}
            </div>
          ) : account?.dingtalkEnabled ? (
            <Button
              className="w-full"
              onClick={() => startDingTalkBinding()}
              size="sm"
              variant="outline"
            >
              <Link2 aria-hidden="true" data-icon="inline-start" />
              绑定钉钉
            </Button>
          ) : null}
          {alternatePortal && AlternatePortalIcon ? (
            <Button asChild className="w-full" size="sm" variant="outline">
              <Link to={alternatePortal.href}>
                <AlternatePortalIcon aria-hidden="true" data-icon="inline-start" />
                {alternatePortal.label}
              </Link>
            </Button>
          ) : null}
          {showThemeSwitcher || !collapseLogout ? (
            <div className="flex items-center gap-2">
              {showThemeSwitcher ? <ThemeSwitcher compact /> : null}
              {!collapseLogout ? (
                <Button className="h-8 min-w-0 flex-1 px-2 text-xs" onClick={signOut} variant="secondary">
                  <LogOut aria-hidden="true" data-icon="inline-start" />
                  退出登录
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={unbindOpen}
        onOpenChange={(open) => {
          if (!open) closeUnbind();
        }}
      >
        <DialogContent>
          <form className="contents" onSubmit={submitUnbind}>
            <DialogHeader>
              <DialogTitle>解绑钉钉账户</DialogTitle>
              <DialogDescription>解绑后将无法继续使用当前钉钉账户登录，请确认本地密码可用。</DialogDescription>
            </DialogHeader>
            <FieldGroup>
              <Field data-invalid={Boolean(unbindError) || undefined}>
                <FieldLabel htmlFor="dingtalk-unbind-password">当前密码</FieldLabel>
                <Input
                  aria-invalid={Boolean(unbindError) || undefined}
                  autoComplete="current-password"
                  autoFocus
                  id="dingtalk-unbind-password"
                  onChange={(event) => {
                    setPassword(event.target.value);
                    if (unbindError) setUnbindError(undefined);
                  }}
                  required
                  type="password"
                  value={password}
                />
                <FieldDescription>密码仅用于本次身份校验。</FieldDescription>
                <FieldError>{unbindError ? unbindErrorMessage(unbindError) : null}</FieldError>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button disabled={unbindPending} onClick={closeUnbind} type="button" variant="outline">
                取消
              </Button>
              <Button disabled={!password || unbindPending} type="submit" variant="destructive">
                <Unlink aria-hidden="true" data-icon="inline-start" />
                {unbindPending ? "解绑中..." : "确认解绑"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function unbindErrorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "解绑失败，请稍后重试。";
}
