import { appApi } from "@/lib/api";

export const dataViewIds = {
  agentActivity: "agent_activity",
  xiaohongshuOperation: "xiaohongshu_operation",
  douyinAds: "douyin_ads",
  bilibiliOperation: "bilibili_operation",
} as const;

export type BusinessDataViewID =
  | typeof dataViewIds.xiaohongshuOperation
  | typeof dataViewIds.douyinAds
  | typeof dataViewIds.bilibiliOperation;

export type DataView = {
  view_id: string;
  actions: string[];
};

export async function listMyDataViews(): Promise<DataView[]> {
  const response = await appApi.get<{ data: DataView[] }>("/data-views");
  return response.data ?? [];
}

export function canReadDataView(views: DataView[], viewID: string): boolean {
  return views.some((view) => view.view_id === viewID && view.actions.includes("read"));
}

export function canConnectDataView(views: DataView[], viewID: string): boolean {
  return views.some((view) => view.view_id === viewID && view.actions.includes("connect"));
}

export function canManageDataView(views: DataView[], viewID: string): boolean {
  return views.some((view) => view.view_id === viewID && view.actions.includes("manage"));
}

export function canReadAgentActivity(views: DataView[]): boolean {
  return canReadDataView(views, dataViewIds.agentActivity);
}

export function canReadBusinessData(views: DataView[]): boolean {
  return canReadDataView(views, dataViewIds.xiaohongshuOperation)
    || canReadDataView(views, dataViewIds.douyinAds)
    || canReadDataView(views, dataViewIds.bilibiliOperation);
}
