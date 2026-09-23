import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp, Moon, RotateCcw, Save, Sun, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { APIError } from "@/lib/api";
import {
  getPlatformBranding,
  updatePlatformBranding,
  type PlatformBrandingAction,
  type SidebarMenuKey
} from "@/lib/platform-branding-api";
import { cn } from "@/lib/utils";
import { permissions } from "@/lib/rbac-api";
import { trimInput } from "@/lib/text";

const MAX_IMAGE_BYTES = 1024 * 1024;
const sidebarMenus: Array<{ key: SidebarMenuKey; label: string; defaultName: string }> = [
  { key: "skills", label: "企业 Skill 名称", defaultName: "企业Skill" },
  { key: "knowledge", label: "企业知识库名称", defaultName: "企业知识库" },
  { key: "drive", label: "共享网盘名称", defaultName: "共享网盘" },
  { key: "dashboard", label: "数据看板名称", defaultName: "数据看板" }
];

function menuLabelError(value: string | null | undefined): string | undefined {
  if (value == null) return undefined;
  const normalized = trimInput(value);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(normalized)) return "不能包含换行或控制字符";
  const length = Array.from(normalized).length;
  return length < 1 || length > 10 ? "名称必须为 1～10 个字符" : undefined;
}

function adminUrlError(value: string): string | undefined {
  if (!value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password
      && !/\s/.test(value.trim()) && value.trim().length <= 2048) return undefined;
  } catch { /* Invalid URL. */ }
  return "请输入有效的 HTTP 或 HTTPS 地址（最多 2048 字符）";
}

type LogoDraft = {
  action: PlatformBrandingAction;
  file?: File;
  objectUrl?: string;
};

