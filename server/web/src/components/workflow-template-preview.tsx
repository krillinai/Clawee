import { Link } from "react-router-dom";
import { DetailDrawer, EmptyState } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type WorkflowPreviewStep = { name: string; rule: string; typeLabel?: string; assignees?: string };

export function WorkflowTemplatePreview({ open, onClose, templateId, title, subtitle, description, steps, canReadTasks }: {
  open: boolean;
  onClose: () => void;
  templateId?: string;
  title: string;
  subtitle: string;
  description?: string;
  steps: WorkflowPreviewStep[];
  canReadTasks: boolean;
}) {
  return <DetailDrawer open={open} onClose={onClose} title={title} subtitle={subtitle} contextLabel="流程模板" contextDetail={templateId ? <>ID：<code>{templateId}</code></> : undefined}>
    {description && <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{description}</p>}
    {steps.length ? <ol className="space-y-4">{steps.map((step, index) => <li key={index} className="space-y-1 border-b pb-3">
      <div className="flex flex-wrap items-center gap-2"><h3 className="break-words text-sm font-semibold">{index + 1}. {step.name}</h3>{step.typeLabel && <Badge variant="outline">{step.typeLabel}</Badge>}</div>
      {step.assignees && <p className="break-words text-xs text-muted-foreground">负责人：{step.assignees}</p>}
      <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">{step.rule || "暂无说明 / 任务指令"}</p>
    </li>)}</ol> : <EmptyState title="暂无执行节点" />}
    {canReadTasks && <Button asChild size="sm" variant="outline"><Link to="/admin/workflow-instances">查看流程任务</Link></Button>}
  </DetailDrawer>;
}
