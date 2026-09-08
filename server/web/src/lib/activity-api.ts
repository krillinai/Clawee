import { appApi } from "@/lib/api";

export type ActivityRange = "today" | "7d" | "30d";
export type ModelUsageStatus = "available" | "not_configured" | "unavailable";

export type ActivityUsage = {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

export type ActivityTrendPoint = ActivityUsage & {
  bucket_start: string;
};

export type ActivityModelUsage = ActivityUsage & {
  model: string;
  requests: number;
  share: number;
};

export type ActivityTokenUsageRank = {
  rank: number;
  name: string;
  requests: number;
  total_tokens: number;
};

export type ActivityMCPUsage = {
  id: string;
  label: string;
  invocation_count: number;
  share: number;
};

export type ActivityAgent = {
  collector_id: string;
  agent_id: string;
  name: string;
  status: string;
  session_count: number;
  turn_count: number;
  last_activity_at?: string;
};

export type ActivityStatistics = {
  range: ActivityRange;
  timezone: string;
  start_date: string;
  end_date: string;
  generated_at: string;
  organization: {
    usage: ActivityUsage;
    active_employees: number;
    active_agents: number;
    completed_turns: number;
    mcp_distribution: ActivityMCPUsage[];
  };
  trend: {
    granularity: "hour" | "day";
    points: ActivityTrendPoint[];
  };
  model_distribution: ActivityModelUsage[];
  token_usage_ranking: ActivityTokenUsageRank[];
  agents: ActivityAgent[];
  data_status: {
    model_usage: ModelUsageStatus;
    activity: string;
  };
};

export function getMyActivityStatistics(range: ActivityRange): Promise<ActivityStatistics> {
  return appApi.get<ActivityStatistics>(`/activity/statistics?range=${range}`);
}