export function PlatformBrandingPage() {
  const canUpdate = useAdminPermission(permissions.platformBrandingUpdate);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["platform-branding"], queryFn: getPlatformBranding });
  const [background, setBackground] = useState<"light" | "dark">("light");
  const [sidebarLogo, setSidebarLogo] = useState<LogoDraft>({ action: "keep" });
  const [compactLogo, setCompactLogo] = useState<LogoDraft>({ action: "keep" });
  const [menuDraft, setMenuDraft] = useState<Partial<Record<SidebarMenuKey, string | null>>>({});
  const [adminUrlDraft, setAdminUrlDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string }>();
  const [previewRevision, setPreviewRevision] = useState(0);
  const objectUrlsRef = useRef(new Set<string>());

  useEffect(() => () => {
    for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
    objectUrlsRef.current.clear();
  }, []);

  if (query.isLoading) return <PageShell><LoadingState label="正在加载平台外观" /></PageShell>;
  if (query.isError || !query.data) {
    return <PageShell><ErrorAlert error={query.error}>平台外观加载失败，请稍后重试。</ErrorAlert></PageShell>;
  }

  const branding = query.data;
  const hasChanges = sidebarLogo.action !== "keep" || compactLogo.action !== "keep" || Object.keys(menuDraft).length > 0 || adminUrlDraft !== undefined;
  const hasInvalidMenu = Object.values(menuDraft).some(value => menuLabelError(value) !== undefined);
  const urlError = adminUrlDraft === undefined ? undefined : adminUrlError(adminUrlDraft);
  const hasCustomBranding = hasCustomLogo(sidebarLogo, branding.sidebarLogoConfigured)
    || hasCustomLogo(compactLogo, branding.sidebarCompactLogoConfigured)
    || sidebarMenus.some(({ key }) => (menuDraft[key] === undefined ? branding.sidebarMenuLabels?.[key] : menuDraft[key]) != null)
    || Boolean(adminUrlDraft === undefined ? branding.adminUrl : adminUrlDraft);

  function replaceDraft(current: LogoDraft, file: File, update: (draft: LogoDraft) => void) {
    if (!isSupportedImage(file)) {
      setNotice({ kind: "error", message: "请选择不超过 1 MiB 的 PNG 或 JPEG 图片。" });
      return;
    }
    releaseObjectUrl(current.objectUrl);
    const objectUrl = URL.createObjectURL(file);
    objectUrlsRef.current.add(objectUrl);
    update({ action: "replace", file, objectUrl });
    setNotice(undefined);
  }

  function resetDraft(current: LogoDraft, update: (draft: LogoDraft) => void) {
    releaseObjectUrl(current.objectUrl);
    update({ action: "reset" });
    setNotice(undefined);
  }

  function restoreDefaults() {
    resetDraft(sidebarLogo, setSidebarLogo);
    resetDraft(compactLogo, setCompactLogo);
    setMenuDraft(current => Object.fromEntries(sidebarMenus
      .filter(({ key }) => current[key] !== undefined || branding.sidebarMenuLabels?.[key] !== undefined)
      .map(({ key }) => [key, null])));
    if (adminUrlDraft !== undefined || branding.adminUrl) setAdminUrlDraft("");
  }

  async function save() {
    if (hasInvalidMenu || urlError) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const updated = await updatePlatformBranding({
        sidebarLogoAction: sidebarLogo.action,
        sidebarLogo: sidebarLogo.file,
        sidebarCompactLogoAction: compactLogo.action,
        sidebarCompactLogo: compactLogo.file,
        ...(adminUrlDraft === undefined ? {} : { adminUrl: adminUrlDraft.trim() }),
        ...(Object.keys(menuDraft).length === 0 ? {} : {
          sidebarMenuLabels: Object.fromEntries(Object.entries(menuDraft).map(([key, value]) => [key, value == null ? null : trimInput(value)]))
        })
      });
      releaseObjectUrl(sidebarLogo.objectUrl);
      releaseObjectUrl(compactLogo.objectUrl);
      setSidebarLogo({ action: "keep" });
      setCompactLogo({ action: "keep" });
      setMenuDraft({});
      setAdminUrlDraft(undefined);
      queryClient.setQueryData(["platform-branding"], updated);
      setPreviewRevision((value) => value + 1);
      setNotice({ kind: "success", message: "平台外观已保存。" });
    } catch (error) {
      setNotice({
        kind: "error",
        message: error instanceof APIError ? error.message : "平台外观保存失败，请稍后重试。"
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <PageShell>
      <PageHeader
        title="平台外观"
        actions={canUpdate ?
          <>
            <Button disabled={!hasCustomBranding || saving} onClick={restoreDefaults} variant="outline">
              <RotateCcw aria-hidden="true" />
              恢复默认配置
            </Button>
            <Button disabled={!hasChanges || saving || hasInvalidMenu || Boolean(urlError)} onClick={() => void save()}>
              <Save aria-hidden="true" />
              {saving ? "保存中" : "保存"}
            </Button>
          </> : undefined
        }
      />

      <div className="mb-5 flex items-center justify-between gap-4 border-b pb-5">
        <span className="text-sm font-medium">预览背景</span>
        <ToggleGroup
          aria-label="预览背景"
          onValueChange={(value) => value && setBackground(value as "light" | "dark")}
          type="single"
          value={background}
          variant="outline"
        >
          <ToggleGroupItem aria-label="浅色背景" value="light"><Sun aria-hidden="true" /></ToggleGroupItem>
          <ToggleGroupItem aria-label="深色背景" value="dark"><Moon aria-hidden="true" /></ToggleGroupItem>
        </ToggleGroup>
      </div>

      {notice ? (
        <Alert className="mb-5" variant={notice.kind === "success" ? "success" : "destructive"}>
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <LogoEditor
          background={background}
          configured={branding.sidebarLogoConfigured}
          draft={sidebarLogo}
          editable={canUpdate}
          inputId="sidebar-logo-file"
          kind="expanded"
          label="展开态 Logo"
          onFile={(file) => replaceDraft(sidebarLogo, file, setSidebarLogo)}
          onReset={() => resetDraft(sidebarLogo, setSidebarLogo)}
          previewRevision={previewRevision}
          savedUrl={branding.sidebarLogoUrl}
        />
        <LogoEditor
          background={background}
          configured={branding.sidebarCompactLogoConfigured}
          draft={compactLogo}
          editable={canUpdate}
          inputId="sidebar-compact-logo-file"
          kind="compact"
          label="折叠态小 Logo"
          onFile={(file) => replaceDraft(compactLogo, file, setCompactLogo)}
          onReset={() => resetDraft(compactLogo, setCompactLogo)}
          previewRevision={previewRevision}
          savedUrl={branding.sidebarCompactLogoUrl}
        />
      </div>
      <section className="mt-6 border-t pt-5" aria-labelledby="sidebar-menu-names-title">
        <h2 id="sidebar-menu-names-title" className="mb-4 text-sm font-semibold">侧边栏菜单名称</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {sidebarMenus.map(({ key, label, defaultName }) => {
            const value = menuDraft[key] === undefined ? branding.sidebarMenuLabels?.[key] : menuDraft[key];
            const error = menuLabelError(menuDraft[key]);
            return (
              <div key={key}>
                <Label htmlFor={`sidebar-menu-${key}`}>{label}</Label>
                <div className="mt-2 flex items-center gap-2">
                  <Input
                    className="min-w-0 flex-1"
                    id={`sidebar-menu-${key}`}
                    disabled={!canUpdate || saving}
                    value={value ?? ""}
                    placeholder={defaultName}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? `sidebar-menu-${key}-error` : undefined}
                    onChange={event => setMenuDraft(current => ({ ...current, [key]: event.target.value }))}
                  />
                  {canUpdate ? <Button
                    className="shrink-0"
                    type="button"
                    size="icon"
                    variant="ghost"
                    title={`恢复${label}默认值`}
                    aria-label={`恢复${label}默认值`}
                    disabled={value == null || saving}
                    onClick={() => setMenuDraft(current => ({ ...current, [key]: null }))}
                  ><RotateCcw aria-hidden="true" /></Button> : null}
                </div>
                {error ? <p id={`sidebar-menu-${key}-error`} className="mt-1 text-xs text-destructive">{error}</p> : null}
              </div>
            );
          })}
        </div>
      </section>
      <section className="mt-6 border-t pt-5" aria-labelledby="admin-url-title">
        <h2 id="admin-url-title" className="mb-4 text-sm font-semibold">客户端管理后台入口</h2>
        <Label htmlFor="admin-url">管理后台地址</Label>
        <Input
          className="mt-2"
          id="admin-url"
          type="url"
          placeholder="https://example.com/admin"
          value={adminUrlDraft ?? branding.adminUrl ?? ""}
          disabled={!canUpdate || saving}
          aria-invalid={Boolean(urlError)}
          aria-describedby={urlError ? "admin-url-error" : undefined}
          onChange={event => setAdminUrlDraft(event.target.value)}
        />
        {urlError ? <p id="admin-url-error" className="mt-1 text-xs text-destructive">{urlError}</p> : null}
      </section>
    </PageShell>
  );

  function releaseObjectUrl(url?: string) {
    if (!url || !objectUrlsRef.current.delete(url)) return;
    URL.revokeObjectURL(url);
  }
}

function LogoEditor(props: {
  background: "light" | "dark";
  configured: boolean;
  draft: LogoDraft;
  editable: boolean;
  inputId: string;
  kind: "expanded" | "compact";
  label: string;
  onFile(file: File): void;
  onReset(): void;
  previewRevision: number;
  savedUrl: string | null;
}) {
  const customSource = props.draft.action === "replace"
    ? props.draft.objectUrl
    : props.draft.action === "keep" && props.configured && props.savedUrl
      ? `${props.savedUrl}?v=${props.previewRevision}`
      : undefined;
  const defaultSource = props.kind === "expanded"
    ? `/krillinai-wordmark-${props.background === "light" ? "black" : "white"}.png`
    : `/krillinai-mark-${props.background === "light" ? "black" : "white"}.png`;

  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) props.onFile(file);
  }

  return (
    <section className="overflow-hidden rounded-md border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">{props.label}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            建议尺寸：{props.kind === "expanded" ? "1050 × 240" : "330 × 300"} px
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {props.draft.action === "replace" ? props.draft.file?.name : customSource ? "已配置" : "使用默认"}
          </p>
        </div>
        {props.editable ? <div className="flex items-center gap-2">
          <input
            accept="image/png,image/jpeg"
            className="sr-only"
            id={props.inputId}
            onChange={handleFile}
            type="file"
          />
          <Button asChild size="sm" variant="outline">
            <label htmlFor={props.inputId}><ImageUp aria-hidden="true" />选择图片</label>
          </Button>
          <Button
            aria-label={`清除${props.label} 配置`}
            disabled={!hasCustomLogo(props.draft, props.configured)}
            onClick={props.onReset}
            size="sm"
            variant="ghost"
          >
            <Trash2 aria-hidden="true" />
            清除配置
          </Button>
        </div> : null}
      </div>
      <div
        className={cn(
          "min-h-36 px-5 py-7",
          props.background === "light" ? "bg-[#f7f7f5] text-[#202020]" : "bg-[#202221] text-white"
        )}
      >
        <div className="flex min-h-20 items-start justify-between gap-5 rounded-md border border-current/10 px-3 py-3">
          {props.kind === "expanded" ? (
            <div className="flex flex-col items-start gap-0.5 pt-1">
              <span className="block h-[17px] w-[72px]">
                <img alt="展开态 Logo 预览" className="h-full w-full object-contain object-left" src={customSource ?? defaultSource} />
              </span>
              <span className="flex items-center gap-1 text-xs opacity-55"><strong>Clawee</strong><span>v1.0.0</span></span>
            </div>
          ) : (
            <span className="grid size-10 place-items-center">
              <span className="block size-7">
                <img alt="折叠态 Logo 预览" className="h-full w-full object-contain object-center" src={customSource ?? defaultSource} />
              </span>
            </span>
          )}
          <span className="size-9 rounded-md border border-current/10" aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}

function isSupportedImage(file: File) {
  return file.size > 0
    && file.size <= MAX_IMAGE_BYTES
    && (file.type === "image/png" || file.type === "image/jpeg");
}

function hasCustomLogo(draft: LogoDraft, configured: boolean) {
  return draft.action === "replace" || (draft.action === "keep" && configured);
}
