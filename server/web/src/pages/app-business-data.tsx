import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Database, FileText, Link2, LoaderCircle, Megaphone, PauseCircle, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts";
import { useLocation, useNavigate } from "react-router-dom";

import { ConfirmDialog, DataTableShell, ErrorAlert, PageHeader, PageShell, TableStateRow } from "@/components/governance-ui";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { APIError } from "@/lib/api";
import {
  getDouyinAdsDashboard,
  getBilibiliDashboard,
  getXiaohongshuDashboard,
  authorizeBilibili,
  deleteBilibiliSource,
  listBilibiliSources,
  redirectToBilibiliAuthorization,
  setBilibiliSourceSyncEnabled,
  syncBilibili,
  syncBilibiliSource,
  type BusinessDashboardRange,
  type BusinessDataStatus,
  type BilibiliDashboard,
  type BilibiliSource,
  type DouyinAdsDashboard,
  type XiaohongshuDashboard,
} from "@/lib/business-data-api";
import {
  canReadDataView,
  canConnectDataView,
  canManageDataView,
  dataViewIds,
  listMyDataViews,
  type BusinessDataViewID,
  type DataView,
} from "@/lib/data-views-api";
import { formatBeijingDateTime } from "@/lib/datetime";

const rangeOptions: Array<{ value: BusinessDashboardRange; label: string }> = [
  { value: "today", label: "今天" },
  { value: "7d", label: "近 7 天" },
  { value: "30d", label: "近 30 天" },
];

const dashboardViews: Array<{
  id: BusinessDataViewID;
  label: string;
  path: string;
}> = [
  {
    id: dataViewIds.xiaohongshuOperation,
    label: "小红书运营",
    path: "/app/business-data/xiaohongshu-operation",
  },
  {
    id: dataViewIds.douyinAds,
    label: "抖音投放",
    path: "/app/business-data/douyin-ads",
  },
  {
    id: dataViewIds.bilibiliOperation,
    label: "哔哩哔哩运营",
    path: "/app/business-data/bilibili-operation",
  },
];

const xiaohongshuTrendConfig = {
  exposure_count: { label: "曝光量", color: "hsl(var(--primary))" },
  interaction_count: { label: "互动量", color: "hsl(var(--success))" },
} satisfies ChartConfig;

const douyinTrendConfig = {
  spend: { label: "投放消耗（元）", color: "hsl(var(--primary))" },
  video_play_count: { label: "视频播放", color: "hsl(var(--warning))" },
} satisfies ChartConfig;

const bilibiliTrendMetricOptions = [
  { value: "view_count_delta", label: "播放量" },
  { value: "follower_count_delta", label: "粉丝数" },
  { value: "interaction_count_delta", label: "互动数" },
] as const;

type BilibiliTrendMetric = (typeof bilibiliTrendMetricOptions)[number]["value"];

