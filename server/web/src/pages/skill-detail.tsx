import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, File, Folder, GitCommitHorizontal, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";

import {
  ConfirmDialog,
  DataTableShell,
  EmptyState,
  ErrorAlert,
  LoadingState,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert
} from "@/components/governance-ui";
import { useAdminAccount, useAdminPermission } from "@/components/admin-permissions";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { permissions } from "@/lib/rbac-api";
import { trimInput } from "@/lib/text";
import {
  clearCurrentSkillVersion,
  githubCommitURL,
  getSkill,
  getSkillVersionFile,
  getSkillVersionPackageURL,
  listSkillVersionFiles,
  listSkillSpaces,
  publishOwnSkillVersion,
  setCurrentSkillVersion,
  reviewSkillVersion,
  submitSkillApproval,
  syncSkillApproval,
  resolveSkillApproval,
  approvalStatusText,
  approvalInstanceURL,
  SkillHubAPIError,
  type SkillVersion,
  type SkillVersionFile,
  type SkillVersionSource
} from "@/lib/skillhub-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { cn } from "@/lib/utils";

const previewSizeLimit = 512 * 1024;

type DetailTab = "overview" | "files" | "history";
type PublishTarget = { versionId: string; version: string };
type FileTreeNode = { name: string; path: string; file?: SkillVersionFile; children: FileTreeNode[] };

export type SkillDetailData = {
  skill: {
    skillId: string;
    name: string;
    description: string;
    currentVersionId: string | null;
    updatedAt: string;
  };
  versions: SkillVersion[];
};

type SkillDetailManagement = {
  externalApproval?: boolean;
  canSubmitApproval?: (version: SkillVersion) => boolean;
  approvalPending?: boolean;
  approvalError?: string;
  onSubmitApproval?: (version: SkillVersion) => void;
  onSyncApproval?: (version: SkillVersion) => void;
  onBeginResolveApproval?: (version: SkillVersion) => void;
  canReview?: boolean;
  canSelfPublish?: (version: SkillVersion) => boolean;
  reviewPending?: boolean;
  onReview?: (version: SkillVersion, decision: "approved" | "rejected") => void;
  canPublish: boolean;
  canUnpublish: boolean;
  clearPending: boolean;
  publishPending: boolean;
  onClear: () => void;
  onPublish: (version: SkillVersion) => void;
};

type SkillDetailViewProps = {
  initialVersionId?: string;
  backHref: string;
  backLabel: string;
  breadcrumbLabel: string;
  detail: SkillDetailData;
  getPackageURL: (skillId: string, versionId: string) => string;
  loadFile: (skillId: string, versionId: string, path: string) => Promise<{ path: string; size: number; content: string }>;
  loadFiles: (skillId: string, versionId: string) => Promise<{ items: SkillVersionFile[] }>;
  management?: SkillDetailManagement;
  notice?: string | null;
  queryScope: string;
  showSourceEvidence?: boolean;
};

