import { skillAIReviewApi, skillWorkflowStageLabels } from "@/lib/skill-ai-review-api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronDown, ExternalLink, RefreshCw, Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { useAdminAccount, useAdminPermission } from "@/components/admin-permissions";
import { ConfirmDialog, DataTableShell, DetailDrawer, EmptyState, ErrorAlert, LoadingState, MetricCard, ModalShell, PageHeader, PageShell, SuccessAlert, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { approvalsAdmin, type AdminApprovalDetail, type AdminApprovalFilters, type AdminApprovalItem, type AdminApprovalKind } from "@/lib/admin-approvals-api";
import { APIError } from "@/lib/api";
import { permissions } from "@/lib/rbac-api";
import { approvalInstanceURL, resolveSkillApproval, syncSkillApproval } from "@/lib/skillhub-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { workflowAdmin } from "@/lib/workflow-api";
import { SkillApprovalProgress, SkillDetailView } from "./skill-detail";
import { WorkflowSteps } from "./workflow";

const statusNames: Record<string, string> = { pending: "待处理", running: "进行中", approved: "已通过", rejected: "已驳回", invalidated: "已失效", succeeded: "已完成", terminated: "已终止", error: "异常待核对", submitting: "提交中", uncertain: "状态待核对", failed: "提交失败", finished: "已结束" };
const channelNames = { local: "本地审核", dingtalk: "钉钉审批", workflow: "工作流审批" };
const eventNames: Record<string, string> = { instance_started: "发起工作流", task_completed: "完成节点", task_rejected: "驳回审批", instance_terminated: "终止工作流" };
const statusVariants = { pending: "warning", running: "accent", approved: "success", rejected: "danger", invalidated: "muted", succeeded: "success", terminated: "muted", error: "danger" } as const;
const validKind = (value?: string): value is AdminApprovalKind => value === "skill" || value === "skill_external" || value === "workflow_instance";
const detailHref = (item: Pick<AdminApprovalItem, "kind" | "id">, params: URLSearchParams) => `/admin/approvals/${item.kind}/${encodeURIComponent(item.id)}?${params}`;

function failureText(error: unknown) {
  if (error instanceof APIError && error.status === 403) return "暂无访问权限，请联系管理员检查功能权限和数据授权。";
  if (error instanceof APIError && error.status === 404) return "审批记录不存在或已无权访问，请刷新列表。";
  if (error instanceof APIError && error.status === 409) return "审批状态已变化，请刷新详情后重试。";
  if (error instanceof APIError && error.status === 400) return "筛选条件或提交内容无效，请检查后重试。";
  return "请求失败，请稍后重试。";
}

function ApprovalStatus({ item }: { item: AdminApprovalItem }) {
  return <Badge variant={item.workflow_stage === "ai_failed" ? "danger" : statusVariants[item.status as keyof typeof statusVariants] ?? "outline"}>{skillWorkflowStageLabels[item.workflow_stage ?? ""] || statusNames[item.status] || item.status}</Badge>;
}

function useApprovalScope() {
  const account = useAdminAccount();
  return `${account?.userId ?? "admin"}:${account?.adminPermissions?.slice().sort().join(",") ?? ""}`;
}

function readFilters(params: URLSearchParams): AdminApprovalFilters {
  return { view: params.get("view") || "all", type: params.get("type") || "all", status: params.get("status") || "all", channel: params.get("channel") || "all", ...Object.fromEntries(["q", "initiated_by", "space_id", "template_id", "from", "until"].map(key => [key, params.get(key) || ""])) };
}

function ApprovalFilters({ params, onChange }: { params: URLSearchParams; onChange: (next: URLSearchParams) => void }) {
  const canReadSkills = useAdminPermission(permissions.skillRead);
  const canReadFlows = useAdminPermission(permissions.workflowInstanceRead);
  const [type, setType] = useState(params.get("type") || "all");
  const [dateError, setDateError] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next = new URLSearchParams({ view: params.get("view") || "all" });
    for (const key of ["type", "status", "channel", "q", "initiated_by", "space_id", "template_id"]) {
      const value = String(data.get(key) ?? "").trim();
      if (value) next.set(key, value);
    }
    const from = String(data.get("from") ?? "");
    const until = String(data.get("until") ?? "");
    if (from && until && from > until) { setDateError("结束日期不能早于开始日期。"); return; }
    if (from) next.set("from", new Date(`${from}T00:00:00`).toISOString());
    if (until) { const end = new Date(`${until}T00:00:00`); end.setDate(end.getDate() + 1); next.set("until", end.toISOString()); }
    onChange(next);
  }
  function dateValue(key: string, end = false) {
    const raw = params.get(key);
    if (!raw) return "";
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return "";
    if (end) date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  return <form onSubmit={submit} className="grid gap-3 border-b border-border pb-4">
    <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <label className="grid gap-1 text-xs">审批类型<NativeSelect name="type" value={type} onChange={event => setType(event.target.value)}><option value="all">全部类型</option>{canReadSkills && <option value="skill">技能审核</option>}{canReadFlows && <option value="workflow">工作流审批</option>}</NativeSelect></label>
      <label className="grid gap-1 text-xs">审批渠道<NativeSelect name="channel" defaultValue={params.get("channel") || "all"}><option value="all">全部渠道</option>{canReadSkills && type !== "workflow" && <><option value="local">本地审核</option><option value="dingtalk">钉钉审批</option></>}{canReadFlows && type !== "skill" && <option value="workflow">工作流审批</option>}</NativeSelect></label>
      <label className="grid gap-1 text-xs">审批状态<NativeSelect name="status" defaultValue={params.get("status") || "all"}><option value="all">全部状态</option>{Object.entries(statusNames).filter(([key]) => key in statusVariants).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</NativeSelect></label>
      <label className="grid gap-1 text-xs">关键词<Input name="q" defaultValue={params.get("q") || ""} maxLength={200} placeholder="标题、审批编号或发起人" /></label>
      <label className="grid gap-1 text-xs">发起人 ID<Input name="initiated_by" defaultValue={params.get("initiated_by") || ""} maxLength={256} /></label>
      {type === "skill" && <label className="grid gap-1 text-xs">技能空间 ID<Input name="space_id" defaultValue={params.get("space_id") || ""} maxLength={256} /></label>}
      {type === "workflow" && <label className="grid gap-1 text-xs">流程模板 ID<Input name="template_id" defaultValue={params.get("template_id") || ""} maxLength={256} /></label>}
      <label className="grid gap-1 text-xs">开始日期<Input name="from" type="date" defaultValue={dateValue("from")} /></label>
      <label className="grid gap-1 text-xs">结束日期<Input name="until" type="date" defaultValue={dateValue("until", true)} /></label>
    </div>
    {dateError && <ErrorAlert>{dateError}</ErrorAlert>}
    <div className="flex gap-2"><Button type="submit" size="sm"><Search aria-hidden="true" className="size-4" />查询</Button><Button type="button" size="sm" variant="outline" onClick={() => onChange(new URLSearchParams())}>重置</Button></div>
  </form>;
}

export function AdminApprovalsPage() {
  const [params, setParams] = useSearchParams();
  const scope = useApprovalScope();
  return <ApprovalList key={`${scope}:${params}`} params={params} setParams={setParams} scope={scope} />;
}

function ApprovalList({ params, setParams, scope }: { params: URLSearchParams; setParams: (next: URLSearchParams) => void; scope: string }) {
  const filters = readFilters(params);
  const [cursors, setCursors] = useState([""]);
  const [selected, setSelected] = useState<AdminApprovalItem | null>(null);
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({ queryKey: ["admin-approvals", scope, "list", filters, cursor], queryFn: ({ signal }) => approvalsAdmin.list(filters, cursor, signal) });
  const summary = useQuery({ queryKey: ["admin-approvals", scope, "summary", filters], queryFn: ({ signal }) => approvalsAdmin.summary(filters, signal) });
  const items = query.isError || query.isFetching ? [] : query.data?.items ?? [];
  return <PageShell>
    <PageHeader title="审批管理" actions={<Button disabled={query.isFetching || summary.isFetching} variant="outline" onClick={() => { setCursors([""]); void query.refetch(); void summary.refetch(); }}><RefreshCw aria-hidden="true" className="size-4" />刷新</Button>} />
    {summary.isError ? <ErrorAlert>{failureText(summary.error)}</ErrorAlert> : <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">{([['total', '审批记录'], ['pending', '待处理'], ['running', '进行中'], ['abnormal', '异常待核对']] as const).map(([key, label]) => <MetricCard key={key} label={label} value={summary.isFetching ? "..." : summary.data?.[key] ?? "..."} />)}</div>}
    <Tabs value={filters.view} onValueChange={view => { const next = new URLSearchParams(params); next.set("view", view); setParams(next); }}><TabsList aria-label="审批管理视图"><TabsTrigger value="all">全部</TabsTrigger><TabsTrigger value="active">进行中</TabsTrigger><TabsTrigger value="closed">已结束</TabsTrigger><TabsTrigger value="error">异常</TabsTrigger></TabsList></Tabs>
    <ApprovalFilters params={params} onChange={setParams} />
    <DataTableShell><TableHeader><TableRow>{["审批事项", "类型 / 渠道", "发起人", "业务对象", "当前审批人 / 节点", "审批进度", "状态", "发起时间", "操作"].map(title => <TableHead key={title}>{title}</TableHead>)}</TableRow></TableHeader><TableBody>
      {query.isFetching && <TableStateRow colSpan={9}><LoadingState label="正在加载审批记录" /></TableStateRow>}
      {query.isError && <TableStateRow colSpan={9}><ErrorAlert>{failureText(query.error)}</ErrorAlert></TableStateRow>}
      {items.map(item => <TableRow key={`${item.kind}:${item.id}`}>
        <TableCell className="min-w-40 max-w-64"><span className="break-words font-medium">{item.title}</span><p className="break-all text-xs text-muted-foreground">{item.id}</p></TableCell>
        <TableCell className="whitespace-nowrap">{item.type === "skill" ? "技能审核" : "工作流审批"}<p className="text-xs text-muted-foreground">{channelNames[item.channel]}</p></TableCell>
        <TableCell className="max-w-48 break-all">{item.initiated_name || item.initiated_by || "未知"}</TableCell>
        <TableCell className="max-w-48 break-all">{item.type === "skill" ? `${item.space_name || item.space_id || ""} / ${item.version || ""}` : item.template_id}</TableCell>
        <TableCell className="min-w-40 max-w-64 break-words">{skillWorkflowStageLabels[item.workflow_stage ?? ""] || item.current_node || (item.status === "pending" ? "人工审核" : "-")}<p className="text-xs text-muted-foreground">{(!item.workflow_stage || item.workflow_stage === "human_pending") ? item.current_approvers.map((id, index) => item.current_approver_names[index] || id).join("、") || (item.channel === "dingtalk" ? "外部审批" : "-") : "-"}</p></TableCell>
        <TableCell className="whitespace-nowrap">{item.progress_total ? `${item.progress_completed} / ${item.progress_total}` : "-"}</TableCell><TableCell><ApprovalStatus item={item} /></TableCell>
        <TableCell className="whitespace-nowrap text-xs">{formatDateTime(item.created_at)}</TableCell>
        <TableCell><Button aria-label={`查看${item.title}详情`} size="sm" variant="outline" onClick={() => setSelected(item)}>查看详情</Button></TableCell>
      </TableRow>)}
      {!query.isFetching && !query.isError && !items.length && <TableStateRow colSpan={9}><EmptyState title="暂无审批记录" /></TableStateRow>}
    </TableBody></DataTableShell>
    <div className="flex flex-wrap items-center justify-end gap-3"><span className="text-sm text-muted-foreground">第 {cursors.length} 页</span><Button disabled={query.isFetching || cursors.length === 1} variant="outline" onClick={() => setCursors(cursors.slice(0, -1))}>上一页</Button><Button disabled={query.isFetching || query.isError || !query.data?.meta.has_next || !query.data.meta.next_cursor} variant="outline" onClick={() => setCursors([...cursors, query.data!.meta.next_cursor])}>下一页</Button></div>
    <DetailDrawer open={Boolean(selected)} title="审批详情" subtitle={selected?.title ?? ""} onClose={() => setSelected(null)} titleAction={selected && <Button asChild size="sm" variant="outline"><Link to={detailHref(selected, params)}><ExternalLink aria-hidden="true" className="size-4" />打开详情页</Link></Button>}>
      {selected && <ApprovalDetail key={`${scope}:${selected.kind}:${selected.id}`} kind={selected.kind} id={selected.id} params={params} scope={scope} compact />}
    </DetailDrawer>
  </PageShell>;
}

export function AdminApprovalDetailPage() {
  const { kind, id = "" } = useParams();
  const [params] = useSearchParams();
  const scope = useApprovalScope();
  const backHref = `/admin/approvals?${params}`;
  return <PageShell>{validKind(kind) && id ? <ApprovalDetail key={`${scope}:${kind}:${id}`} kind={kind} id={id} params={params} scope={scope} /> : <><Button asChild variant="outline" className="w-fit"><Link to={backHref}><ArrowLeft aria-hidden="true" className="size-4" />返回审批管理</Link></Button><ErrorAlert>审批地址无效，请返回列表重新选择。</ErrorAlert></>}</PageShell>;
}

function ApprovalDetail({ kind, id, params, scope, compact = false }: { kind: AdminApprovalKind; id: string; params: URLSearchParams; scope: string; compact?: boolean }) {
  const query = useQuery({ queryKey: ["admin-approvals", scope, "detail", kind, id], queryFn: ({ signal }) => approvalsAdmin.detail(kind, id, signal) });
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");
  return <div className="grid min-w-0 gap-4 [&>*]:min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-3">
      {!compact && <Button asChild variant="outline"><Link to={`/admin/approvals?${params}`}><ArrowLeft aria-hidden="true" className="size-4" />返回审批管理</Link></Button>}
      <Button className="ml-auto" disabled={query.isFetching || submitting} variant="outline" onClick={() => { setNotice(""); void query.refetch(); }}><RefreshCw aria-hidden="true" className="size-4" />刷新详情</Button>
    </div>
    {notice && <SuccessAlert>{notice}</SuccessAlert>}
    {query.isFetching ? <LoadingState label="正在加载审批详情" /> : query.isError ? <ErrorAlert>{failureText(query.error)}</ErrorAlert> : query.data ? <ApprovalContent key={query.dataUpdatedAt} detail={query.data} params={params} scope={scope} compact={compact} refresh={() => query.refetch()} reportPending={setSubmitting} notify={setNotice} /> : null}
  </div>;
}

function ApprovalContent({ detail, params, scope, compact, refresh, reportPending, notify }: { detail: AdminApprovalDetail; params: URLSearchParams; scope: string; compact: boolean; refresh: () => Promise<unknown>; reportPending: (pending: boolean) => void; notify: (text: string) => void }) {
  const { item, skill, workflow, actions } = detail;
  const version = skill?.versions[0];
  const cache = useQueryClient();
  const [action, setAction] = useState<"terminate" | "resolve" | "sync" | "retry_ai" | null>(null);
  const [reason, setReason] = useState("");
  const [resolution, setResolution] = useState<"bind_instance" | "not_created">("bind_instance");
  const [providerID, setProviderID] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const canConfigureSkill = useAdminPermission(permissions.skillSpaceUpdate);
  const canConfigureFlow = useAdminPermission(permissions.workflowTemplateManage);
  async function submit() {
    if (pending || !action) return;
    setPending(true); reportPending(true); setError(""); notify("");
    try {
      if (action === "retry_ai" && version?.localApproval?.aiReview) await skillAIReviewApi.retry(item.id, version.localApproval.aiReview.attemptId);
      if (action === "terminate") await workflowAdmin.terminate(item.id, reason.trim());
      if (action === "sync") await syncSkillApproval(item.skill_id!, item.version_id!);
      if (action === "resolve") await resolveSkillApproval(item.id, resolution, providerID.trim());
      setAction(null);
      notify("操作已完成。");
      await cache.invalidateQueries({ queryKey: ["admin-approvals", scope], refetchType: "none" });
      await cache.refetchQueries({ queryKey: ["admin-approvals", scope, "list"], type: "active" });
      await cache.refetchQueries({ queryKey: ["admin-approvals", scope, "summary"], type: "active" });
      await cache.invalidateQueries({ queryKey: ["workflow-instances"] });
      await refresh();
    } catch (failure) { setError(failureText(failure)); }
    finally { setPending(false); reportPending(false); }
  }
  const canProcess = item.can_process && (item.kind === "skill" || item.kind === "workflow_instance" && item.task_id);
  const personalHref = item.kind === "skill" ? `/app/approvals/skill/${encodeURIComponent(item.id)}` : `/app/approvals/workflow/${encodeURIComponent(item.task_id || "")}`;
  return <>
    <PageHeader title={item.title}>
      <div className="flex flex-wrap items-center gap-2">
        <span>{item.type === "skill" ? `Skill ${channelNames[item.channel]}` : "工作流审批"}</span>
        {item.version && <Badge variant="outline">版本 {item.version}</Badge>}
        {item.space_id && <span className="break-all">{item.space_name || item.space_id}</span>}
      </div>
    </PageHeader>
    <Card className="shadow-none" role="region" aria-label="审批状态">
      <CardContent className="p-5">
        <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-4">
          <div className="space-y-2"><dt className="text-xs text-muted-foreground">整单状态</dt><dd><ApprovalStatus item={item} /></dd></div>
          <div className="space-y-2"><dt className="text-xs text-muted-foreground">审批进度</dt><dd>{item.progress_total ? `${item.progress_completed} / ${item.progress_total}` : "外部审批"}</dd></div>
          <div className="space-y-2"><dt className="text-xs text-muted-foreground">发起人</dt><dd className="break-all">{item.initiated_name || item.initiated_by}</dd></div>
          <div className="space-y-2"><dt className="text-xs text-muted-foreground">发起时间</dt><dd>{formatDateTime(item.created_at)}</dd></div>
        </dl>
        <Collapsible className="mt-5 min-w-0 border-t pt-3">
          <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group w-full justify-between text-muted-foreground"><span>审批编号与校验信息</span><ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" /></Button></CollapsibleTrigger>
          <CollapsibleContent>
            <dl className="grid min-w-0 gap-3 pt-3 text-sm sm:grid-cols-2">
              <div className="space-y-1"><dt className="text-xs text-muted-foreground">审批编号</dt><dd className="break-all font-mono text-xs">{item.id}</dd></div>
              <div className="space-y-1"><dt className="text-xs text-muted-foreground">审批渠道</dt><dd>{channelNames[item.channel]}</dd></div>
              <div className="space-y-1"><dt className="text-xs text-muted-foreground">原始业务状态</dt><dd>{statusNames[item.business_status] || item.business_status}</dd></div>
              {item.content_digest && <div className="space-y-1 sm:col-span-2"><dt className="text-xs text-muted-foreground">内容摘要 SHA-256</dt><dd className="break-all font-mono text-xs">{item.content_digest}</dd></div>}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
    {error && !action && <ErrorAlert>{error}</ErrorAlert>}
    <div className="flex flex-wrap gap-2">
      {item.can_retry_ai && <Button disabled={pending} variant="outline" onClick={() => { setError(""); setAction("retry_ai"); }}>重试 AI 审核</Button>}
      {canProcess && <Button asChild><Link to={personalHref}>处理审批</Link></Button>}
      {actions.terminate && <Button disabled={pending} variant="destructive" onClick={() => { setError(""); setAction("terminate"); }}>终止工作流</Button>}
      {actions.sync && <Button disabled={pending} variant="outline" onClick={() => { setError(""); setAction("sync"); }}>同步外部结果</Button>}
      {actions.resolve && <Button disabled={pending} variant="outline" onClick={() => { setError(""); setAction("resolve"); }}>核对异常实例</Button>}
      {workflow && <Button asChild variant="outline"><Link to={`/admin/workflow-instances/${encodeURIComponent(item.id)}`}>查看流程任务</Link></Button>}
      {workflow && canConfigureFlow && <Button asChild variant="outline"><Link to={`/admin/workflow-templates/${encodeURIComponent(workflow.template_id)}`}>查看流程配置</Link></Button>}
      {skill && canConfigureSkill && <Button asChild variant="outline"><Link to="/admin/skills?tab=spaces">查看审批配置</Link></Button>}
      {version?.approvalInstance?.providerInstanceId && <Button asChild variant="outline"><a href={approvalInstanceURL(version.approvalInstance.providerInstanceId)} target="_blank" rel="noreferrer"><ExternalLink aria-hidden="true" className="size-4" />查看钉钉实例</a></Button>}
    </div>
    {!canProcess && item.channel !== "dingtalk" && item.status === "pending" && <p className="text-sm text-muted-foreground">{item.workflow_stage && item.workflow_stage !== "human_pending" ? "AI 评估尚未通过，当前仅可查看。" : "当前账号无待处理的人工审批，仅可查看。"}</p>}
    {version?.localApproval && <Card className="shadow-none" role="region" aria-label="本轮审核记录"><CardContent className="p-5"><SkillApprovalProgress approval={version.localApproval} /></CardContent></Card>}
    {workflow && <section aria-label="审批节点与处理记录"><WorkflowSteps instance={workflow} /></section>}
    {detail.events?.length ? <section aria-label="工作流操作记录" className="grid gap-3"><h2 className="text-sm font-semibold">操作记录</h2><ol className="grid gap-3">{detail.events.map(event => <li key={event.id} className="border-l-2 border-border pl-3 text-sm"><div className="flex flex-wrap gap-2"><span>{eventNames[event.type] || event.type}</span><span>{event.actor_name || event.actor}</span><time className="text-xs text-muted-foreground">{formatDateTime(event.created_at)}</time></div>{event.reason && <p className="mt-1 whitespace-pre-wrap break-words">{event.reason}</p>}</li>)}</ol></section> : null}
    {skill && !item.materials_available && <EmptyState title="审核材料不可用" description="本轮已失效或与当前空间、内容不再一致，仅展示审批记录。" />}
    {skill && version && item.materials_available && (compact ? <p className="whitespace-pre-wrap break-words text-sm">{version.description || "暂无版本说明"}</p> : <SkillDetailView detail={skill} initialVersionId={version.versionId} backHref={`/admin/approvals?${params}`} backLabel="返回审批管理" breadcrumbLabel="审批管理" queryScope={`admin-approval:${scope}:${item.kind}:${item.id}`} getPackageURL={() => approvalsAdmin.packageURL(item.kind, item.id)} loadFiles={() => approvalsAdmin.files(item.kind, item.id)} loadFile={(_skillID, _versionID, path) => approvalsAdmin.file(item.kind, item.id, path)} />)}
    <ConfirmDialog open={action === "retry_ai"} title="确认重试 AI 审核" description="将为本轮创建新的 AI 尝试并保留原记录。" confirmLabel="确认重试" pending={pending} error={error || undefined} onClose={() => { if (!pending) setAction(null); }} onConfirm={() => void submit()} />
    <ConfirmDialog open={action === "sync"} title="同步外部审批结果" description="从钉钉核对本次实例的最新结果，已结束的审批可能更新本地记录。" confirmLabel="确认同步" pending={pending} error={error || undefined} onClose={() => { if (!pending) setAction(null); }} onConfirm={() => void submit()} />
    <ModalShell open={action === "terminate" || action === "resolve"} title={action === "terminate" ? "确认终止工作流" : "核对异常实例"} subtitle={action === "terminate" ? "请核实当前实例并填写终止原因。" : "请核实钉钉中的实际审批实例。"} contextLabel={item.title} onClose={() => { if (!pending) setAction(null); }}>
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
        {action === "terminate" ? <><p className="text-sm">终止后未完成节点将被取消，既有处理记录保留。</p><label className="grid gap-2 text-sm">终止原因（必填）<Textarea required maxLength={2000} disabled={pending} value={reason} onChange={event => setReason(event.target.value)} /></label></> : <><label className="grid gap-2 text-sm">核对结果<NativeSelect disabled={pending} value={resolution} onChange={event => setResolution(event.target.value as typeof resolution)}><option value="bind_instance">绑定已有钉钉实例</option><option value="not_created">确认外部实例未创建</option></NativeSelect></label>{resolution === "bind_instance" ? <label className="grid gap-2 text-sm">钉钉实例 ID（必填）<Input required maxLength={256} disabled={pending} value={providerID} onChange={event => setProviderID(event.target.value)} /></label> : <p className="text-sm">仅在已核实钉钉没有创建对应实例时确认，确认后本次提交将标记为失败。</p>}</>}
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <div className="flex flex-wrap gap-2"><Button type="button" disabled={pending} variant="outline" onClick={() => setAction(null)}>取消</Button><Button type="submit" variant={action === "terminate" || resolution === "not_created" && action === "resolve" ? "destructive" : "default"} disabled={pending || action === "terminate" && !reason.trim() || action === "resolve" && resolution === "bind_instance" && !providerID.trim()}>{pending ? "提交中..." : action === "terminate" ? "确认终止" : "确认核对"}</Button></div>
      </form>
    </ModalShell>
  </>;
}
