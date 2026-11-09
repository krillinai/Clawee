import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { ErrorAlert, LoadingState, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { useAdminPermission } from "@/components/admin-permissions";
import { WorkflowTemplatePreview } from "@/components/workflow-template-preview";
import { permissions } from "@/lib/rbac-api";
import { skillReviewWorkflowApi } from "@/lib/skill-review-workflow-api";

export function SkillReviewWorkflow() {
  const [open, setOpen] = useState(false);
  const canReadRuns = useAdminPermission(permissions.workflowInstanceRead);
  const canReadSkills = useAdminPermission(permissions.skillRead);
  const definition = useQuery({ queryKey: ["skill-review-workflow"], queryFn: skillReviewWorkflowApi.definition });
  if (definition.isLoading) return <TableStateRow colSpan={6}><LoadingState label="正在加载内置流程模板" /></TableStateRow>;
  if (definition.isError) return <TableStateRow colSpan={6} tone="danger"><ErrorAlert>内置流程模板加载失败。<Button size="sm" variant="outline" onClick={() => void definition.refetch()}>重试</Button></ErrorAlert></TableStateRow>;
  if (!definition.data) return null;
  return <>
    <TableRow>
      <TableCell className="max-w-64 font-medium"><span className="block truncate" title={definition.data.name}>{definition.data.name}</span><Badge className="mt-1" variant="outline">内置 · 只读</Badge></TableCell>
      <TableCell><Badge variant="success">已启用</Badge></TableCell>
      <TableCell>—</TableCell>
      <TableCell>{definition.data.steps.length}</TableCell>
      <TableCell className="max-w-48 text-muted-foreground">上传者（上传触发）</TableCell>
      <TableCell className="text-right"><Button variant="secondary" size="sm" onClick={() => setOpen(true)}>查看流程</Button></TableCell>
    </TableRow>
    <WorkflowTemplatePreview open={open} onClose={() => setOpen(false)} title={definition.data.name} subtitle="内置流程 · 只读 · 上传触发" steps={definition.data.steps} canReadTasks={canReadRuns && canReadSkills} />
  </>;
}