export function SkillDetailPage() {
  const account = useAdminAccount();
  const canPublish = useAdminPermission(permissions.skillPublish);
  const canUnpublish = useAdminPermission(permissions.skillUnpublish);
  const [searchParams] = useSearchParams();
  const skillId = searchParams.get("skill_id") ?? "";
  const queryClient = useQueryClient();
  const [publishTarget, setPublishTarget] = useState<PublishTarget | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewTarget, setReviewTarget] = useState<{ version: SkillVersion; decision: "approved" | "rejected" } | null>(null);
  const [reviewComment, setReviewComment] = useState("");
  const [providerInstanceId, setProviderInstanceId] = useState("");
  const [resolveTarget, setResolveTarget] = useState<SkillVersion | null>(null);

  const detailQuery = useQuery({
    queryKey: ["skill", skillId],
    queryFn: () => getSkill(skillId),
    enabled: Boolean(skillId)
  });
  const spacesQuery = useQuery({ queryKey: ["skill-spaces"], queryFn: listSkillSpaces });
  const space = spacesQuery.data?.find((item) => item.spaceId === detailQuery.data?.skill.spaceId);
  const canSelfPublish = (version: SkillVersion) => Boolean(space && space.approvalProvider !== "dingtalk" && !space.approverUserId && account?.userId && version.uploadedByUserId === account.userId && version.approvalStatus !== "rejected");
  const canSubmitApproval = (version: SkillVersion) => Boolean(space?.approvalProvider === "dingtalk" && !version.source && version.versionId !== detailQuery.data?.skill.currentVersionId && account?.userId === version.uploadedByUserId && (!version.approvalInstance || ["failed", "terminated"].includes(version.approvalInstance.status) || version.approvalInstance.status === "finished" && version.approvalInstance.decision === "rejected"));
  const approvalMutation = useMutation({
    mutationFn: (input: { version: SkillVersion; action: "submit" | "sync" | "not_created" | "bind_instance"; providerId?: string }) => {
      if (input.action === "submit") return submitSkillApproval(skillId, input.version.versionId);
      if (input.action === "sync") return syncSkillApproval(skillId, input.version.versionId);
      return resolveSkillApproval(input.version.approvalInstance!.id, input.action, input.providerId);
    },
    onSuccess: () => {
      setNotice("审批状态已更新"); setResolveTarget(null); setProviderInstanceId("");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
    }
  });

  const publishMutation = useMutation({
    mutationFn: (target: PublishTarget) => {
      const version = detailQuery.data?.versions.find((item) => item.versionId === target.versionId);
      return version && canSelfPublish(version) ? publishOwnSkillVersion(skillId, target.versionId) : setCurrentSkillVersion(skillId, target.versionId);
    },
    onSuccess: (result) => {
      setNotice(`Skill“${result.skill.name}”已发布版本 ${result.version.version}`);
      setPublishTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      void queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
      void queryClient.invalidateQueries({ queryKey: ["skill-spaces"] });
    }
  });
  const clearMutation = useMutation({
    mutationFn: () => clearCurrentSkillVersion(skillId),
    onSuccess: () => {
      setNotice(`Skill“${detailQuery.data?.skill.name ?? skillId}”已取消当前发布`);
      setClearOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      void queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
      void queryClient.invalidateQueries({ queryKey: ["skill-spaces"] });
    }
  });
  const reviewMutation = useMutation({
    mutationFn: () => reviewSkillVersion(skillId, reviewTarget!.version.versionId, reviewTarget!.decision, trimInput(reviewComment)),
    onSuccess: () => {
      setNotice(reviewTarget?.decision === "approved" ? "版本审批通过" : "版本已驳回");
      setReviewTarget(null);
      void queryClient.invalidateQueries({ queryKey: ["skill", skillId] });
    }
  });

  if (detailQuery.isLoading) {
    return <PageShell><LoadingState label="正在加载 Skill 详情" /></PageShell>;
  }

  if (detailQuery.isError) {
    return <PageShell><ErrorAlert error={detailQuery.error}>详情加载失败：{errorMessage(detailQuery.error)}。请返回技能中心后重试。</ErrorAlert></PageShell>;
  }

  const detail = detailQuery.data;
  if (!detail) return null;

  return (
    <>
      <SkillDetailView
        backHref={`/admin/skills?space_id=${encodeURIComponent(detail.skill.spaceId ?? "")}`}
        backLabel="返回 Skill 列表"
        breadcrumbLabel="技能中心"
        detail={detail}
        getPackageURL={getSkillVersionPackageURL}
        loadFile={getSkillVersionFile}
        loadFiles={listSkillVersionFiles}
        management={{
          externalApproval: space?.approvalProvider === "dingtalk",
          canSubmitApproval,
          approvalPending: approvalMutation.isPending,
          approvalError: approvalMutation.isError ? errorMessage(approvalMutation.error) : undefined,
          onSubmitApproval: (version) => approvalMutation.mutate({ version, action: "submit" }),
          onSyncApproval: (version) => approvalMutation.mutate({ version, action: "sync" }),
          onBeginResolveApproval: (version) => { approvalMutation.reset(); setProviderInstanceId(""); setResolveTarget(version); },
          canReview: detail.canReview,
          canSelfPublish,
          reviewPending: reviewMutation.isPending,
          onReview: (version, decision) => { setReviewTarget({ version, decision }); setReviewComment(""); reviewMutation.reset(); },
          canPublish: canPublish && Boolean(space?.approverUserId || space?.approvalProvider === "dingtalk"),
          canUnpublish,
          clearPending: clearMutation.isPending,
          publishPending: publishMutation.isPending,
          onClear: () => {
            clearMutation.reset();
            setClearOpen(true);
          },
          onPublish: (item) => {
            publishMutation.reset();
            setPublishTarget({ versionId: item.versionId, version: item.version });
          }
        }}
        notice={notice}
        queryScope="admin-skill"
        showSourceEvidence
      />

      <ModalShell open={Boolean(resolveTarget)} onClose={() => { if (!approvalMutation.isPending) setResolveTarget(null); }} title="核对钉钉审批申请" contextLabel={`版本 ${resolveTarget?.version ?? ""}`}>
        <FieldGroup>
          <Field><FieldLabel htmlFor="skill-approval-instance-id">已核实的审批实例 ID</FieldLabel><Input id="skill-approval-instance-id" value={providerInstanceId} onChange={(event) => setProviderInstanceId(event.target.value)} /></Field>
          {approvalMutation.isError ? <ErrorAlert error={approvalMutation.error}>恢复失败：{errorMessage(approvalMutation.error)}</ErrorAlert> : null}
          <Field orientation="horizontal" className="justify-end"><Button variant="outline" disabled={approvalMutation.isPending} onClick={() => setResolveTarget(null)}>取消</Button><Button variant="destructive" disabled={approvalMutation.isPending} onClick={() => resolveTarget && approvalMutation.mutate({ version: resolveTarget, action: "not_created" })}>确认未创建</Button><Button variant="primary" disabled={approvalMutation.isPending || !trimInput(providerInstanceId)} onClick={() => resolveTarget && approvalMutation.mutate({ version: resolveTarget, action: "bind_instance", providerId: trimInput(providerInstanceId) })}>绑定并同步</Button></Field>
        </FieldGroup>
      </ModalShell>

      <ModalShell open={Boolean(reviewTarget)} onClose={() => { if (!reviewMutation.isPending) setReviewTarget(null); }} title={reviewTarget?.decision === "approved" ? "通过版本审批" : "驳回版本"} contextLabel={`版本 ${reviewTarget?.version.version ?? ""}`}>
        <form onSubmit={(event) => { event.preventDefault(); reviewMutation.mutate(); }}><FieldGroup>
          <Field><FieldLabel htmlFor="skill-review-comment">审批意见</FieldLabel><Textarea id="skill-review-comment" maxLength={2000} value={reviewComment} onChange={(event) => setReviewComment(event.target.value)} /></Field>
          {reviewMutation.isError ? <ErrorAlert error={reviewMutation.error}>审核失败：{errorMessage(reviewMutation.error)}</ErrorAlert> : null}
          <Field className="justify-end" orientation="horizontal"><Button disabled={reviewMutation.isPending} type="button" variant="outline" onClick={() => setReviewTarget(null)}>取消</Button><Button disabled={reviewMutation.isPending} type="submit" variant={reviewTarget?.decision === "rejected" ? "destructive" : "primary"}>{reviewMutation.isPending ? "提交中..." : "确认"}</Button></Field>
        </FieldGroup></form>
      </ModalShell>

      <ConfirmDialog
        open={Boolean(publishTarget)}
        onClose={() => {
          if (publishMutation.isPending) return;
          setPublishTarget(null);
          publishMutation.reset();
        }}
        onConfirm={() => publishTarget && publishMutation.mutate(publishTarget)}
        title="设为当前版本"
        description={publishTarget ? `确认将 Skill“${detail.skill.name}”的版本 ${publishTarget.version} 设为当前版本？` : ""}
        confirmLabel={publishMutation.isPending ? "发布中..." : "确认发布"}
        pending={publishMutation.isPending}
        error={publishMutation.isError ? `发布失败：${errorMessage(publishMutation.error)}。请确认版本仍然存在。` : undefined}
      />

      <ConfirmDialog
        open={clearOpen}
        onClose={() => {
          if (clearMutation.isPending) return;
          setClearOpen(false);
          clearMutation.reset();
        }}
        onConfirm={() => clearMutation.mutate()}
        title="取消当前发布"
        description="取消后用户将无法查看或下载该 Skill，历史版本不会删除。"
        confirmLabel={clearMutation.isPending ? "取消中..." : "确认取消发布"}
        pending={clearMutation.isPending}
        variant="destructive"
        error={clearMutation.isError ? `取消发布失败：${errorMessage(clearMutation.error)}。请稍后重试。` : undefined}
      />
    </>
  );
}

