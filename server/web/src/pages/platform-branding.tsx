import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp, Moon, RotateCcw, Save, Sun, Trash2 } from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import { ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { APIError } from "@/lib/api";
import {
  getPlatformBranding,
  updatePlatformBranding,
  type PlatformBrandingAction
} from "@/lib/platform-branding-api";
import { cn } from "@/lib/utils";

const MAX_IMAGE_BYTES = 1024 * 1024;

type LogoDraft = {
  action: PlatformBrandingAction;
  file?: File;
  objectUrl?: string;
};

export function PlatformBrandingPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["platform-branding"], queryFn: getPlatformBranding });
  const [background, setBackground] = useState<"light" | "dark">("light");
  const [sidebarLogo, setSidebarLogo] = useState<LogoDraft>({ action: "keep" });
  const [compactLogo, setCompactLogo] = useState<LogoDraft>({ action: "keep" });
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
    return <PageShell><ErrorAlert>平台外观加载失败，请稍后重试。</ErrorAlert></PageShell>;
  }

  const branding = query.data;
  const hasChanges = sidebarLogo.action !== "keep" || compactLogo.action !== "keep";
  const hasCustomBranding = hasCustomLogo(sidebarLogo, branding.sidebarLogoConfigured)
    || hasCustomLogo(compactLogo, branding.sidebarCompactLogoConfigured);

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
  }

  async function save() {
    setSaving(true);
    setNotice(undefined);
    try {
      const updated = await updatePlatformBranding({
        sidebarLogoAction: sidebarLogo.action,
        sidebarLogo: sidebarLogo.file,
        sidebarCompactLogoAction: compactLogo.action,
        sidebarCompactLogo: compactLogo.file
      });
      releaseObjectUrl(sidebarLogo.objectUrl);
      releaseObjectUrl(compactLogo.objectUrl);
      setSidebarLogo({ action: "keep" });
      setCompactLogo({ action: "keep" });
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
        actions={
          <>
            <Button disabled={!hasCustomBranding || saving} onClick={restoreDefaults} variant="outline">
              <RotateCcw aria-hidden="true" />
              恢复默认配置
            </Button>
            <Button disabled={!hasChanges || saving} onClick={() => void save()}>
              <Save aria-hidden="true" />
              {saving ? "保存中" : "保存"}
            </Button>
          </>
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
          inputId="sidebar-compact-logo-file"
          kind="compact"
          label="折叠态小 Logo"
          onFile={(file) => replaceDraft(compactLogo, file, setCompactLogo)}
          onReset={() => resetDraft(compactLogo, setCompactLogo)}
          previewRevision={previewRevision}
          savedUrl={branding.sidebarCompactLogoUrl}
        />
      </div>
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
            {props.draft.action === "replace" ? props.draft.file?.name : customSource ? "已配置" : "使用默认"}
          </p>
        </div>
        <div className="flex items-center gap-2">
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
        </div>
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
