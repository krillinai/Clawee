import { useSearchParams } from "react-router-dom";

import { ActivityDetailView } from "@/components/activity-detail/activity-detail-view";

export function OfficeAgentDetailPage() {
  const [searchParams] = useSearchParams();
  const collectorId = searchParams.get("collector_id") ?? "";
  const agentId = searchParams.get("agent_id") ?? "";

  return <ActivityDetailView agentId={agentId} collectorId={collectorId} />;
}