export function SkillDetailView({
  initialVersionId,
  backHref,
  backLabel,
  breadcrumbLabel,
  detail,
  getPackageURL,
  loadFile,
  loadFiles,
  management,
  notice,
  queryScope,
  showSourceEvidence = false
}: SkillDetailViewProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>("overview");
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [mobilePreviewOpen, setMobilePreviewOpen] = useState(false);
  const skillId = detail.skill.skillId;
  const sortedVersions = useMemo(
    () => [...detail.versions].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [detail.versions]
  );
  const pendingReviewVersion = management?.canReview ? sortedVersions.find((item) => item.approvalStatus === "pending") : undefined;
  const defaultVersionId = pendingReviewVersion?.versionId ?? (sortedVersions.some((item) => item.versionId === initialVersionId) ? initialVersionId : null) ?? detail.skill.currentVersionId ?? sortedVersions[0]?.versionId ?? null;
  const viewedVersion = sortedVersions.find((item) => item.versionId === selectedVersionId)
    ?? sortedVersions.find((item) => item.versionId === defaultVersionId)
    ?? null;

  const filesQuery = useQuery({
    queryKey: [queryScope, "version-files", skillId, viewedVersion?.versionId],
    queryFn: () => loadFiles(skillId, viewedVersion!.versionId),
    enabled: Boolean(skillId && viewedVersion)
  });
  const files = filesQuery.data?.items ?? [];
  const skillMarkdownPath = useMemo(() => findSkillMarkdown(files), [files]);
  const effectiveFilePath = files.some((item) => item.path === selectedFilePath)
    ? selectedFilePath
    : skillMarkdownPath ?? files[0]?.path ?? null;
  const effectiveFile = files.find((item) => item.path === effectiveFilePath) ?? null;

  const overviewQuery = useQuery({
    queryKey: [queryScope, "version-file", skillId, viewedVersion?.versionId, skillMarkdownPath],
    queryFn: () => loadFile(skillId, viewedVersion!.versionId, skillMarkdownPath!),
    enabled: Boolean(skillId && viewedVersion && skillMarkdownPath)
  });
  const fileContentQuery = useQuery({
    queryKey: [queryScope, "version-file", skillId, viewedVersion?.versionId, effectiveFilePath],
    queryFn: () => loadFile(skillId, viewedVersion!.versionId, effectiveFilePath!),
    enabled: activeTab === "files" && Boolean(skillId && viewedVersion && effectiveFilePath && effectiveFile && effectiveFile.size <= previewSizeLimit)
  });

  useEffect(() => {
    setSelectedFilePath(null);
    setMobilePreviewOpen(false);
  }, [viewedVersion?.versionId]);

  function viewVersion(versionId: string) {
    setSelectedVersionId(versionId);
    setActiveTab("overview");
  }

  function selectFile(path: string) {
    setSelectedFilePath(path);
    setMobilePreviewOpen(true);
  }

  return (
    <PageShell>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild><Link to={backHref}>{breadcrumbLabel}</Link></BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem><BreadcrumbPage>{detail.skill.name}</BreadcrumbPage></BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <PageHeader
        title={detail.skill.name}
        titleAccessory={<PublicationBadge published={Boolean(detail.skill.currentVersionId)} />}
      >
        <p>{detail.skill.description}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
          <span className="min-w-0 break-all font-mono">当前查看版本 {viewedVersion?.version ?? "-"}</span>
          <span>最近更新 {formatDateTime(detail.skill.updatedAt)}</span>
        </div>
      </PageHeader>

      {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}

      {viewedVersion ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-start">
          <Card className="shadow-none lg:col-start-2 lg:row-start-1">
            <CardHeader>
              <CardTitle>版本信息</CardTitle>
              <CardDescription>当前页面内容和下载包均来自此版本。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-mono text-sm">v{viewedVersion.version}</span>
                {viewedVersion.versionId === detail.skill.currentVersionId ? <Badge variant="success">当前发布</Badge> : <Badge variant="muted">历史版本</Badge>}
              </div>
              {showSourceEvidence && viewedVersion.source ? <VersionSourceEvidence source={viewedVersion.source} /> : null}
              <Button asChild variant="primary">
                <a
                  download={`${detail.skill.name}-${viewedVersion.version}.zip`}
                  href={getPackageURL(skillId, viewedVersion.versionId)}
                >
                  <Download data-icon="inline-start" aria-hidden="true" />
                  下载 ZIP 包安装
                </a>
              </Button>
            </CardContent>
            {management ? (
              <>
                <Separator />
                <CardFooter className="flex-col items-stretch gap-3 pt-6">
                  <div>
                    <p className="text-sm font-medium">发布管理</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {viewedVersion.versionId === detail.skill.currentVersionId
                        ? "取消后用户侧将无法查看或下载该 Skill，历史版本仍会保留。"
                        : "将当前查看版本设为用户侧可安装版本。"}
                    </p>
                  </div>
                  {management.externalApproval && viewedVersion.source ? null : <ApprovalBadge status={viewedVersion.approvalStatus} />}
                  {management.externalApproval && !viewedVersion.source ? <div className="grid gap-2 text-sm">
                    <span>钉钉审批：{approvalStatusText(viewedVersion.approvalInstance)}</span>
                    {viewedVersion.approvalInstance?.providerInstanceId ? <a className="text-primary hover:underline" href={approvalInstanceURL(viewedVersion.approvalInstance.providerInstanceId)} target="_blank" rel="noreferrer">查看审批单</a> : null}
                    {management.approvalError ? <ErrorAlert>{management.approvalError}</ErrorAlert> : null}
                    {management.canSubmitApproval?.(viewedVersion) ? <Button disabled={management.approvalPending} size="sm" variant="secondary" onClick={() => management.onSubmitApproval?.(viewedVersion)}>提交钉钉审批</Button> : null}
                    {management.canPublish && viewedVersion.approvalInstance?.providerInstanceId && viewedVersion.approvalInstance.status === "running" ? <Button disabled={management.approvalPending} size="sm" variant="outline" onClick={() => management.onSyncApproval?.(viewedVersion)}>同步审批结果</Button> : null}
                    {management.canPublish && ["submitting", "uncertain"].includes(viewedVersion.approvalInstance?.status ?? "") ? <Button disabled={management.approvalPending} size="sm" variant="outline" onClick={() => management.onBeginResolveApproval?.(viewedVersion)}>核对申请</Button> : null}
                  </div> : null}
                  {viewedVersion.skillName && viewedVersion.skillName !== detail.skill.name ? <p className="break-all text-xs text-muted-foreground">待发布名称：{viewedVersion.skillName}</p> : null}
                  {viewedVersion.reviewedBy ? <p className="break-all text-xs text-muted-foreground">审批人：{viewedVersion.reviewedBy} · {formatDateTime(viewedVersion.reviewedAt ?? "")}</p> : null}
                  {viewedVersion.reviewComment ? <p className="whitespace-pre-wrap break-words text-sm">{viewedVersion.reviewComment}</p> : null}
                  {management.canReview && viewedVersion.approvalStatus !== "approved" ? <div className="flex flex-wrap gap-2">
                    <Button disabled={management.reviewPending} onClick={() => { setSelectedVersionId(viewedVersion.versionId); management.onReview?.(viewedVersion, "approved"); }} size="sm" variant="primary"><Check data-icon="inline-start" aria-hidden="true" />审批通过</Button>
                    <Button disabled={management.reviewPending} onClick={() => { setSelectedVersionId(viewedVersion.versionId); management.onReview?.(viewedVersion, "rejected"); }} size="sm" variant="destructive"><X data-icon="inline-start" aria-hidden="true" />驳回</Button>
                  </div> : null}
                  {management.canUnpublish && viewedVersion.versionId === detail.skill.currentVersionId ? (
                    <Button disabled={management.clearPending} onClick={management.onClear} size="sm" variant="destructive">
                      取消当前发布
                    </Button>
                  ) : null}
                  {(management.canPublish || management.canSelfPublish?.(viewedVersion)) && viewedVersion.versionId !== detail.skill.currentVersionId ? (
                    <Button
                      aria-label={`设为当前查看版本 ${viewedVersion.version}`}
                      disabled={management.publishPending || (viewedVersion.approvalStatus !== "approved" && !management.canSelfPublish?.(viewedVersion) && !(management.externalApproval && viewedVersion.source))}
                      onClick={() => management.onPublish(viewedVersion)}
                      size="sm"
                      variant="secondary"
                    >
                      设为当前版本
                    </Button>
                  ) : null}
                </CardFooter>
              </>
            ) : null}
          </Card>

          <Card className="min-w-0 shadow-none lg:col-start-1 lg:row-start-1">
            <CardContent className="p-4 sm:p-6">
              <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DetailTab)}>
                <TabsList className="h-auto w-full justify-start overflow-x-auto">
                  <TabsTrigger value="overview">概述</TabsTrigger>
                  <TabsTrigger value="files">文件</TabsTrigger>
                  <TabsTrigger value="history">版本历史</TabsTrigger>
                </TabsList>

                <TabsContent className="mt-5" value="overview">
                  <OverviewContent
                    content={overviewQuery.data?.content}
                    error={filesQuery.error ?? overviewQuery.error}
                    loading={filesQuery.isLoading || overviewQuery.isLoading}
                    missing={filesQuery.isSuccess && !skillMarkdownPath}
                  />
                </TabsContent>

                <TabsContent className="mt-5" value="files">
                  <FileBrowser
                    content={fileContentQuery.data?.content}
                    contentError={fileContentQuery.error}
                    contentLoading={fileContentQuery.isLoading}
                    files={files}
                    filesError={filesQuery.error}
                    filesLoading={filesQuery.isLoading}
                    mobilePreviewOpen={mobilePreviewOpen}
                    onBack={() => setMobilePreviewOpen(false)}
                    onSelect={selectFile}
                    selectedFile={effectiveFile}
                  />
                </TabsContent>

                <TabsContent className="mt-5" value="history">
                  <VersionHistory
                    externalApproval={management?.externalApproval}
                    canPublish={management?.canPublish ?? false}
                    canSelfPublish={management?.canSelfPublish}
                    currentVersionId={detail.skill.currentVersionId}
                    latestVersionId={sortedVersions[0]?.versionId ?? null}
                    onPublish={(item) => management?.onPublish(item)}
                    onView={viewVersion}
                    pending={management?.publishPending ?? false}
                    showSourceEvidence={showSourceEvidence}
                    versions={sortedVersions}
                    viewedVersionId={viewedVersion.versionId}
                  />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>
        </div>
      ) : (
        <EmptyState title="暂无可查看版本" description="上传 Skill ZIP 包后即可查看版本内容。" />
      )}

      <Button asChild className="justify-self-start" variant="ghost">
        <Link to={backHref}><ArrowLeft data-icon="inline-start" aria-hidden="true" />{backLabel}</Link>
      </Button>
    </PageShell>
  );
}

