import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { skillAIAllowsScoring, type SkillAIReview } from "@/lib/skill-ai-review-api";

const statusLabels = { pending: "待执行", running: "执行中", completed: "已完成", failed: "失败", manual: "已转人工" };
const conclusions = { recommend_approve: "建议通过", recommend_reject: "建议驳回", needs_attention: "需要关注" };
const severities = { info: "说明", warning: "警告", error: "问题" };
const dimensions = { scenario_value: "场景价值", result_effectiveness: "结果有效性", ease_of_use: "易用性", reuse_value: "复用价值" };

export function SkillAIReviewReport({ review }: { review: SkillAIReview }) {
  return <section aria-label="AI 审核报告" className="grid min-w-0 gap-3 border-t pt-3 text-sm">
    <h3 className="font-semibold">AI 前置审核 <Badge variant="outline">{statusLabels[review.status] ?? "未知阶段"}</Badge></h3>
    <p className="text-xs text-muted-foreground">仅为静态文本审核，未执行 Skill、脚本或二进制材料，不代表运行结果或安全保证。AI 结论与建议分仅供参考，不代替人工全员审批。</p>
    {!skillAIAllowsScoring(review) ? <p>AI 前置审核尚未完成，暂不可提交人工评分；合法评审人可在审批中心重试或明确转人工。</p> : null}
    <AttemptReport review={review} />
    {review.attempts?.length ? <details><summary>历史 AI 尝试（{review.attempts.length}）</summary><div className="grid gap-3 pt-3">{review.attempts.map(attempt => <div key={attempt.attemptId} className="grid gap-2 border-t pt-2"><p>尝试 {attempt.attemptId} · {statusLabels[attempt.status] ?? "未知阶段"}</p><AttemptReport review={attempt} /></div>)}</div></details> : null}
  </section>;
}

function AttemptReport({ review }: { review: SkillAIReview }) {
  const report = review.report;
  return <>
    <p className="break-all text-xs text-muted-foreground">执行 Agent：{review.agentId} · 更新：{formatDateTime(review.updatedAt)}</p>
    {review.error ? <p className="whitespace-pre-wrap break-words">失败原因：{review.error}</p> : null}
    {review.manualComment ? <p className="whitespace-pre-wrap break-words">转人工原因：{review.manualComment}</p> : null}
    {review.manualBy ? <p className="break-all text-xs text-muted-foreground">转人工操作人：{review.manualBy}{review.manualAt ? ` · ${formatDateTime(review.manualAt)}` : ""}</p> : null}
    {report ? <>
      <p>AI 结论：{conclusions[report.conclusion] ?? "未知结论"}</p>
      <p className="whitespace-pre-wrap break-words">{report.summary}</p>
      {report.findings.length ? <ul className="grid gap-2">{report.findings.map((finding, index) => <li key={index} className="whitespace-pre-wrap break-words"><span>{severities[finding.severity] ?? "说明"}：{finding.message}</span>{finding.path ? <p className="break-all text-xs text-muted-foreground">证据相对路径：<code>{finding.path}</code>（请在本轮原始文件入口核对）</p> : null}</li>)}</ul> : <p className="text-muted-foreground">未列出问题，不代表全部材料已验证。</p>}
      {report.suggestedScores ? <div role="group" aria-label="AI 建议分" className="grid gap-1"><h4 className="font-medium">AI 建议分（不计入人工评分）</h4>{(Object.keys(dimensions) as Array<keyof typeof dimensions>).map(key => <span key={key}>{dimensions[key]}：{report.suggestedScores![key]} / 5</span>)}</div> : null}
    </> : <p className="text-muted-foreground">暂无 AI 报告。</p>}
  </>;
}
