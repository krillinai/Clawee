import { Check, Download, Ellipsis, ImagePlus, Link2, LogOut, RotateCcw } from "lucide-react";
import { type ChangeEvent, type ReactNode, useRef, useState } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { deleteAccountAvatar, hasAnyAdminPermission, logout, uploadAccountAvatar, type Account } from "@/lib/auth-api";

type AccountPaneProps = {
  account?: Account;
  switchTo?: "admin" | "app";
  accountActions?: ReactNode;
};

export const dingtalkBindURL = "/api/v1/auth/dingtalk/bind/start?redirect=/app/agents";

export function startDingTalkBinding(assign: (url: string) => void = window.location.assign.bind(window.location)) {
  assign(dingtalkBindURL);
}

export function AccountPane({ account, switchTo, accountActions }: AccountPaneProps) {
  const [avatarNonce, setAvatarNonce] = useState(0);
  const [avatarOpen, setAvatarOpen] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string>();
  const [failedAvatarSrc, setFailedAvatarSrc] = useState<string>();
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const accountNameRef = useRef<HTMLButtonElement>(null);
  const isAdmin = account !== undefined && hasAnyAdminPermission(account);
  const alternatePortal = switchTo === "admin" && isAdmin
    ? { href: "/admin", label: "管理后台" }
    : switchTo === "app"
      ? { href: "/app/agents", label: "用户中心" }
      : null;
  const accountRole = account?.adminRoleNames?.length
    ? account.adminRoleNames.join("、")
    : isAdmin ? "后台用户" : "前台用户";

  function signOut() {
    logout().finally(() => window.location.assign("/login"));
  }

  async function changeAvatar(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError(undefined);
    try {
      await uploadAccountAvatar(file);
      setAvatarNonce(Date.now());
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "头像上传失败");
    } finally {
      setAvatarBusy(false);
    }
  }

  async function restoreAvatar() {
    if (avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError(undefined);
    try {
      await deleteAccountAvatar();
      setAvatarNonce(Date.now());
    } catch (error) {
      setAvatarError(error instanceof Error ? error.message : "头像恢复失败");
    } finally {
      setAvatarBusy(false);
    }
  }

  const avatarLabel = (account?.name || account?.phone || account?.email || "用户").trim().slice(0, 1).toUpperCase() || "用";
  const avatarSrc = account?.avatarUrl ? `${account.avatarUrl}${avatarNonce ? `?v=${avatarNonce}` : ""}` : undefined;
  const showAvatar = avatarSrc !== undefined && avatarSrc !== failedAvatarSrc;

  return (
    <>
      <Card aria-label="账户信息" className="border-border/45 bg-muted/50 shadow-none" role="group">
        <CardContent className="grid gap-2.5 p-3">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-primary/10 text-sm font-semibold text-primary">
              <span aria-hidden={showAvatar ? "true" : undefined}>{avatarLabel}</span>
              {showAvatar ? <img alt="" className="absolute inset-0 size-full object-cover" onError={() => setFailedAvatarSrc(avatarSrc)} src={avatarSrc} /> : null}
            </div>
            <div className="grid min-w-0 flex-1 gap-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  aria-haspopup="dialog"
                  className="min-w-0 flex-1 truncate rounded-sm text-left text-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => { setAvatarError(undefined); setAvatarOpen(true); }}
                  ref={accountNameRef}
                  title="设置头像"
                  type="button"
                >
                  {account?.name || "用户"}
                </button>
                <Badge className="min-w-0 max-w-[65%] shrink-0 border-transparent px-1 text-[10px]" title={accountRole} variant="muted">
                  <span className="truncate">{accountRole}</span>
                </Badge>
              </div>
              <span className="truncate text-xs text-muted-foreground" title={account?.phone || account?.email}>{account?.phone || account?.email}</span>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <Button aria-label="账户操作" className="size-7 shrink-0 [&_svg]:size-4" size="icon" variant="ghost">
                  <Ellipsis aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-40 p-1">
                {account?.dingtalkBound ? (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                    <Check aria-hidden="true" className="size-3.5" />
                    已绑定钉钉
                  </div>
                ) : account?.dingtalkEnabled ? (
                  <Button className="w-full justify-start" onClick={() => startDingTalkBinding()} size="sm" variant="ghost">
                    <Link2 aria-hidden="true" data-icon="inline-start" />
                    绑定钉钉
                  </Button>
                ) : null}
                {accountActions}
                {account?.dingtalkBound || account?.dingtalkEnabled || accountActions ? <Separator className="my-1" /> : null}
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
          </div>
          <div className="flex min-w-0 items-center justify-between gap-1">
            {alternatePortal ? (
              <Button asChild className="h-7 shrink-0 px-0.5 text-xs" size="sm" variant="ghost">
                <Link to={alternatePortal.href}>
                  <span>{alternatePortal.label}</span>
                </Link>
              </Button>
            ) : null}
            <div aria-label="快捷操作" className="ml-auto flex shrink-0 items-center gap-1" role="group">
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button asChild className="size-7 [&_svg]:size-3.5" size="icon" variant="outline">
                      <Link aria-label="下载客户端" to="/downloads">
                        <Download aria-hidden="true" />
                      </Link>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>下载客户端</TooltipContent>
                </Tooltip>
              </TooltipProvider>
              <ThemeSwitcher compact />
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={avatarOpen} onOpenChange={(open) => { if (!avatarBusy) setAvatarOpen(open); }}>
        <DialogContent className="sm:max-w-sm" onCloseAutoFocus={(event) => { event.preventDefault(); accountNameRef.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>头像设置</DialogTitle>
            <DialogDescription>PNG / JPEG</DialogDescription>
          </DialogHeader>
          <div className="relative mx-auto grid size-20 place-items-center overflow-hidden rounded-full bg-primary/10 text-2xl font-semibold text-primary">
            <span aria-hidden={showAvatar ? "true" : undefined}>{avatarLabel}</span>
            {showAvatar ? <img alt="当前头像" className="absolute inset-0 size-full object-cover" onError={() => setFailedAvatarSrc(avatarSrc)} src={avatarSrc} /> : null}
          </div>
          <input accept="image/jpeg,image/png" aria-label="选择头像图片" className="hidden" disabled={avatarBusy} onChange={changeAvatar} ref={avatarInputRef} type="file" />
          <div className="flex flex-wrap justify-center gap-2">
            <Button disabled={avatarBusy} onClick={() => avatarInputRef.current?.click()} variant="outline">
              <ImagePlus aria-hidden="true" data-icon="inline-start" />
              {avatarBusy ? "处理中..." : "更换头像"}
            </Button>
            <Button disabled={avatarBusy} onClick={restoreAvatar} variant="ghost">
              <RotateCcw aria-hidden="true" data-icon="inline-start" />
              恢复默认头像
            </Button>
          </div>
          {avatarError ? <p className="text-sm text-destructive" role="alert">{avatarError}</p> : null}
          <DialogFooter>
            <Button disabled={avatarBusy} onClick={() => setAvatarOpen(false)} variant="outline">完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