function OverviewContent({ content, error, loading, missing }: { content?: string; error: unknown; loading: boolean; missing: boolean }) {
  if (loading) return <LoadingState label="正在加载 Skill 概述" />;
  if (error) return <ErrorAlert error={error}>概述加载失败：{errorMessage(error)}。</ErrorAlert>;
  const body = stripFrontmatter(content ?? "");
  if (missing || !body) return <EmptyState title="暂无概述" description="该版本未提供可展示的 SKILL.md 正文。" />;

  return <MarkdownContent content={body} />;
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <article className="min-w-0 break-words text-sm leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          h1: ({ children }) => <h2 className="mb-4 text-2xl font-semibold leading-tight">{children}</h2>,
          h2: ({ children }) => <h3 className="mb-3 mt-7 text-xl font-semibold leading-tight">{children}</h3>,
          h3: ({ children }) => <h4 className="mb-2 mt-6 text-base font-semibold">{children}</h4>,
          p: ({ children }) => <p className="my-3 text-muted-foreground">{children}</p>,
          ul: ({ children }) => <ul className="my-3 list-disc pl-6 text-muted-foreground">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 list-decimal pl-6 text-muted-foreground">{children}</ol>,
          li: ({ children }) => <li className="my-1">{children}</li>,
          a: ({ children, href }) => <a className="text-primary underline underline-offset-4" href={href} rel="noreferrer" target="_blank">{children}</a>,
          pre: ({ children }) => <pre className="my-4 overflow-auto rounded-md border border-border bg-muted/35 p-4 font-mono text-xs leading-6">{children}</pre>,
          code: ({ children, className }) => className
            ? <code className={className}>{children}</code>
            : <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>,
          table: ({ children }) => <div className="my-4 overflow-auto rounded-md border border-border"><table className="w-full min-w-[520px] text-left text-sm">{children}</table></div>,
          th: ({ children }) => <th className="border-b border-border bg-muted/35 px-3 py-2 font-medium">{children}</th>,
          td: ({ children }) => <td className="border-b border-border px-3 py-2 text-muted-foreground">{children}</td>
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}

