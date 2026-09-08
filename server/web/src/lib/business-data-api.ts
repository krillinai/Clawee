import { appApi } from "@/lib/api";
import { dataViewIds } from "@/lib/data-views-api";

export type BusinessDashboardRange = "today" | "7d" | "30d";
export type BusinessDataStatus = "unconfigured" | "available" | "unavailable";

type DashboardResponseBase = {
  data_status: BusinessDataStatus;
  range: BusinessDashboardRange;
  timezone: string;
  start_date: string;
  end_date: string;
  generated_at: string;
  last_synced_at: string | null;
};

export type XiaohongshuSummary = {
  published_count: number;
  published_count_change_rate: number | null;
  exposure_count: number;
  exposure_count_change_rate: number | null;
  interaction_count: number;
  interaction_count_change_rate: number | null;
  new_follower_count: number;
  new_follower_count_change_rate: number | null;
  conversion_count: number | null;
  conversion_rate: number | null;
};

export type XiaohongshuDashboard = DashboardResponseBase & {
  view_id: typeof dataViewIds.xiaohongshuOperation;
  summary: XiaohongshuSummary | null;
  trend: Array<{
    date: string;
    exposure_count: number;
    interaction_count: number;
  }>;
  top_items: Array<{
    external_content_id: string;
    title: string;
    content_type: string;
    exposure_count: number;
    interaction_count: number;
    interaction_rate: number | null;
  }>;
};

export type DouyinAdsSummary = {
  spend_minor: number;
  spend_change_rate: number | null;
  video_play_count: number;
  video_play_count_change_rate: number | null;
  conversion_count: number | null;
  attributed_revenue_minor: number | null;
  roi: number | null;
  currency: string;
};

export type DouyinAdsDashboard = DashboardResponseBase & {
  view_id: typeof dataViewIds.douyinAds;
  summary: DouyinAdsSummary | null;
  trend: Array<{
    date: string;
    spend_minor: number;
    video_play_count: number;
  }>;
  top_items: Array<{
    external_campaign_id: string;
    name: string;
    campaign_type: string;
    spend_minor: number;
    impression_count: number;
    video_play_count: number;
    click_count: number;
    currency: string;
  }>;
};

export type BilibiliDashboard = {
  status: BusinessDataStatus;
  account: {
    source_id: string;
    name: string;
    status: "active" | "disabled";
    status_reason: string;
    last_success_at: string | null;
  };
  range: BusinessDashboardRange;
  timezone: string;
  start_date: string;
  end_date: string;
  generated_at: string;
  data?: {
    captured_at: string;
    follower_count: number;
    collected_content_count: number;
    view_count: number;
    interaction_count: number;
    trend: Array<{
      date: string;
      follower_count: number;
      view_count: number;
      interaction_count: number;
      follower_count_delta: number;
      view_count_delta: number;
      interaction_count_delta: number;
    }>;
    top_contents: Array<{
      source_id: string;
      account_name: string;
      external_content_id: string;
      title: string;
      captured_at: string;
      view_count: number;
      interaction_count: number;
    }>;
  };
};

export type BilibiliSource = {
  source_id: string;
  name: string;
  status: "active" | "disabled";
  status_reason: string;
  last_attempt_at: string | null;
  last_success_at: string | null;
  next_sync_at: string | null;
  active_run_status: "" | "queued" | "running";
};

export function getXiaohongshuDashboard(range: BusinessDashboardRange): Promise<XiaohongshuDashboard> {
  return appApi.get<XiaohongshuDashboard>(`/business-dashboards/xiaohongshu-operation?range=${range}`);
}

export function getDouyinAdsDashboard(range: BusinessDashboardRange): Promise<DouyinAdsDashboard> {
  return appApi.get<DouyinAdsDashboard>(`/business-dashboards/douyin-ads?range=${range}`);
}

export async function getBilibiliDashboard(range: BusinessDashboardRange, sourceID: string): Promise<BilibiliDashboard> {
  const query = new URLSearchParams({ range, source_id: sourceID });
  const response = await appApi.get<BilibiliDashboard>(`/business-dashboards/bilibili-operation?${query}`);
  if (response.data && "status" in response.data) {
    return response.data as unknown as BilibiliDashboard;
  }
  return response;
}

export async function authorizeBilibili(): Promise<string> {
  const response = await appApi.post<{ authorization_url: string }>("/business-data-sources/bilibili/authorize");
  return response.authorization_url;
}

export async function syncBilibili(): Promise<"queued" | "already_queued"> {
  const response = await appApi.post<{ status: "queued" | "already_queued" }>("/business-data-sources/bilibili/sync");
  return response.status;
}

export async function listBilibiliSources(): Promise<BilibiliSource[]> {
  const response = await appApi.get<{ items: BilibiliSource[] }>("/business-data-sources/bilibili");
  return response.items ?? [];
}

export async function syncBilibiliSource(sourceID: string): Promise<"queued" | "already_queued"> {
  const response = await appApi.post<{ status: "queued" | "already_queued" }>(
    `/business-data-sources/bilibili/${encodeURIComponent(sourceID)}/sync`,
  );
  return response.status;
}

export async function setBilibiliSourceSyncEnabled(
  sourceID: string,
  syncEnabled: boolean,
): Promise<{ source: BilibiliSource; sync_request_status: "queued" | null }> {
  return appApi.patch<{ source: BilibiliSource; sync_request_status: "queued" | null }>(
    `/business-data-sources/bilibili/${encodeURIComponent(sourceID)}`,
    { sync_enabled: syncEnabled },
  );
}

export function deleteBilibiliSource(sourceID: string): Promise<void> {
  return appApi.delete(
    `/business-data-sources/bilibili/${encodeURIComponent(sourceID)}`,
  );
}

export function redirectToBilibiliAuthorization(url: string) {
  window.location.assign(url);
}
