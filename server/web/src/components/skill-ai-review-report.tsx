import { Bot, ChevronDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { skillAIAllowsScoring, type SkillAIReview } from "@/lib/skill-ai-review-api";

const statusLabels = { pending: "待执行", running: "执行中", completed: "已完成", failed: "失败", manual: "已转人工" };
const conclusions = { recommend_approve: "建议通过", recommend_reject: "建议驳回", needs_attention: "需要关注" };
const severities = { info: "说明", warning: "警告", error: "问题" };
const dimensions = { scenario_value: "场景价值", result_effectiveness: "结果有效性", ease_of_use: "易用性", reuse_value: "复用价值" };
const statusVariants = { pending: "warning", running: "accent", completed: "muted", failed: "danger", manual: "warning" } as const;
const agentStateLabels = { unknown: "未观测", online: "在线", blocked: "权限被拒", offline: "离线" } as const;
const agentStateVariants = { unknown: "outline", online: "success", blocked: "danger", offline: "muted" } as const;

export function SkillAIReviewStatusBadge({ status }: { status: SkillAIReview["status"] }) {
  return <Badge variant={statusVariants[status] ?? "outline"}>{statusLabels[status] ?? "未知阶段"}</Badge>;
}

export function SkillAIReviewAdvice({ review }: { review?: SkillAIReview }) {
  const report = review?.report;
  if (!report) return null;
  return <Card role="region" aria-label="AI 审核建议" className="min-w-0 shadow-none">
    <CardHeader className="gap-2 p-4 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm"><Bot aria-hidden="true" className="size-4 text-muted-foreground" />AI 审核建议</CardTitle>
        <Badge variant={report.conclusion === "recommend_approve" ? "accent" : "warning"}>{conclusions[report.conclusion] ?? "未知结论"}</Badge>
      </div>
      <CardDescription className="text-xs">仅供参考，请独立完成下方人工评分。AI 建议分不会自动填入。</CardDescription>
    </CardHeader>
    <CardContent className="grid gap-3 px-4 pb-4 text-sm">
      <p className="whitespace-pre-wrap break-words leading-6">{report.summary}</p>
      {report.findings.length ? <Collapsible>
        <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group w-full justify-between"><span>查看审核关注项（{report.findings.length}）</span><ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" /></Button></CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="grid gap-3 border-t pt-3">{report.findings.map((finding, index) => <li key={index} className="grid gap-2">
            <div className="flex flex-wrap items-start gap-2"><Badge variant={finding.severity === "error" ? "danger" : finding.severity === "warning" ? "warning" : "muted"}>{severities[finding.severity] ?? "说明"}</Badge><p className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-6">{finding.message}</p></div>
            {finding.path ? <p className="break-all font-mono text-xs text-muted-foreground">证据路径：{finding.path}</p> : null}
          </li>)}</ul>
        </CollapsibleContent>
      </Collapsible> : null}
    </CardContent>
  </Card>;
}

export function SkillAIReviewReport({ review }: { review: SkillAIReview }) {
  const history = review.attempts?.filter(attempt => attempt.attemptId !== review.attemptId) ?? [];
  return <section aria-label="AI 审核报告" className="grid min-w-0 gap-4 border-t pt-5 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="flex items-center gap-2 font-semibold"><Bot aria-hidden="true" className="size-4 text-muted-foreground" />AI 前置审核</h3>
      <SkillAIReviewStatusBadge status={review.status} />
      <span className="text-xs text-muted-foreground">仅供参考</span>
    </div>
    <p className="text-xs text-muted-foreground">仅为静态文本审核，未执行 Skill、脚本或二进制材料，不代表运行结果或安全保证。AI 结论与建议分仅供参考，不代替人工全员审批。</p>
    {!skillAIAllowsScoring(review) ? <p>AI 通过后才能提交人工评分。需修改时请查看建议并上传新版本；执行异常可由上传者或授权管理员重试。</p> : null}
    <AttemptReport review={review} />
    {history.length ? <Collapsible className="min-w-0 border-t pt-3">
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group w-full justify-between"><span>历史 AI 尝试（{history.length}）</span><ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" /></Button></CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-4 pt-3">{history.map((attempt, index) => <section key={attempt.attemptId} aria-label={`AI 尝试 ${index + 1}`} className="grid min-w-0 gap-3 border-l-2 border-border pl-4">
          <div className="flex flex-wrap items-center gap-2"><h4 className="font-medium">尝试 {index + 1}</h4><SkillAIReviewStatusBadge status={attempt.status} /><span className="text-xs text-muted-foreground">{formatDateTime(attempt.updatedAt)}</span></div>
          <AttemptReport review={attempt} />
        </section>)}</div>
      </CollapsibleContent>
    </Collapsible> : null}
  </section>;
}