function FileBrowser({
  content,
  contentError,
  contentLoading,
  files,
  filesError,
  filesLoading,
  mobilePreviewOpen,
  onBack,
  onSelect,
  selectedFile
}: {
  content?: string;
  contentError: unknown;
  contentLoading: boolean;
  files: SkillVersionFile[];
  filesError: unknown;
  filesLoading: boolean;
  mobilePreviewOpen: boolean;
  onBack: () => void;
  onSelect: (path: string) => void;
  selectedFile: SkillVersionFile | null;
}) {
  if (filesLoading) return <LoadingState label="正在加载版本文件" />;
  if (filesError) return <ErrorAlert error={filesError}>文件列表加载失败：{errorMessage(filesError)}。</ErrorAlert>;
  if (files.length === 0) return <EmptyState title="暂无文件" description="该版本的 ZIP 包中没有可展示文件。" />;

  return (
    <div className="grid min-h-[420px] min-w-0 md:grid-cols-[260px_minmax(0,1fr)]">
      <div className={cn("min-w-0 border-border md:border-r md:pr-4", mobilePreviewOpen && "hidden md:block")}>
        <p className="mb-3 text-xs font-medium text-muted-foreground">文件目录</p>
        <FileTree files={files} onSelect={onSelect} selectedPath={selectedFile?.path ?? null} />
      </div>
      <div className={cn("min-w-0 md:pl-4", !mobilePreviewOpen && "hidden md:block")}>
        <Button className="mb-3 md:hidden" onClick={onBack} size="sm" variant="ghost">
          <ArrowLeft data-icon="inline-start" aria-hidden="true" />返回文件列表
        </Button>
        <FilePreview content={content} error={contentError} file={selectedFile} loading={contentLoading} />
      </div>
    </div>
  );
}