export function AppBusinessDataPage({ requestedView }: { requestedView?: BusinessDataViewID }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [range, setRange] = useState<BusinessDashboardRange>("7d");
  const [authorizationResult] = useState<"success" | "failed" | null>(() => {
    const value = new URLSearchParams(location.search).get("authorization");
    return value === "success" || value === "failed" ? value : null;
  });
  const dataViewsQuery = useQuery({ queryKey: ["app-data-views"], queryFn: listMyDataViews });
  const authorizedViews = readableDashboardViews(dataViewsQuery.data ?? []);
  const activeView = authorizedViews.find((view) => view.id === requestedView) ?? authorizedViews[0];

  useEffect(() => {
    if (!dataViewsQuery.isSuccess || !activeView || requestedView === activeView.id) return;
    navigate(activeView.path, { replace: true });
  }, [activeView, dataViewsQuery.isSuccess, navigate, requestedView]);

  useEffect(() => {
    if (!authorizationResult) return;
    navigate(location.pathname, { replace: true });
  }, [authorizationResult, location.pathname, navigate]);

  if (dataViewsQuery.isLoading) return <BusinessDataPageSkeleton />;

  if (dataViewsQuery.isError) {
    return (
      <PageShell>
        <PageHeader title="数据看板" />
        <ErrorAlert>数据视图权限加载失败，请稍后重试。</ErrorAlert>
      </PageShell>
    );
  }

  if (!activeView) {
    return (
      <PageShell>
        <PageHeader title="数据看板" />
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><BarChart3 /></EmptyMedia>
            <EmptyTitle>当前账户未开通数据看板</EmptyTitle>
            <EmptyDescription>请联系管理员授予业务数据视图读取权限。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        actions={(
          <ToggleGroup
            aria-label="数据统计时间范围"
            onValueChange={(value) => value && setRange(value as BusinessDashboardRange)}
            type="single"
            value={range}
            variant="outline"
          >
            {rangeOptions.map((option) => (
              <ToggleGroupItem className="px-3" key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        title="数据看板"
      >
        当前账户已授权的业务数据视图
      </PageHeader>

      {activeView.id === dataViewIds.bilibiliOperation && authorizationResult ? (
        <Alert variant={authorizationResult === "success" ? "success" : "destructive"}>
          <Link2 />
          <AlertTitle>{authorizationResult === "success" ? "账号连接成功" : "账号连接失败"}</AlertTitle>
          <AlertDescription>
            {authorizationResult === "success" ? "首次同步已经排队，完成后看板会展示最新数据。" : "请确认账号权限后重新发起连接。"}
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs
        onValueChange={(viewID) => {
          const next = authorizedViews.find((view) => view.id === viewID);
          if (next) navigate(next.path);
        }}
        value={activeView.id}
      >
        <TabsList aria-label="业务数据视图" className="max-w-full justify-start overflow-x-auto">
          {authorizedViews.map((view) => (
            <TabsTrigger key={view.id} value={view.id}>{view.label}</TabsTrigger>
          ))}
        </TabsList>
        {authorizedViews.map((view) => (
          <TabsContent className="mt-4" key={view.id} value={view.id}>
            {view.id === activeView.id ? (
              <BusinessDashboardView
                canConnect={canConnectDataView(dataViewsQuery.data ?? [], view.id)}
                canManage={canManageDataView(dataViewsQuery.data ?? [], view.id)}
                range={range}
                viewID={view.id}
              />
            ) : null}
          </TabsContent>
        ))}
      </Tabs>
    </PageShell>
  );
}

function readableDashboardViews(views: DataView[]) {
  return dashboardViews.filter((view) => canReadDataView(views, view.id));
}

function BusinessDashboardView({
  canConnect,
  canManage,
  range,
  viewID,
}: {
  canConnect: boolean;
  canManage: boolean;
  range: BusinessDashboardRange;
  viewID: BusinessDataViewID;
}) {
  if (viewID === dataViewIds.bilibiliOperation) {
    return (
      <BilibiliOperationView
        canConnect={canConnect}
        canManage={canManage}
        range={range}
      />
    );
  }
  return <StandardBusinessDashboardView range={range} viewID={viewID} />;
}

function StandardBusinessDashboardView({
  range,
  viewID,
}: {
  range: BusinessDashboardRange;
  viewID: Exclude<BusinessDataViewID, "bilibili_operation">;
}) {
  const queryClient = useQueryClient();
  const dashboardQuery = useQuery<XiaohongshuDashboard | DouyinAdsDashboard>({
    queryKey: ["app-business-dashboard", viewID, range],
    queryFn: async () => {
      if (viewID === dataViewIds.xiaohongshuOperation)
        return await getXiaohongshuDashboard(range);
      return await getDouyinAdsDashboard(range);
    },
    retry: false,
  });

  useEffect(() => {
    if (
      dashboardQuery.error instanceof APIError &&
      dashboardQuery.error.code === "business_data_view_forbidden"
    ) {
      void queryClient.invalidateQueries({ queryKey: ["app-data-views"] });
    }
  }, [dashboardQuery.error, queryClient]);

  if (dashboardQuery.isLoading) return <DashboardContentSkeleton />;
  if (dashboardQuery.isError) {
    if (
      dashboardQuery.error instanceof APIError &&
      dashboardQuery.error.code === "business_data_view_forbidden"
    ) {
      return <DashboardPermissionRevoked />;
    }
    return <ErrorAlert>业务数据加载失败，请稍后重试。</ErrorAlert>;
  }

  const data = dashboardQuery.data;
  if (!data) return null;
  const rangedData = data as XiaohongshuDashboard | DouyinAdsDashboard;
  if (rangedData.data_status !== "available") {
    return <DashboardStateView data={rangedData} viewID={viewID} />;
  }
  if (!rangedData.summary) {
    return <ErrorAlert>业务数据响应不完整，请稍后重试。</ErrorAlert>;
  }
  return rangedData.view_id === dataViewIds.xiaohongshuOperation ? (
    <XiaohongshuDashboardView data={rangedData} />
  ) : (
    <DouyinAdsDashboardView data={rangedData} />
  );
}

function BilibiliOperationView({
  canConnect,
  canManage,
  range,
}: {
  canConnect: boolean;
  canManage: boolean;
  range: BusinessDashboardRange;
}) {
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [sourceToDisable, setSourceToDisable] = useState<BilibiliSource | null>(
    null,
  );
  const [sourceToDelete, setSourceToDelete] = useState<BilibiliSource | null>(
    null,
  );
  const sourcesQuery = useQuery({
    queryKey: ["bilibili-sources"],
    queryFn: listBilibiliSources,
    retry: false,
  });
  const sources = sourcesQuery.data ?? [];
  const requestedSourceID = new URLSearchParams(location.search).get("source_id") ?? "";
  const selectedSource =
    sources.find((source) => source.source_id === requestedSourceID) ??
    sources.find((source) => source.status === "active") ??
    sources[0];
  const selectedSourceID = selectedSource?.source_id ?? "";
  const dashboardQuery = useQuery({
    queryKey: ["app-business-dashboard", dataViewIds.bilibiliOperation, selectedSourceID, range],
    queryFn: () => getBilibiliDashboard(range, selectedSourceID),
    enabled: selectedSourceID !== "",
    retry: false,
  });

  const selectSource = (sourceID: string, replace = false) => {
    const query = new URLSearchParams(location.search);
    query.delete("authorization");
    query.set("source_id", sourceID);
    navigate(`${location.pathname}?${query}`, { replace });
  };

  useEffect(() => {
    if (!sourcesQuery.isSuccess || selectedSourceID === "" || requestedSourceID === selectedSourceID) return;
    const query = new URLSearchParams(location.search);
    query.delete("authorization");
    query.set("source_id", selectedSourceID);
    navigate(`${location.pathname}?${query}`, { replace: true });
  }, [location.pathname, location.search, navigate, requestedSourceID, selectedSourceID, sourcesQuery.isSuccess]);

  const invalidateBilibili = async (includeOverview = false) => {
    const invalidations = [
      queryClient.invalidateQueries({ queryKey: ["bilibili-sources"] }),
      queryClient.invalidateQueries({
        queryKey: ["app-business-dashboard", dataViewIds.bilibiliOperation],
      }),
    ];
    if (includeOverview) {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: ["app-business-dashboard-overview"],
        }),
      );
    }
    await Promise.all(invalidations);
  };
  const authorizeMutation = useMutation({
    mutationFn: authorizeBilibili,
    onSuccess: (authorizationURL) =>
      redirectToBilibiliAuthorization(authorizationURL),
  });
  const syncMutation = useMutation({
    mutationFn: syncBilibili,
    onSuccess: () => invalidateBilibili(),
  });
  const sourceSyncMutation = useMutation({
    mutationFn: syncBilibiliSource,
    onSuccess: () => invalidateBilibili(),
  });
  const sourceStateMutation = useMutation({
    mutationFn: ({
      sourceID,
      syncEnabled,
    }: {
      sourceID: string;
      syncEnabled: boolean;
    }) => setBilibiliSourceSyncEnabled(sourceID, syncEnabled),
    onSuccess: async () => {
      setSourceToDisable(null);
      await invalidateBilibili(true);
    },
  });
  const sourceDeleteMutation = useMutation({
    mutationFn: (sourceID: string) => deleteBilibiliSource(sourceID),
    onSuccess: async () => {
      setSourceToDelete(null);
      await invalidateBilibili(true);
    },
  });
  const operationError =
    authorizeMutation.error ??
    syncMutation.error ??
    sourceSyncMutation.error ??
    sourceStateMutation.error ??
    sourceDeleteMutation.error;
  const hasActiveSource = sources.some((source) => source.status === "active");
  const syncSucceeded =
    syncMutation.isSuccess ||
    sourceSyncMutation.isSuccess ||
    (sourceStateMutation.isSuccess &&
      sourceStateMutation.variables?.syncEnabled);

  return (
    <div className="grid gap-4">
      {operationError ? (
        <ErrorAlert>{operationError.message}</ErrorAlert>
      ) : null}
      {sourcesQuery.isError ? (
        <ErrorAlert>账号列表加载失败，请稍后重试。</ErrorAlert>
      ) : null}
      {syncSucceeded ? (
        <Alert variant="success">
          <RefreshCw />
          <AlertTitle>同步任务已提交</AlertTitle>
          <AlertDescription>
            任务将在后台执行，稍后刷新即可查看最新数据。
          </AlertDescription>
        </Alert>
      ) : null}
      <section aria-labelledby="bilibili-sources-title" className="grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold" id="bilibili-sources-title">
            账号管理
          </h2>
          <div className="ml-auto flex flex-wrap gap-2">
            {canConnect && hasActiveSource ? (
              <Button
                disabled={syncMutation.isPending}
                onClick={() => syncMutation.mutate()}
                size="sm"
                variant="outline"
              >
                {syncMutation.isPending ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                同步全部
              </Button>
            ) : null}
            {canConnect ? (
              <Button
                disabled={authorizeMutation.isPending}
                onClick={() => authorizeMutation.mutate()}
                size="sm"
              >
                {authorizeMutation.isPending ? (
                  <LoaderCircle
                    className="animate-spin"
                    data-icon="inline-start"
                  />
                ) : (
                  <Link2 data-icon="inline-start" />
                )}
                添加账号
              </Button>
            ) : null}
          </div>
        </div>
        <BilibiliSourceTable
          canConnect={canConnect}
          canManage={canManage}
          loading={sourcesQuery.isLoading}
          onAuthorize={() => authorizeMutation.mutate()}
          onDisable={setSourceToDisable}
          onDelete={setSourceToDelete}
          onEnable={(sourceID) =>
            sourceStateMutation.mutate({ sourceID, syncEnabled: true })
          }
          onSync={(sourceID) => sourceSyncMutation.mutate(sourceID)}
          operationPending={
            authorizeMutation.isPending ||
            sourceSyncMutation.isPending ||
            sourceStateMutation.isPending ||
            sourceDeleteMutation.isPending
          }
          sources={sources}
        />
      </section>
      {selectedSource ? (
        <section aria-labelledby="bilibili-dashboard-account-title" className="flex flex-wrap items-center gap-3">
          <h2 className="text-base font-semibold" id="bilibili-dashboard-account-title">
            账号数据
          </h2>
          <div className="ml-auto flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
            <Select onValueChange={selectSource} value={selectedSourceID}>
              <SelectTrigger aria-label="查看账号" className="w-full sm:w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {sources.map((source) => (
                    <SelectItem key={source.source_id} value={source.source_id}>
                      {bilibiliSourceOptionLabel(source, sources)}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Badge variant={bilibiliSourceStatus(selectedSource).variant}>
              {bilibiliSourceStatus(selectedSource).label}
            </Badge>
          </div>
        </section>
      ) : null}
      {sourcesQuery.isLoading || dashboardQuery.isLoading ? (
        <DashboardContentSkeleton />
      ) : dashboardQuery.error instanceof APIError &&
        dashboardQuery.error.code === "business_data_view_forbidden" ? (
        <DashboardPermissionRevoked />
      ) : dashboardQuery.error ? (
        <ErrorAlert>业务数据加载失败，请稍后重试。</ErrorAlert>
      ) : sourcesQuery.isError ? null : !selectedSource ? (
        <BilibiliStateView status="unconfigured" />
      ) : dashboardQuery.data && dashboardQuery.data.status !== "available" ? (
        <BilibiliStateView
          source={selectedSource}
          status={dashboardQuery.data.status}
        />
      ) : dashboardQuery.data?.data ? (
        <BilibiliDashboardView
          data={dashboardQuery.data.data}
          endDate={dashboardQuery.data.end_date}
          startDate={dashboardQuery.data.start_date}
        />
      ) : (
        <ErrorAlert>业务数据响应不完整，请稍后重试。</ErrorAlert>
      )}
      <ConfirmDialog
        description="停止后将不再采集该账号的新数据，已采集数据会保留。"
        confirmLabel="停止同步"
        error={sourceStateMutation.error?.message}
        onClose={() => {
          if (!sourceStateMutation.isPending) setSourceToDisable(null);
        }}
        onConfirm={() => {
          if (sourceToDisable)
            sourceStateMutation.mutate({
              sourceID: sourceToDisable.source_id,
              syncEnabled: false,
            });
        }}
        open={sourceToDisable !== null}
        pending={sourceStateMutation.isPending}
        title="停止同步"
        variant="destructive"
      />
      <ConfirmDialog
        confirmLabel="删除账号"
        description="删除后将清理该账号的授权凭据、稿件、快照和同步历史，且无法恢复。"
        error={sourceDeleteMutation.error?.message}
        onClose={() => {
          if (!sourceDeleteMutation.isPending) setSourceToDelete(null);
        }}
        onConfirm={() => {
          if (sourceToDelete)
            sourceDeleteMutation.mutate(sourceToDelete.source_id);
        }}
        open={sourceToDelete !== null}
        pending={sourceDeleteMutation.isPending}
        title="删除账号"
        variant="destructive"
      />
    </div>
  );
}

function BilibiliStateView({
  source,
  status,
}: {
  source?: BilibiliSource;
  status: BusinessDataStatus;
}) {
  const unconfigured = status === "unconfigured";
  return (
    <Alert variant={unconfigured ? "muted" : "warning"}>
      <Database />
      <AlertTitle>
        {unconfigured ? "数据源尚未接入" : "数据暂不可用"}
      </AlertTitle>
      <AlertDescription>
        <p>
          {unconfigured
            ? "当前尚未接入哔哩哔哩账号。"
            : source?.status === "disabled"
              ? "该账号已停止同步，暂无可展示的历史数据。"
              : "所选账号还没有成功同步的数据。"}
        </p>
      </AlertDescription>
    </Alert>
  );
}

function BilibiliSourceTable({
  canConnect,
  canManage,
  loading,
  onAuthorize,
  onDisable,
  onDelete,
  onEnable,
  onSync,
  operationPending,
  sources,
}: {
  canConnect: boolean;
  canManage: boolean;
  loading: boolean;
  onAuthorize: () => void;
  onDisable: (source: BilibiliSource) => void;
  onDelete: (source: BilibiliSource) => void;
  onEnable: (sourceID: string) => void;
  onSync: (sourceID: string) => void;
  operationPending: boolean;
  sources: BilibiliSource[];
}) {
  return (
    <TooltipProvider>
      <DataTableShell minWidth={780}>
        <TableHeader>
          <TableRow>
            <TableHead>账号</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>上次成功</TableHead>
            <TableHead>下次同步</TableHead>
            <TableHead className="text-right">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableStateRow colSpan={5}>正在加载账号...</TableStateRow>
          ) : null}
          {!loading && sources.length === 0 ? (
            <TableStateRow colSpan={5}>暂无已接入账号</TableStateRow>
          ) : null}
          {!loading
            ? sources.map((source) => {
                const status = bilibiliSourceStatus(source);
                const authorizationRequired =
                  source.status === "disabled" &&
                  (source.status_reason === "bilibili_deauthorized" ||
                    source.status_reason === "bilibili_reauth_required");
                const activeRun =
                  source.active_run_status === "queued" ||
                  source.active_run_status === "running";
                return (
                  <TableRow key={source.source_id}>
                    <TableCell className="font-medium">{source.name}</TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      {formatBeijingDateTime(source.last_success_at)}
                    </TableCell>
                    <TableCell>
                      {source.status === "active"
                        ? formatBeijingDateTime(source.next_sync_at)
                        : "-"}
                    </TableCell>
                    <TableCell>
                      <div className="flex min-h-9 items-center justify-end gap-2">
                        {canConnect && source.status === "active" ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                aria-label={`立即同步 ${source.name}`}
                                disabled={operationPending || activeRun}
                                onClick={() => onSync(source.source_id)}
                                size="icon"
                                variant="outline"
                              >
                                <RefreshCw />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>立即同步</TooltipContent>
                          </Tooltip>
                        ) : null}
                        {canManage && source.status === "active" ? (
                          <Button
                            disabled={operationPending}
                            onClick={() => onDisable(source)}
                            size="sm"
                            variant="outline"
                          >
                            <PauseCircle data-icon="inline-start" />
                            停止同步
                          </Button>
                        ) : null}
                        {canManage &&
                        source.status_reason === "bilibili_sync_disabled" ? (
                          <Button
                            disabled={operationPending}
                            onClick={() => onEnable(source.source_id)}
                            size="sm"
                            variant="outline"
                          >
                            <RotateCcw data-icon="inline-start" />
                            恢复同步
                          </Button>
                        ) : null}
                        {canConnect && authorizationRequired ? (
                          <Button
                            disabled={operationPending}
                            onClick={onAuthorize}
                            size="sm"
                            variant="outline"
                          >
                            <Link2 data-icon="inline-start" />
                            重新授权
                          </Button>
                        ) : null}
                        {canManage ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                aria-label={`删除账号 ${source.name}`}
                                disabled={operationPending}
                                onClick={() => onDelete(source)}
                                size="icon"
                                variant="destructive"
                              >
                                <Trash2 />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>删除账号</TooltipContent>
                          </Tooltip>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            : null}
        </TableBody>
      </DataTableShell>
    </TooltipProvider>
  );
}

function bilibiliSourceStatus(source: BilibiliSource): {
  label: string;
  variant: "success" | "warning" | "muted" | "destructive";
} {
  if (source.status_reason === "bilibili_sync_disabled")
    return { label: "已停止", variant: "muted" };
  if (source.status_reason === "bilibili_deauthorized")
    return { label: "已解除授权", variant: "destructive" };
  if (source.status_reason === "bilibili_reauth_required") {
    return { label: "授权已失效", variant: "destructive" };
  }
  if (source.active_run_status === "queued")
    return { label: "排队中", variant: "warning" };
  if (source.active_run_status === "running")
    return { label: "同步中", variant: "warning" };
  if (source.status_reason)
    return { label: "同步失败", variant: "destructive" };
  return { label: "正常", variant: "success" };
}

function bilibiliSourceOptionLabel(source: BilibiliSource, sources: BilibiliSource[]) {
  const duplicateName = sources.some(
    (candidate) => candidate.source_id !== source.source_id && candidate.name === source.name,
  );
  const identity = duplicateName ? ` · ${source.source_id.slice(-6)}` : "";
  const status = source.status === "disabled" ? "（已停止同步）" : "";
  return `${source.name}${identity}${status}`;
}

function BilibiliDashboardView({
  data,
  endDate,
  startDate,
}: {
  data: NonNullable<BilibiliDashboard["data"]>;
  endDate: string;
  startDate: string;
}) {
  const [trendMetric, setTrendMetric] = useState<BilibiliTrendMetric>("view_count_delta");
  const trendMetricLabel = bilibiliTrendMetricOptions.find((option) => option.value === trendMetric)?.label ?? "播放量";
  const trendChartConfig = {
    daily_delta: { label: `${trendMetricLabel}日增`, color: "hsl(var(--primary))" },
    positive: { color: "hsl(var(--primary))" },
    negative: { color: "hsl(var(--destructive))" },
    zero: { color: "hsl(var(--muted-foreground))" },
  } satisfies ChartConfig;
  const trendChartData = data.trend.map((point) => {
    const dailyDelta = point[trendMetric];
    return {
      date: point.date,
      daily_delta: dailyDelta,
      fill: dailyDelta > 0
        ? "var(--color-positive)"
        : dailyDelta < 0
          ? "var(--color-negative)"
          : "var(--color-zero)",
    };
  });
  const metrics = [
    { label: "当前粉丝", value: formatInteger(data.follower_count) },
    { label: "已采集稿件", value: formatInteger(data.collected_content_count) },
    { label: "稿件累计播放合计", value: formatInteger(data.view_count) },
    { label: "稿件累计互动合计", value: formatInteger(data.interaction_count) },
  ];
  return (
    <div className="grid gap-4">
      <div
        aria-label="数据状态"
        className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground"
      >
        <Badge variant="success">数据可用</Badge>
        <span>{startDate} 至 {endDate}</span>
        <span>·</span>
        <span>采集于 {formatBeijingDateTime(data.captured_at)}</span>
      </div>
      <MetricGrid metrics={metrics} />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>
            <h2>日增长趋势</h2>
          </CardTitle>
          <CardDescription>
            每日累计快照，日增长为当日累计值减前一日累计值；缺日沿用最近一次快照
          </CardDescription>
          <ToggleGroup
            aria-label="日增长指标"
            className="mt-2 justify-start"
            onValueChange={(value) => {
              if (value) setTrendMetric(value as BilibiliTrendMetric);
            }}
            size="sm"
            type="single"
            value={trendMetric}
            variant="outline"
          >
            {bilibiliTrendMetricOptions.map((option) => (
              <ToggleGroupItem aria-label={option.label} key={option.value} value={option.value}>
                {option.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 p-0">
          <div className="px-6">
            <ChartContainer
              aria-label={`B 站${trendMetricLabel}日增长图`}
              className="h-[280px] w-full"
              config={trendChartConfig}
              role="img"
            >
              <BarChart accessibilityLayer data={trendChartData} margin={{ left: 4, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis
                  axisLine={false}
                  dataKey="date"
                  minTickGap={24}
                  tickFormatter={(value) => String(value).slice(5)}
                  tickLine={false}
                  tickMargin={8}
                />
                <YAxis axisLine={false} tickFormatter={formatCompactNumber} tickLine={false} width={62} />
                <ReferenceLine stroke="hsl(var(--border))" y={0} />
                <ChartTooltip
                  content={({ active, label, payload }) => (
                    <ChartTooltipContent
                      active={active}
                      label={label}
                      payload={payload?.map((item) => ({
                        ...item,
                        value: formatSignedInteger(Number(item.value)),
                      }))}
                    />
                  )}
                  cursor={{ fill: "hsl(var(--muted))" }}
                />
                <Bar dataKey="daily_delta" fill="var(--color-daily_delta)" radius={4}>
                  {trendChartData.map((point) => (
                    <Cell fill={point.fill} key={point.date} />
                  ))}
                </Bar>
              </BarChart>
            </ChartContainer>
          </div>
          <div className="overflow-x-auto">
            <Table className="min-w-[860px]">
              <TableHeader>
                <TableRow>
                  <TableHead>日期</TableHead>
                  <TableHead className="text-right">播放量</TableHead>
                  <TableHead className="text-right">播放量日增</TableHead>
                  <TableHead className="text-right">粉丝数</TableHead>
                  <TableHead className="text-right">粉丝数日增</TableHead>
                  <TableHead className="text-right">互动数</TableHead>
                  <TableHead className="text-right">互动数日增</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.trend.map((point) => (
                  <TableRow key={point.date}>
                    <TableCell className="font-mono">{point.date}</TableCell>
                    <TableCell className="text-right font-mono">{formatInteger(point.view_count)}</TableCell>
                    <TableCell className="text-right font-mono">{formatSignedInteger(point.view_count_delta)}</TableCell>
                    <TableCell className="text-right font-mono">{formatInteger(point.follower_count)}</TableCell>
                    <TableCell className="text-right font-mono">{formatSignedInteger(point.follower_count_delta)}</TableCell>
                    <TableCell className="text-right font-mono">{formatInteger(point.interaction_count)}</TableCell>
                    <TableCell className="text-right font-mono">{formatSignedInteger(point.interaction_count_delta)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle>
            <h2>热门稿件</h2>
          </CardTitle>
          <CardDescription>
            按最后已知累计播放量降序排列，最多展示 20 条
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          {data.top_contents.length === 0 ? (
            <TableEmpty icon="content" title="暂无稿件数据" />
          ) : (
            <Table className="min-w-[820px]">
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>稿件</TableHead>
                  <TableHead>数据时间</TableHead>
                  <TableHead className="text-right">播放量</TableHead>
                  <TableHead className="text-right">互动量</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.top_contents.map((item) => (
                  <TableRow
                    key={`${item.source_id}-${item.external_content_id}`}
                  >
                    <TableCell>{item.account_name}</TableCell>
                    <TableCell className="max-w-[360px]">
                      <div
                        className="truncate font-medium"
                        title={item.title || item.external_content_id}
                      >
                        {item.title || item.external_content_id}
                      </div>
                      <div className="mt-1 truncate font-mono text-xs text-muted-foreground">
                        {item.external_content_id}
                      </div>
                    </TableCell>
                    <TableCell>
                      {formatBeijingDateTime(item.captured_at)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatInteger(item.view_count)}
                    </TableCell>
                    <TableCell className="text-right font-mono">
                      {formatInteger(item.interaction_count)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DashboardPermissionRevoked() {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><BarChart3 /></EmptyMedia>
        <EmptyTitle>数据视图授权已失效</EmptyTitle>
        <EmptyDescription>请联系管理员确认当前账户的数据视图权限。</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function DashboardStateView({
  data,
  viewID,
}: {
  data: XiaohongshuDashboard | DouyinAdsDashboard;
  viewID: BusinessDataViewID;
}) {
  const unconfigured = data.data_status === "unconfigured";
  const labels = viewID === dataViewIds.xiaohongshuOperation
    ? ["发布笔记数", "曝光量", "互动量", "新增粉丝", "转化数", "转化率"]
    : ["投放消耗", "视频播放", "转化次数", "归因收入", "综合 ROI"];

  return (
    <div className="grid gap-4">
      <Alert variant={unconfigured ? "muted" : "warning"}>
        <Database />
        <AlertTitle>{unconfigured ? "数据源尚未接入" : "数据暂不可用"}</AlertTitle>
        <AlertDescription>
          {unconfigured
            ? "当前视图尚未配置业务数据源。"
            : "数据源已启用，但还没有成功同步的数据。"}
          {data.last_synced_at ? ` 最近同步：${formatBeijingDateTime(data.last_synced_at)}。` : null}
        </AlertDescription>
      </Alert>

      <MetricGrid metrics={labels.map((label) => ({ label, value: "--" }))} />

      <section aria-label="看板数据结构" className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(360px,0.65fr)]">
        <EmptyDashboardCard description="完成首次同步后显示所选时间范围内的每日趋势。" title="趋势" />
        <EmptyDashboardCard
          description={viewID === dataViewIds.xiaohongshuOperation
            ? "完成首次同步后显示热门笔记。"
            : "完成首次同步后显示计划表现。"}
          title={viewID === dataViewIds.xiaohongshuOperation ? "热门笔记" : "计划表现"}
        />
      </section>
    </div>
  );
}

function XiaohongshuDashboardView({ data }: { data: XiaohongshuDashboard }) {
  const summary = data.summary!;
  const metrics = [
    { label: "发布笔记数", value: formatInteger(summary.published_count), foot: formatChange(summary.published_count_change_rate) },
    { label: "曝光量", value: formatInteger(summary.exposure_count), foot: formatChange(summary.exposure_count_change_rate) },
    { label: "互动量", value: formatInteger(summary.interaction_count), foot: formatChange(summary.interaction_count_change_rate) },
    { label: "新增粉丝", value: formatInteger(summary.new_follower_count), foot: formatChange(summary.new_follower_count_change_rate) },
    { label: "转化数", value: formatNullableInteger(summary.conversion_count), foot: summary.conversion_count === null ? "口径待确认" : undefined },
    { label: "转化率", value: formatNullablePercent(summary.conversion_rate), foot: summary.conversion_rate === null ? "口径待确认" : undefined },
  ];
  const trend = data.trend.map((point) => ({ ...point, label: formatDateLabel(point.date) }));

  return (
    <div className="grid gap-4">
      <DashboardStatus data={data} />
      <MetricGrid metrics={metrics} />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle><h2>运营趋势</h2></CardTitle>
          <CardDescription>曝光量与互动量按自然日统计</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer aria-label="小红书运营趋势图" className="h-[300px] w-full" config={xiaohongshuTrendConfig} role="img">
            <AreaChart accessibilityLayer data={trend} margin={{ left: 4, right: 12, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis axisLine={false} dataKey="label" minTickGap={24} tickLine={false} />
              <YAxis axisLine={false} tickFormatter={formatCompactNumber} tickLine={false} width={62} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area dataKey="exposure_count" fill="var(--color-exposure_count)" fillOpacity={0.12} isAnimationActive={false} stroke="var(--color-exposure_count)" strokeWidth={2} type="monotone" />
              <Area dataKey="interaction_count" fill="var(--color-interaction_count)" fillOpacity={0.08} isAnimationActive={false} stroke="var(--color-interaction_count)" strokeWidth={2} type="monotone" />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>
      <XiaohongshuTopItems data={data} />
    </div>
  );
}

function DouyinAdsDashboardView({ data }: { data: DouyinAdsDashboard }) {
  const summary = data.summary!;
  const metrics = [
    { label: "投放消耗", value: formatCurrencyMinor(summary.spend_minor, summary.currency), foot: formatChange(summary.spend_change_rate) },
    { label: "视频播放", value: formatInteger(summary.video_play_count), foot: formatChange(summary.video_play_count_change_rate) },
    { label: "转化次数", value: formatNullableInteger(summary.conversion_count), foot: summary.conversion_count === null ? "口径待确认" : undefined },
    { label: "归因收入", value: formatNullableCurrency(summary.attributed_revenue_minor, summary.currency), foot: summary.attributed_revenue_minor === null ? "口径待确认" : undefined },
    { label: "综合 ROI", value: summary.roi === null ? "--" : formatDecimal(summary.roi), foot: summary.roi === null ? "口径待确认" : undefined },
  ];
  const trend = data.trend.map((point) => ({
    ...point,
    label: formatDateLabel(point.date),
    spend: point.spend_minor / 100,
  }));

  return (
    <div className="grid gap-4">
      <DashboardStatus data={data} />
      <MetricGrid metrics={metrics} />
      <Card className="shadow-none">
        <CardHeader>
          <CardTitle><h2>投放趋势</h2></CardTitle>
          <CardDescription>投放消耗与视频播放按自然日统计</CardDescription>
        </CardHeader>
        <CardContent>
          <ChartContainer aria-label="抖音投放趋势图" className="h-[300px] w-full" config={douyinTrendConfig} role="img">
            <LineChart accessibilityLayer data={trend} margin={{ left: 4, right: 4, top: 8 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis axisLine={false} dataKey="label" minTickGap={24} tickLine={false} />
              <YAxis axisLine={false} tickFormatter={formatCompactNumber} tickLine={false} width={62} yAxisId="spend" />
              <YAxis axisLine={false} orientation="right" tickFormatter={formatCompactNumber} tickLine={false} width={62} yAxisId="plays" />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line dataKey="spend" dot={false} isAnimationActive={false} stroke="var(--color-spend)" strokeWidth={2} type="monotone" yAxisId="spend" />
              <Line dataKey="video_play_count" dot={false} isAnimationActive={false} stroke="var(--color-video_play_count)" strokeWidth={2} type="monotone" yAxisId="plays" />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>
      <DouyinTopItems data={data} />
    </div>
  );
}

function DashboardStatus({ data }: { data: XiaohongshuDashboard | DouyinAdsDashboard }) {
  return (
    <div aria-label="数据状态" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <Badge variant="success">数据可用</Badge>
      <span>{data.start_date} 至 {data.end_date}</span>
      <span>·</span>
      <span>最近同步 {formatBeijingDateTime(data.last_synced_at)}</span>
    </div>
  );
}

function MetricGrid({ metrics }: { metrics: Array<{ label: string; value: string; foot?: string }> }) {
  return (
    <section aria-label="核心指标" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {metrics.map((metric) => (
        <Card className="shadow-none" key={metric.label}>
          <CardHeader className="p-5 pb-2">
            <CardDescription>{metric.label}</CardDescription>
          </CardHeader>
          <CardContent className="p-5 pt-0">
            <strong className="block truncate font-mono text-2xl font-semibold" title={metric.value}>{metric.value}</strong>
            <div className="mt-2 min-h-5 text-xs text-muted-foreground">{metric.foot ?? "\u00a0"}</div>
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

function EmptyDashboardCard({ title, description }: { title: string; description: string }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle><h2>{title}</h2></CardTitle>
        <CardDescription>暂无可展示的数据</CardDescription>
      </CardHeader>
      <CardContent>
        <Empty className="min-h-[240px]">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Database /></EmptyMedia>
            <EmptyTitle>等待业务数据</EmptyTitle>
            <EmptyDescription>{description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  );
}

function XiaohongshuTopItems({ data }: { data: XiaohongshuDashboard }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle><h2>热门笔记</h2></CardTitle>
        <CardDescription>按曝光量降序排列，最多展示 20 条</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {data.top_items.length === 0 ? <TableEmpty icon="content" title="暂无热门笔记" /> : (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead>笔记</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="text-right">曝光量</TableHead>
                <TableHead className="text-right">互动量</TableHead>
                <TableHead className="text-right">互动率</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.top_items.map((item) => (
                <TableRow key={item.external_content_id}>
                  <TableCell className="max-w-[360px]">
                    <div className="truncate font-medium" title={item.title || item.external_content_id}>{item.title || item.external_content_id}</div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{item.external_content_id}</div>
                  </TableCell>
                  <TableCell>{item.content_type || "-"}</TableCell>
                  <TableCell className="text-right font-mono">{formatInteger(item.exposure_count)}</TableCell>
                  <TableCell className="text-right font-mono">{formatInteger(item.interaction_count)}</TableCell>
                  <TableCell className="text-right font-mono">{formatNullablePercent(item.interaction_rate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function DouyinTopItems({ data }: { data: DouyinAdsDashboard }) {
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardTitle><h2>计划表现</h2></CardTitle>
        <CardDescription>按投放消耗降序排列，最多展示 20 条</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {data.top_items.length === 0 ? <TableEmpty icon="campaign" title="暂无计划数据" /> : (
          <Table className="min-w-[900px]">
            <TableHeader>
              <TableRow>
                <TableHead>计划</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="text-right">消耗</TableHead>
                <TableHead className="text-right">展现量</TableHead>
                <TableHead className="text-right">播放量</TableHead>
                <TableHead className="text-right">点击量</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.top_items.map((item) => (
                <TableRow key={item.external_campaign_id}>
                  <TableCell className="max-w-[320px]">
                    <div className="truncate font-medium" title={item.name || item.external_campaign_id}>{item.name || item.external_campaign_id}</div>
                    <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{item.external_campaign_id}</div>
                  </TableCell>
                  <TableCell>{item.campaign_type || "-"}</TableCell>
                  <TableCell className="text-right font-mono">{formatCurrencyMinor(item.spend_minor, item.currency)}</TableCell>
                  <TableCell className="text-right font-mono">{formatInteger(item.impression_count)}</TableCell>
                  <TableCell className="text-right font-mono">{formatInteger(item.video_play_count)}</TableCell>
                  <TableCell className="text-right font-mono">{formatInteger(item.click_count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function TableEmpty({ icon, title }: { icon: "content" | "campaign"; title: string }) {
  const Icon = icon === "content" ? FileText : Megaphone;
  return (
    <Empty className="min-h-48 rounded-none border-0 border-t">
      <EmptyHeader>
        <EmptyMedia variant="icon"><Icon /></EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>当前时间范围内没有可展示的记录。</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function BusinessDataPageSkeleton() {
  return (
    <PageShell>
      <div className="flex flex-col gap-3 border-b border-border pb-5">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-5 w-72 max-w-full" />
      </div>
      <DashboardContentSkeleton />
    </PageShell>
  );
}

function DashboardContentSkeleton() {
  return (
    <div className="grid gap-4" aria-label="数据看板加载中">
      <Skeleton className="h-9 w-64 max-w-full" />
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Card className="shadow-none" key={index}>
            <CardHeader className="p-5 pb-2"><Skeleton className="h-4 w-24" /></CardHeader>
            <CardContent className="p-5 pt-0"><Skeleton className="h-8 w-32" /></CardContent>
          </Card>
        ))}
      </section>
      <Card className="shadow-none">
        <CardHeader><Skeleton className="h-5 w-32" /></CardHeader>
        <CardContent><Skeleton className="h-[300px] w-full" /></CardContent>
      </Card>
    </div>
  );
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatSignedInteger(value: number) {
  if (value <= 0) return formatInteger(value);
  return `+${formatInteger(value)}`;
}

function formatNullableInteger(value: number | null) {
  return value === null ? "--" : formatInteger(value);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatNullablePercent(value: number | null) {
  return value === null
    ? "--"
    : new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value);
}

function formatChange(value: number | null) {
  if (value === null) return "较上期 --";
  const formatted = new Intl.NumberFormat("zh-CN", {
    style: "percent",
    maximumFractionDigits: 1,
    signDisplay: "always",
  }).format(value);
  return `较上期 ${formatted}`;
}

function formatCurrencyMinor(value: number, currency: string) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: currency || "CNY",
    minimumFractionDigits: 2,
  }).format(value / 100);
}

function formatNullableCurrency(value: number | null, currency: string) {
  return value === null ? "--" : formatCurrencyMinor(value, currency);
}

function formatDecimal(value: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
}

function formatDateLabel(value: string) {
  const [, month = "", day = ""] = value.split("-");
  return month && day ? `${month}/${day}` : value;
}
