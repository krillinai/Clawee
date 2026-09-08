import { ArrowLeft } from "lucide-react";
import { Link } from "react-router-dom";

import { PageHeader } from "@/components/governance-ui";
import { Button } from "@/components/ui/button";
import type { AgentActivityDetail } from "@/lib/office-api";

import { AgentStatusBadge } from "@/components/activity/status-badge";

export function ActivityDetailHero({ detail, listPath = "/admin/activity" }: { detail: AgentActivityDetail; listPath?: string }) {
  const { agent } = detail;

  return (
    <PageHeader
      title={agent.display_name}
      titleAccessory={<AgentStatusBadge status={agent.status} />}
      actions={
        <Button asChild variant="outline">
          <Link to={listPath}>
            <ArrowLeft aria-hidden="true" data-icon="inline-start" />
            返回活动列表
          </Link>
        </Button>
      }
    >
      <p>{agent.workspace_name} · {agent.role_label} · {agent.agent_type}</p>
      <div className="mt-2 flex flex-wrap gap-4">
        <span>采集器 ID: <span className="font-mono text-foreground">{agent.collector_id}</span></span>
        <span>智能体 ID: <span className="font-mono text-foreground">{agent.agent_id}</span></span>
        <span>设备: <span className="font-mono text-foreground">{agent.device_id}</span></span>
      </div>
    </PageHeader>
  );
}