function FileTree({ files, onSelect, selectedPath }: { files: SkillVersionFile[]; onSelect: (path: string) => void; selectedPath: string | null }) {
  const tree = useMemo(() => buildFileTree(files), [files]);
  return <ul className="flex flex-col gap-1">{tree.map((node) => <FileTreeItem key={node.path} node={node} onSelect={onSelect} selectedPath={selectedPath} />)}</ul>;
}

function FileTreeItem({ node, onSelect, selectedPath }: { node: FileTreeNode; onSelect: (path: string) => void; selectedPath: string | null }) {
  if (node.file) {
    return (
      <li>
        <Button
          aria-current={node.path === selectedPath ? "true" : undefined}
          aria-label={`预览 ${node.path}`}
          className="h-auto w-full justify-start whitespace-normal px-2 py-1.5 text-left font-normal"
          onClick={() => onSelect(node.path)}
          size="sm"
          variant={node.path === selectedPath ? "secondary" : "ghost"}
        >
          <File data-icon="inline-start" aria-hidden="true" />
          <span className="min-w-0 break-all">{node.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{formatBytes(node.file.size)}</span>
        </Button>
      </li>
    );
  }

  return (
    <li>
      <div className="flex min-w-0 items-center gap-2 px-2 py-1.5 text-xs font-medium">
        <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 break-all">{node.name}</span>
      </div>
      <ul className="ml-3 flex flex-col gap-1 border-l border-border pl-2">
        {node.children.map((child) => <FileTreeItem key={child.path} node={child} onSelect={onSelect} selectedPath={selectedPath} />)}
      </ul>
    </li>
  );
}

function FilePreview({ content, error, file, loading }: { content?: string; error: unknown; file: SkillVersionFile | null; loading: boolean }) {
  if (!file) return <EmptyState title="请选择文件" description="从文件目录中选择一个文件进行预览。" />;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="break-all text-xs font-medium">{file.path}</code>
        <span className="font-mono text-xs text-muted-foreground">{formatBytes(file.size)}</span>
      </div>
      {file.size > previewSizeLimit || isFileNotPreviewable(error) ? (
        <EmptyState
          title="该文件不支持在线预览"
          description={file.size > previewSizeLimit ? "文件超过在线预览大小限制，请下载 ZIP 包后查看。" : "二进制文件请下载 ZIP 包后查看。"}
        />
      ) : loading ? <LoadingState label="正在加载文件内容" />
        : error ? <ErrorAlert error={error}>文件预览加载失败：{errorMessage(error)}。</ErrorAlert>
          : <pre className="max-h-[560px] min-h-[360px] overflow-auto rounded-md border border-border bg-muted/35 p-4 font-mono text-xs leading-6"><code>{content ?? ""}</code></pre>
      }
    </div>
  );
}

