import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";

import { DataTableShell, EmptyState, ErrorAlert, LoadingState, PageHeader, PageShell, SuccessAlert, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { APIError } from "@/lib/api";
import { approvalsApp, type ApprovalDetail, type ApprovalFilters, type ApprovalKind, type ApprovalStatus, type ApprovalType, type ApprovalView, type WorkflowDecisionInput } from "@/lib/approvals-api";
import { currentAccount, type AuthResponse } from "@/lib/auth-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import type { SkillReviewScores } from "@/lib/skillhub-api";
import { SkillApprovalProgress, SkillDetailView, SkillReviewForm } from "./skill-detail";
import { WorkflowSteps } from "./workflow";
import { ModalShell } from "@/components/governance-ui";
import { skillAIAllowsScoring, skillAIReviewApi } from "@/lib/skill-ai-review-api";

const statusLabels: Record<string, string> = { pending: "待审核", approved: "已通过", rejected: "已驳回", invalidated: "已失效", running: "运行中", succeeded: "已完成", terminated: "已终止" };
const personalLabels = { pending: "本人待处理", approved: "本人已通过", rejected: "本人已驳回", "": "未处理" };
const statuses: ApprovalStatus[] = ["all", "pending", "approved", "rejected", "invalidated", "running", "succeeded", "terminated"];
const views: ApprovalView[] = ["todo", "done", "initiated"];
const types: ApprovalType[] = ["all", "skill", "workflow"];

function failureText(error: unknown) {
  if (error instanceof APIError) {
    if (error.status === 403) return "暂无访问权限，请联系管理员确认权限后刷新。";
    if (error.status === 404) return "审批记录不可见或已不存在，请刷新列表。";
    if (error.status === 409) return "审批状态已变化，请刷新后查看当前结果。";
  }
  return "请求失败，请稍后重试。";
}

function useApprovalScope() {
  const cache = useQueryClient();
  const [scope] = useState(() => `app-approvals:${crypto.randomUUID()}`);
  useEffect(() => () => cache.removeQueries({ queryKey: [scope] }), [cache, scope]);
  return scope;
}

function ApprovalIdentity({ detail = false }: { detail?: boolean }) {
  const auth = useQuery({ queryKey: ["auth", "me"], queryFn: currentAccount, retry: false });
  const { kind, id } = useParams();
  if (auth.isLoading) return <LoadingState label="正在校验登录状态" />;
  if (auth.isError || !auth.data?.user?.userId) return <ErrorAlert>登录状态已失效，请重新登录。</ErrorAlert>;
  if (!detail) return <ApprovalList key={auth.data.user.userId} />;
  if (!id || !["skill", "workflow", "workflow_instance"].includes(kind ?? "")) return <ErrorAlert>审批地址无效，请返回审批中心。</ErrorAlert>;
  return <ApprovalDetailPage key={`${auth.data.user.userId}:${kind}:${id}`} kind={kind as ApprovalKind} id={id} userId={auth.data.user.userId} />;
}

export function AppApprovalsPage() {
  return <ApprovalIdentity />;
}

export function AppApprovalDetailPage() {
  return <ApprovalIdentity detail />;
}

function ApprovalList() {
  const scope = useApprovalScope();
  const [params, setParams] = useSearchParams();
  const view = views.find(value => value === params.get("view")) ?? "todo";
  const type = types.find(value => value === params.get("type")) ?? "all";
  const status = statuses.find(value => value === params.get("status")) ?? "all";
  const filterKey = `${view}:${type}:${status}`;
  const [pagination, setPagination] = useState({ filterKey, cursors: [""] });
  const cursors = pagination.filterKey === filterKey ? pagination.cursors : [""];
  const setCursors = (values: string[]) => setPagination({ filterKey, cursors: values });
  useEffect(() => setPagination({ filterKey, cursors: [""] }), [filterKey]);
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({ queryKey: [scope, "list", view, type, status, cursor], queryFn: ({ signal }) => approvalsApp.list({ view, type, status, cursor }, signal), retry: false });
  const items = query.isError ? [] : query.data?.items ?? [];
  function filter(name: keyof ApprovalFilters, value: string) {
    setCursors([""]);
    const next = new URLSearchParams(params);
    next.set(name, value);
    setParams(next);
  }
  function refresh() {
    setCursors([""]);
    if (!cursor) void query.refetch();
  }
  return <PageShell>
    <PageHeader title="审批中心" actions={<Button disabled={query.isFetching} onClick={refresh} variant="outline">刷新</Button>}>处理本人待办、查看已办及我发起的 Skill 审核和工作流人工审批。</PageHeader>
    <Tabs value={view} onValueChange={value => filter("view", value)}><TabsList><TabsTrigger value="todo">待办</TabsTrigger><TabsTrigger value="done">已办</TabsTrigger><TabsTrigger value="initiated">我发起</TabsTrigger></TabsList></Tabs>
    <div className="flex flex-wrap gap-4">
      <Field className="w-full sm:w-44"><FieldLabel htmlFor="approval-type">类型</FieldLabel><Select value={type} onValueChange={value => filter("type", value)}><SelectTrigger id="approval-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部类型</SelectItem><SelectItem value="skill">Skill 审核</SelectItem><SelectItem value="workflow">工作流审批</SelectItem></SelectContent></Select></Field>
      <Field className="w-full sm:w-44"><FieldLabel htmlFor="approval-status">整单状态</FieldLabel><Select value={status} onValueChange={value => filter("status", value)}><SelectTrigger id="approval-status"><SelectValue /></SelectTrigger><SelectContent>{statuses.map(value => <SelectItem key={value} value={value}>{value === "all" ? "全部状态" : statusLabels[value]}</SelectItem>)}</SelectContent></Select></Field>
    </div>
    {query.isError ? <ErrorAlert>{failureText(query.error)}</ErrorAlert> : null}
    <DataTableShell><TableHeader><TableRow><TableHead>类型</TableHead><TableHead>名称 / 版本 / 节点</TableHead><TableHead>个人状态</TableHead><TableHead>整单状态</TableHead><TableHead>时间</TableHead><TableHead>操作</TableHead></TableRow></TableHeader><TableBody>
      {query.isLoading ? <TableStateRow colSpan={6}>正在加载审批记录</TableStateRow> : items.map(record => <TableRow key={`${record.kind}:${record.id}`}>
        <TableCell>{record.type === "skill" ? "Skill 审核" : "工作流审批"}</TableCell><TableCell className="max-w-72 whitespace-normal break-words">{record.title}{record.version ? <span className="ml-2 font-mono text-xs">v{record.version}</span> : null}</TableCell>
        <TableCell>{personalLabels[record.my_status]}</TableCell><TableCell><Badge variant="outline">{statusLabels[record.business_status] ?? record.business_status}</Badge></TableCell><TableCell>{formatDateTime(record.acted_at || record.created_at)}</TableCell>
        <TableCell><Button asChild size="sm" variant="outline"><Link aria-label={`查看${record.title}`} to={`/app/approvals/${record.kind}/${encodeURIComponent(record.id)}?${params}`}>查看详情</Link></Button></TableCell>
      </TableRow>)}
      {!query.isLoading && !query.isError && !items.length ? <TableStateRow colSpan={6}><EmptyState title="暂无审批记录" description="当前视图和筛选下没有可查看的审批。" /></TableStateRow> : null}
    </TableBody></DataTableShell>
    <div className="flex items-center justify-end gap-3"><span className="text-sm text-muted-foreground">第 {cursors.length} 页</span><Button disabled={query.isFetching || cursors.length === 1} onClick={() => setCursors(cursors.slice(0, -1))} variant="outline">上一页</Button><Button disabled={query.isFetching || query.isError || !query.data?.meta.has_next || !query.data.meta.next_cursor} onClick={() => setCursors([...cursors, query.data!.meta.next_cursor])} variant="outline">下一页</Button></div>
  </PageShell>;
}

function ApprovalDetailPage({ kind, id, userId }: { kind: ApprovalKind; id: string; userId: string }) {
  const scope = useApprovalScope();
  const cache = useQueryClient();
  const [params] = useSearchParams();
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const query = useQuery({ queryKey: [scope, "detail", kind, id], queryFn: ({ signal }) => approvalsApp.detail(kind, id, signal), retry: false });
  async function refresh() {
    await cache.invalidateQueries({ predicate: entry => typeof entry.queryKey[0] === "string" && entry.queryKey[0].startsWith("app-approvals:") && entry.queryKey[1] === "list" });
    await query.refetch();
  }
  const backHref = `/app/approvals?${params}`;
  return <PageShell>
    <div className="flex flex-wrap items-center justify-between gap-3"><Button asChild variant="outline"><Link to={backHref}>返回审批中心</Link></Button><Button disabled={query.isFetching || submitting} onClick={() => { setNotice(null); void refresh(); }} variant="outline">刷新</Button></div>
    {notice ? notice.error ? <ErrorAlert>{notice.text}</ErrorAlert> : <SuccessAlert>{notice.text}</SuccessAlert> : null}
    {query.isFetching ? <LoadingState label="正在加载审批详情" /> : query.isError ? <ErrorAlert>{failureText(query.error)}</ErrorAlert> : query.data ? <ApprovalContent key={query.dataUpdatedAt} detail={query.data} backHref={backHref} userId={userId} reportPending={setSubmitting} refresh={refresh} notify={(text, error) => setNotice({ text, error })} /> : null}
  </PageShell>;
}

function ApprovalContent({ detail, backHref, userId, reportPending, refresh, notify }: { detail: ApprovalDetail; backHref: string; userId: string; reportPending: (pending: boolean) => void; refresh: () => Promise<void>; notify: (text: string, error: boolean) => void }) {
  const cache = useQueryClient();
  const fileScope = useApprovalScope();
  const { item, workflow, task } = detail;
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);
  const [comment, setComment] = useState("");
  const [pending, setPending] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState<Error | undefined>();
  const [workflowInput, setWorkflowInput] = useState<WorkflowDecisionInput | null>(null);
  const [aiAction, setAIAction] = useState<"retry" | "manual" | null>(null);
  const [manualComment, setManualComment] = useState("");
  const busy = useRef(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { reportPending(pending); return () => reportPending(false); }, [pending, reportPending]);
  const isCurrent = () => active.current && cache.getQueryData<AuthResponse>(["auth", "me"])?.user?.userId === userId && cache.getQueryState(["auth", "me"])?.status !== "error";
  const versions = detail.skill?.versions.filter(version => (!item.version_id || version.versionId === item.version_id) && version.localApproval?.requestId === item.id) ?? [];
  const skill = detail.skill && versions.length === 1 ? { ...detail.skill, versions } : undefined;
  const approvalTask = task?.type === "approval" || (!task?.type && workflow?.nodes.some(node => node.node_id === task?.node_id && node.type === "approval"));
  const canProcess = item.can_process && !blocked && (item.kind === "skill" ? Boolean(skill) : item.kind === "workflow" && approvalTask && task?.task_id === item.id);
  const aiReview = skill?.versions[0].localApproval?.aiReview;
  const canScore = canProcess && skillAIAllowsScoring(aiReview);
  const canFallback = canProcess && Boolean(aiReview?.attemptId) && !skillAIAllowsScoring(aiReview);

  async function submitAIAction() {
    if (busy.current || !aiAction || !canFallback || !aiReview || !isCurrent() || (aiAction === "manual" && !manualComment.trim())) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try {
      if (aiAction === "retry") await skillAIReviewApi.retry(item.id, aiReview.attemptId);
      else await skillAIReviewApi.manual(item.id, aiReview.attemptId, manualComment);
      if (!isCurrent()) return;
      setBlocked(true);
      setAIAction(null);
      notify(aiAction === "retry" ? "AI 审核已重新排队。" : "已明确转为人工审核。", false);
      await refresh();
    } catch (failure) {
      if (!isCurrent()) return;
      if (failure instanceof APIError && [403, 404, 409].includes(failure.status)) {
        setBlocked(true);
        setAIAction(null);
        notify(failureText(failure), true);
        await refresh();
      } else setError(new Error(failureText(failure)));
    } finally {
      if (isCurrent()) { busy.current = false; setPending(false); }
    }
  }

  async function submit(scores?: SkillReviewScores, skillComment = "") {
    if (busy.current || !decision || !canScore || !isCurrent()) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    const input = workflowInput ?? { decision: decision === "approved" ? "approve" as const : "reject" as const, comment: comment.trim(), idempotency_key: crypto.randomUUID() };
    if (item.kind === "workflow") setWorkflowInput(input);
    try {
      if (item.kind === "skill") await approvalsApp.skillDecision(item.id, { decision, scores, comment: skillComment });
      else await approvalsApp.workflowDecision(item.id, input);
      if (!isCurrent()) return;
      setBlocked(true);
      setDecision(null);
      notify("审批已提交。", false);
      await refresh();
    } catch (failure) {
      if (!isCurrent()) return;
      if (failure instanceof APIError && [403, 404, 409].includes(failure.status)) {
        setBlocked(true);
        setDecision(null);
        notify(failureText(failure), true);
        await refresh();
      } else setError(new Error(failureText(failure)));
    } finally {
      if (isCurrent()) { busy.current = false; setPending(false); }
    }
  }

  function cancel() {
    if (busy.current) return;
    setDecision(null);
    setError(undefined);
    setComment("");
    setWorkflowInput(null);
  }

  return <>
    <PageHeader title={item.title}>{item.type === "skill" ? "Skill 本地人工审核" : "工作流人工审批"}</PageHeader>
    <div className="flex flex-wrap gap-4 text-sm"><span>个人状态：{personalLabels[item.my_status]}</span><span>整单状态：{statusLabels[item.business_status] ?? item.business_status}</span><span>创建时间：{formatDateTime(item.created_at)}</span>{item.acted_at ? <span>处理时间：{formatDateTime(item.acted_at)}</span> : null}</div>
    {item.my_status === "approved" && item.business_status === "pending" ? <p className="text-sm text-muted-foreground">本人已通过，整单仍待其他评审人处理，尚无正式评分汇总。</p> : null}
    {!canProcess ? <p className="text-sm text-muted-foreground">本记录仅供查看，当前不可处理。</p> : !decision ? <div className="flex gap-2"><Button disabled={pending || !canScore} onClick={() => setDecision("approved")}>通过</Button><Button disabled={pending || !canScore} onClick={() => setDecision("rejected")} variant="destructive">驳回</Button></div> : null}
    {canFallback ? <div className="flex flex-wrap gap-2"><Button disabled={pending} variant="outline" onClick={() => { setError(undefined); setAIAction("retry"); }}>重试 AI 审核</Button><Button disabled={pending} variant="outline" onClick={() => { setError(undefined); setManualComment(""); setAIAction("manual"); }}>转人工审核</Button></div> : null}
    <ModalShell open={Boolean(aiAction)} onClose={() => { if (!busy.current) { setAIAction(null); setError(undefined); } }} title={aiAction === "retry" ? "确认重试 AI 审核" : "明确转人工审核"} contextLabel={item.title}>
      <form className="grid gap-4" onSubmit={event => { event.preventDefault(); void submitAIAction(); }}>
        <p className="text-sm">{aiAction === "retry" ? "将为本轮创建新的 AI 尝试，保留原记录，执行 Agent 不变。" : "将结束当前 AI 前置阶段，保留原记录和操作原因；仍需原评审名单全员通过，不会自动发布。"}</p>
        {aiAction === "manual" ? <Field><FieldLabel htmlFor="ai-manual-comment">转人工原因（必填）</FieldLabel><Textarea id="ai-manual-comment" required maxLength={2000} disabled={pending} value={manualComment} onChange={event => setManualComment(event.target.value)} /></Field> : null}
        {error ? <ErrorAlert>{error.message}</ErrorAlert> : null}
        <div className="flex gap-2"><Button type="button" variant="outline" disabled={pending} onClick={() => setAIAction(null)}>取消</Button><Button type="submit" disabled={pending || !canFallback || (aiAction === "manual" && !manualComment.trim())}>{pending ? "提交中..." : aiAction === "retry" ? "确认重试" : "确认转人工"}</Button></div>
      </form>
    </ModalShell>
    {decision && canScore ? item.kind === "skill" ? <SkillReviewForm key={decision} decision={decision} pending={pending} error={error} confirmLabel={decision === "approved" ? "确认通过" : "确认驳回"} onCancel={cancel} onSubmit={(scores, value) => void submit(scores, value)} /> : <form className="grid max-w-2xl gap-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <Field><FieldLabel htmlFor="workflow-approval-comment">审批意见</FieldLabel><Textarea id="workflow-approval-comment" value={comment} disabled={pending || Boolean(workflowInput)} onChange={event => setComment(event.target.value)} /><FieldDescription>{workflowInput ? "本次失败保留原输入，重试沿用同一幂等键。" : "意见可选，确认后提交人工审批决定。"}</FieldDescription></Field>
      {error ? <ErrorAlert>{error.message}</ErrorAlert> : null}<div className="flex gap-2"><Button disabled={pending} onClick={cancel} type="button" variant="outline">取消</Button><Button disabled={pending} type="submit" variant={decision === "rejected" ? "destructive" : "primary"}>{pending ? "提交中..." : workflowInput ? "重试原提交" : decision === "approved" ? "确认通过" : "确认驳回"}</Button></div>
    </form> : null}
    {skill ? <>
      <section aria-label="本轮审核记录"><SkillApprovalProgress approval={versions[0].localApproval!} /></section>
      <SkillDetailView initialVersionId={versions[0].versionId} backHref={backHref} backLabel="返回审批中心" breadcrumbLabel="审批中心" detail={skill} queryScope={fileScope} getPackageURL={() => approvalsApp.packageURL(item.id)} loadFiles={() => approvalsApp.files(item.id)} loadFile={(_skillId, _versionId, path) => approvalsApp.file(item.id, path)} />
    </> : item.kind === "skill" ? <EmptyState title="审核内容不可用" description="当前无法合法绑定目标版本与原审核轮次，仅展示可授权的审批元数据。" /> : null}
    {task ? <section className="grid min-w-0 gap-3" aria-label="当前审批节点"><h2 className="text-sm font-semibold">节点说明与输入</h2><p className="whitespace-pre-wrap break-words text-sm">{task.instruction || workflow?.nodes.find(node => node.node_id === task.node_id)?.instruction || "暂无节点说明"}</p><pre className="overflow-auto border border-border bg-muted p-3 text-xs">{JSON.stringify(task.input, null, 2)}</pre>{task.decision ? <p className="text-sm">节点决定：{task.decision === "approve" ? "通过" : task.decision === "reject" ? "驳回" : task.decision}</p> : null}{task.handled_by ? <p className="text-sm">实际处理人：{workflow?.user_names?.[task.handled_by] || task.handled_by}</p> : null}{task.comment ? <p className="whitespace-pre-wrap break-words text-sm">{task.comment}</p> : null}</section> : null}
    {workflow ? <section aria-label="工作流历史任务"><h2 className="mb-4 text-sm font-semibold">工作流节点与历史任务</h2><p className="mb-4 text-sm text-muted-foreground">发起人：{workflow.user_names?.[workflow.started_by] || workflow.started_by} · 整单状态：{statusLabels[workflow.status] ?? workflow.status}</p><WorkflowSteps instance={workflow} /></section> : null}
  </>;
}
