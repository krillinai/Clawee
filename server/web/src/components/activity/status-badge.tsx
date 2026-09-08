import { Badge } from "@/components/ui/badge";
import type { AgentStatus, RiskLevel } from "@/lib/office-api";

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return <Badge variant={statusVariant(status)}>{statusLabel(status)}</Badge>;
}

export function RiskLevelBadge({ level }: { level?: RiskLevel }) {
  if (!level) {
    return <Badge variant="muted">未标记</Badge>;
  }

  const variant =
    level === "high" ? "danger" : level === "medium" ? "warning" : level === "low" ? "success" : "muted";
  const label = level === "high" ? "高风险" : level === "medium" ? "中风险" : level === "low" ? "低风险" : level;
  return <Badge variant={variant}>{label}</Badge>;
}

export function statusLabel(status: AgentStatus) {
  const labels: Record<string, string> = {
    offline: "离线",
    idle: "空闲",
    thinking: "思考中",
    searching: "检索中",
    coding: "编码中",
    reading_files: "读文件",
    running_commands: "跑命令",
    organizing_data: "整理数据",
    summarizing: "总结中",
    calling_business_system: "调用业务系统",
    waiting_user: "等待用户",
    blocked: "阻塞",
    error: "异常",
  };

  return labels[status] ?? status;
}

function statusVariant(status: AgentStatus): "success" | "warning" | "muted" | "accent" | "danger" {
  if (status === "idle") return "muted";
  if (status === "offline") return "muted";
  if (status === "blocked") return "warning";
  if (status === "error") return "danger";
  if (status === "waiting_user") return "warning";
  if (status === "calling_business_system") return "accent";
  return "success";
}