function AttemptReport({ review }: { review: SkillAIReview }) {
  const report = review.report;
  const presence = review.agentPresence;
  return <>
    {review.error ? <p className="whitespace-pre-wrap break-words">失败原因：{review.error}</p> : null}
    {review.manualComment ? <p className="whitespace-pre-wrap break-words">转人工原因：{review.manualComment}</p> : null}
    {review.manualBy ? <p className="break-all text-xs text-muted-foreground">转人工操作人：{review.manualBy}{review.manualAt ? ` · ${formatDateTime(review.manualAt)}` : ""}</p> : null}
    {report ? <>
      <div><Badge variant={report.conclusion === "recommend_approve" ? "accent" : "warning"}>AI 结论：{conclusions[report.conclusion] ?? "未知结论"}</Badge></div>
      <p className="whitespace-pre-wrap break-words leading-6">{report.summary}</p>
      {report.findings.length ? <ul className="grid gap-3 border-l-2 border-border pl-3">{report.findings.map((finding, index) => <li key={index} className="space-y-1 whitespace-pre-wrap break-words leading-6"><span>{severities[finding.severity] ?? "说明"}：{finding.message}</span>{finding.path ? <p className="break-all text-xs text-muted-foreground">证据相对路径：<code>{finding.path}</code>（请在本轮原始文件入口核对）</p> : null}</li>)}</ul> : <p className="text-xs text-muted-foreground">未列出问题，不代表全部材料已验证。</p>}
      {report.suggestedScores ? <div role="group" aria-label="AI 建议分" className="grid gap-3 rounded-md bg-muted/50 p-3"><h4 className="text-xs font-medium text-muted-foreground">AI 建议分（不计入人工评分）</h4><div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">{(Object.keys(dimensions) as Array<keyof typeof dimensions>).map(key => <span key={key}>{dimensions[key]}：{report.suggestedScores![key]} / 5</span>)}</div></div> : null}
    </> : <p className="text-muted-foreground">暂无 AI 报告。</p>}
    <Collapsible className="min-w-0">
      <CollapsibleTrigger asChild><Button variant="ghost" size="sm" className="group w-full justify-between text-muted-foreground"><span>执行详情</span><ChevronDown aria-hidden="true" className="size-4 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" /></Button></CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid gap-3 rounded-md bg-muted/50 p-3 text-xs">
          <div className="space-y-1"><dt className="text-muted-foreground">更新时间</dt><dd>{formatDateTime(review.updatedAt)}</dd></div>
          <div className="space-y-1"><dt className="text-muted-foreground">审核规则</dt><dd className="break-all">{review.reviewSkillVersion || "历史记录未记录"}</dd></div>
          <div className="space-y-1"><dt className="text-muted-foreground">执行 Agent</dt><dd className="break-all font-mono">{review.agentId || "待领取"}</dd></div>
          {presence ? <>
            <div className="space-y-1"><dt className="text-muted-foreground">审核 Agent 状态</dt><dd className="flex flex-wrap items-center gap-2"><Badge variant={agentStateVariants[presence.state]}>{agentStateLabels[presence.state]}</Badge><span className="break-all font-mono">{presence.agentId}</span></dd></div>
            <div className="space-y-1"><dt className="text-muted-foreground">最近心跳</dt><dd>{presence.lastSeenAt ? formatDateTime(presence.lastSeenAt) : "尚未成功轮询"}</dd></div>
            {presence.lastError ? <div className="space-y-1 sm:col-span-2"><dt className="text-muted-foreground">最近错误</dt><dd className="whitespace-pre-wrap break-words">{presence.lastError}</dd></div> : null}
          </> : null}
          <div className="space-y-1"><dt className="text-muted-foreground">尝试 ID</dt><dd className="break-all font-mono">{review.attemptId}</dd></div>
          {review.reviewSkillSHA256 ? <div className="space-y-1"><dt className="text-muted-foreground">规则 SHA-256</dt><dd className="break-all font-mono">{review.reviewSkillSHA256}</dd></div> : null}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  </>;
}