function VersionHistory({
  externalApproval,
  canPublish,
  currentVersionId,
  latestVersionId,
  onPublish,
  canSelfPublish,
  onView,
  pending,
  showSourceEvidence,
  versions,
  viewedVersionId
}: {
  externalApproval?: boolean;
  canPublish: boolean;
  canSelfPublish?: (version: SkillVersion) => boolean;
  currentVersionId: string | null;
  latestVersionId: string | null;
  onPublish: (version: SkillVersion) => void;
  onView: (versionId: string) => void;
  pending: boolean;
  showSourceEvidence: boolean;
  versions: SkillVersion[];
  viewedVersionId: string;
}) {
  return (
    <DataTableShell dense embedded minWidth={720}>
      <TableHeader>
        <TableRow>
          <TableHead>版本</TableHead>
          <TableHead>更新说明</TableHead>
          <TableHead>上传时间</TableHead>
          {showSourceEvidence ? <TableHead>来源</TableHead> : null}
          <TableHead className="text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {versions.map((item) => {
          const current = item.versionId === currentVersionId;
          const latest = item.versionId === latestVersionId;
          const viewed = item.versionId === viewedVersionId;
          return (
            <TableRow key={item.versionId}>
              <TableCell>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all font-mono text-xs">{item.version}</span>
                  {current ? <Badge variant="success">当前</Badge> : null}
                  {latest ? <Badge variant="secondary">最新上传</Badge> : null}
                  {showSourceEvidence && !(externalApproval && item.source) ? <ApprovalBadge status={item.approvalStatus} /> : null}
                </div>
              </TableCell>
              <TableCell className="max-w-72 text-muted-foreground"><span className="block truncate" title={item.changelog || undefined}>{item.changelog || "-"}</span></TableCell>
              <TableCell className="font-mono text-xs">{formatDateTime(item.createdAt)}</TableCell>
              {showSourceEvidence ? <TableCell>{item.source ? <VersionSourceEvidence compact source={item.source} /> : "-"}</TableCell> : null}
              <TableCell>
                <div className="flex justify-end gap-2">
                  <Button aria-label={`查看此版本 ${item.version}`} disabled={viewed} onClick={() => onView(item.versionId)} size="sm" variant="ghost">
                    {viewed ? "正在查看" : "查看"}
                  </Button>
                  {(canPublish || canSelfPublish?.(item)) && !current ? (
                    <Button aria-label={`设为当前版本 ${item.version}`} disabled={pending || (item.approvalStatus !== "approved" && !canSelfPublish?.(item) && !(externalApproval && item.source))} onClick={() => onPublish(item)} size="sm" variant="secondary">设为当前</Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </DataTableShell>
  );
}

function VersionSourceEvidence({ compact = false, source }: { compact?: boolean; source: SkillVersionSource }) {
  const repository = `${source.repositoryOwner}/${source.repositoryName}`;
  const commit = source.commitSha;
  return (
    <div className={compact ? "grid gap-1 text-xs" : "grid gap-2 border-t border-border pt-4 text-sm"}>
      {!compact ? <p className="font-medium">GitHub 来源</p> : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs">{repository}</span>
        <span className="min-w-0 break-all font-mono text-xs text-muted-foreground">{source.path}</span>
      </div>
      <a aria-label={`查看 Commit ${commit}`} className="inline-flex w-fit items-center gap-1 font-mono text-xs text-primary hover:underline" href={githubCommitURL(source)} rel="noreferrer" target="_blank" title={commit}>
        <GitCommitHorizontal className="size-3.5" aria-hidden="true" />{commit.slice(0, 8)}
      </a>
    </div>
  );
}

function PublicationBadge({ published }: { published: boolean }) {
  return <Badge variant={published ? "success" : "muted"}>{published ? "已发布" : "未发布"}</Badge>;
}

function ApprovalBadge({ status }: { status: SkillVersion["approvalStatus"] }) {
  return <Badge variant={status === "approved" ? "success" : status === "rejected" ? "danger" : "muted"}>{status === "approved" ? "审批通过" : status === "rejected" ? "已驳回" : "待审批"}</Badge>;
}

function findSkillMarkdown(files: SkillVersionFile[]) {
  return [...files]
    .filter((item) => item.path.split("/").at(-1)?.toLowerCase() === "skill.md")
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length)[0]?.path ?? null;
}

function stripFrontmatter(content: string) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").trim();
}

function isFileNotPreviewable(error: unknown) {
  return error instanceof SkillHubAPIError && error.code === "file_not_previewable";
}

function buildFileTree(files: SkillVersionFile[]) {
  const root: FileTreeNode = { name: "", path: "", children: [] };
  [...files].sort((left, right) => left.path.localeCompare(right.path)).forEach((file) => {
    const segments = file.path.split("/").filter(Boolean);
    let parent = root;
    segments.forEach((segment, index) => {
      const path = segments.slice(0, index + 1).join("/");
      let node = parent.children.find((item) => item.name === segment);
      if (!node) {
        node = { name: segment, path, children: [] };
        parent.children.push(node);
      }
      if (index === segments.length - 1) node.file = file;
      parent = node;
    });
  });
  return root.children.sort(compareTreeNodes);
}

function compareTreeNodes(left: FileTreeNode, right: FileTreeNode) {
  if (Boolean(left.file) !== Boolean(right.file)) return left.file ? 1 : -1;
  return left.name.localeCompare(right.name);
}

function formatBytes(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
