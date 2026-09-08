import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Search, ShieldOff, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";

import {
  EmptyState,
  ErrorAlert,
  ConfirmDialog,
  DataTableShell,
  DetailDrawer,
  KeyValueList,
  MetricCard,
  PageHeader,
  PageShell,
  TableStateRow,
} from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCollectorSearch } from "@/hooks/useCollectorSearch";
import { formatBeijingDateTime } from "@/lib/datetime";
import {
  createRegistrationCode,
  deleteCollector,
  fetchCollectorOverview,
  fetchRegistrationCode,
  revokeCollectorToken,
  type CollectorItem,
  type CollectorStatus,
  type RegistrationCodeDetail,
} from "@/lib/office-api";
import { listAccounts } from "@/lib/accounts-api";
import { permissions } from "@/lib/rbac-api";

const collectorOverviewQueryKey = ["office", "collectors", "overview"] as const;

export function CollectorManagementView({
  selectedCollectorID,
  onCloseDetail,
}: {
  selectedCollectorID?: string | null;
  onCloseDetail?: () => void;
}) {
  const canManage = useAdminPermission(permissions.collectorManage);
  const canReadAccounts = useAdminPermission(permissions.accountRead);
  const queryClient = useQueryClient();
  const [selectedUserID, setSelectedUserID] = useState("");
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CollectorItem | null>(null);

  const overviewQuery = useQuery({
    queryKey: collectorOverviewQueryKey,
    queryFn: fetchCollectorOverview,
  });
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: listAccounts,
    enabled: canManage && canReadAccounts,
  });
  const activeAccounts = (accountsQuery.data ?? []).filter((account) => account.status === "active");
  const registrationCodeQueryKey = ["office", "collector-registration-code", selectedUserID] as const;
  const registrationCodeQuery = useQuery({
    queryKey: registrationCodeQueryKey,
    queryFn: () => fetchRegistrationCode(selectedUserID),
    enabled: canManage && Boolean(selectedUserID),
  });

  const collectors = overviewQuery.data?.collectors ?? [];
  const selectedCollector = collectors.find((collector) => collector.collector_id === selectedCollectorID) ?? null;
  const { query, setQuery, filteredCollectors } = useCollectorSearch(collectors);
  const registration = registrationCodeQuery.data ?? null;
  const registrationState = getRegistrationState(registration, overviewQuery.data?.server_time);
  const copyableRegistrationCode = registrationState === "valid" ? registration?.registration_code ?? "" : "";

  const createCodeMutation = useMutation({
    mutationFn: () => createRegistrationCode(selectedUserID),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: collectorOverviewQueryKey }),
        queryClient.invalidateQueries({ queryKey: registrationCodeQueryKey }),
      ]);
    },
  });

  const revokeCollectorMutation = useMutation({
    mutationFn: (collectorId: string) => revokeCollectorToken(collectorId),
    onSuccess: async () => {
      setRevokeError(null);
      await queryClient.invalidateQueries({ queryKey: collectorOverviewQueryKey });
    },
    onError: (error) => {
      setRevokeError(error instanceof Error ? error.message : "请稍后重试");
    },
  });

  const deleteCollectorMutation = useMutation({
    mutationFn: (collectorId: string) => deleteCollector(collectorId),
    onSuccess: async () => {
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: collectorOverviewQueryKey });
    },
  });

  return (
    <PageShell>
      <PageHeader
        actions={
          <Button disabled={overviewQuery.isFetching || registrationCodeQuery.isFetching} onClick={() => {
            void overviewQuery.refetch();
            if (selectedUserID) void registrationCodeQuery.refetch();
          }} variant="outline">
            <RefreshCw aria-hidden="true" data-icon="inline-start" className={overviewQuery.isFetching || registrationCodeQuery.isFetching ? "animate-spin" : undefined} />
            刷新
          </Button>
        }
        title="采集器管理"
      />

      {overviewQuery.isError ? <ErrorAlert>采集器数据加载失败</ErrorAlert> : null}
      {registrationCodeQuery.isError ? <ErrorAlert>注册码加载失败</ErrorAlert> : null}
      {revokeError ? <ErrorAlert>撤销失败：{revokeError}</ErrorAlert> : null}

      <section className="grid min-w-0 gap-4">
        {canManage ? <RegistrationCodePanel
          allowAccountLookup={canReadAccounts}
          copyableRegistrationCode={copyableRegistrationCode}
          createdAt={registration?.created_at}
          createPending={createCodeMutation.isPending}
          expiresAt={registration?.expires_at}
          hasRegistration={registrationState === "valid"}
          installCommand={registrationState === "valid" ? registration?.install_command : undefined}
          installPowerShellCommand={registrationState === "valid" ? registration?.install_powershell_command : undefined}
          installURL={registrationState === "valid" ? registration?.install_url : undefined}
          lastUsedAt={registration?.last_used_at}
          accounts={activeAccounts}
          selectedUserID={selectedUserID}
          onSelectedUserIDChange={setSelectedUserID}
          registrationLabel={registrationBadgeLabel(registrationState)}
          registrationValue={registration?.registration_code || (selectedUserID ? "暂无注册码" : "请选择责任账号")}
          usedCount={registration?.used_count ?? 0}
          onRegenerate={() => createCodeMutation.mutate()}
        /> : null}

      </section>

      <section className="grid min-w-0 gap-4">
        <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="总采集器" value={overviewQuery.isLoading ? "..." : overviewQuery.data?.summary.total_collectors ?? 0} />
          <MetricCard label="在线" value={overviewQuery.isLoading ? "..." : overviewQuery.data?.summary.online_collectors ?? 0} />
          <MetricCard label="离线" value={overviewQuery.isLoading ? "..." : overviewQuery.data?.summary.offline_collectors ?? 0} />
          <MetricCard label="从未上报" value={overviewQuery.isLoading ? "..." : overviewQuery.data?.summary.never_seen_collectors ?? 0} />
        </div>

        <Card className="min-w-0 shadow-none">
          <CardHeader className="gap-3">
            <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
              <div>
                <CardTitle>采集器列表</CardTitle>
              </div>
              <label className="relative w-full md:w-80">
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  aria-label="搜索采集器"
                  className="pl-9"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索采集器 ID、设备名称或设备 ID"
                  type="search"
                  value={query}
                />
              </label>
            </div>
          </CardHeader>
          <CardContent className="min-w-0">
            {overviewQuery.isLoading ? (
              <div className="text-sm text-muted-foreground">列表加载中</div>
            ) : overviewQuery.isError ? (
              <EmptyState title="采集器数据加载失败" description="请稍后刷新重试。" />
            ) : collectors.length === 0 ? (
              <EmptyState title="暂无采集器上报" description="生成注册码并在本地采集器配置后，首次心跳成功就会显示在这里。" />
            ) : filteredCollectors.length === 0 ? (
              <EmptyState title="没有匹配的采集器" description="请调整搜索条件。" />
            ) : (
              <CollectorTable
                canManage={canManage}
                collectors={filteredCollectors}
                revokingCollectorId={revokeCollectorMutation.variables}
                onDelete={(collector) => {
                  deleteCollectorMutation.reset();
                  setDeleteTarget(collector);
                }}
                onRevoke={(collector) => {
                  setRevokeError(null);
                  if (window.confirm(`确定撤销采集器 ${collector.collector_id} 的 Token 吗？`)) {
                    revokeCollectorMutation.mutate(collector.collector_id);
                  }
                }}
              />
            )}
          </CardContent>
        </Card>
      </section>

      <DetailDrawer
        contextLabel="采集器详情"
        onClose={() => onCloseDetail?.()}
        open={Boolean(selectedCollector)}
        subtitle={selectedCollector?.collector_id ?? ""}
        title={selectedCollector?.device_name || selectedCollector?.hostname || selectedCollector?.collector_id || ""}
      >
        {selectedCollector ? (
          <KeyValueList
            items={[
              { label: "collector_id", value: selectedCollector.collector_id },
              { label: "责任账号", value: selectedCollector.user_name || selectedCollector.user_email || selectedCollector.user_id || "-" },
              { label: "设备", value: selectedCollector.device_name || selectedCollector.hostname || "-" },
              { label: "device_id", value: selectedCollector.device_id || "-" },
              { label: "系统", value: `${selectedCollector.os || "-"} / ${selectedCollector.arch || "-"}` },
              { label: "版本", value: selectedCollector.collector_version || "-" },
              { label: "已注册智能体", value: selectedCollector.registered_agent_count },
              { label: "最近心跳", value: formatDateTime(selectedCollector.last_seen_at, "尚未上报") },
              { label: "状态", value: <CollectorStatusBadge status={selectedCollector.status} /> },
              { label: "Token", value: selectedCollector.token_status === "active" ? "有效" : "已撤销" },
            ]}
          />
        ) : null}
      </DetailDrawer>

      <ConfirmDialog
        confirmLabel={deleteCollectorMutation.isPending ? "删除中..." : "确认删除"}
        description={deleteTarget ? `删除后，采集器 ${deleteTarget.collector_id} 及其采集状态将无法恢复。` : ""}
        error={deleteCollectorMutation.isError ? `删除失败：${deleteCollectorMutation.error.message}` : undefined}
        onClose={() => {
          if (!deleteCollectorMutation.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => deleteTarget && deleteCollectorMutation.mutate(deleteTarget.collector_id)}
        open={Boolean(deleteTarget)}
        pending={deleteCollectorMutation.isPending}
        title="删除采集器"
        variant="destructive"
      />
    </PageShell>
  );
}

function RegistrationCodePanel({
  allowAccountLookup,
  registrationValue,
  registrationLabel,
  copyableRegistrationCode,
  installURL,
  installCommand,
  installPowerShellCommand,
  accounts,
  selectedUserID,
  onSelectedUserIDChange,
  createPending,
  hasRegistration,
  createdAt,
  expiresAt,
  lastUsedAt,
  usedCount,
  onRegenerate,
}: {
  allowAccountLookup: boolean;
  registrationValue: string;
  registrationLabel: string;
  copyableRegistrationCode: string;
  installURL?: string;
  installCommand?: string;
  installPowerShellCommand?: string;
  accounts: Array<{ userId: string; name: string; email: string }>;
  selectedUserID: string;
  onSelectedUserIDChange: (userID: string) => void;
  createPending: boolean;
  hasRegistration: boolean;
  createdAt?: string;
  expiresAt?: string;
  lastUsedAt?: string;
  usedCount: number;
  onRegenerate: () => void;
}) {
  return (
    <Card className="min-w-0 shadow-none">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>采集器注册码</CardTitle>
          </div>
          <Badge variant={registrationLabel === "有效" ? "success" : registrationLabel === "已过期" ? "warning" : "muted"}>
            {registrationLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4">
        {allowAccountLookup ? <NativeSelect aria-label="责任账号" value={selectedUserID} onChange={(event) => onSelectedUserIDChange(event.target.value)}>
          <option value="">请选择启用状态的责任账号</option>
          {accounts.map((account) => <option key={account.userId} value={account.userId}>{account.name || account.email} ({account.email})</option>)}
        </NativeSelect> : <Input aria-label="责任账号" placeholder="输入已启用账号的 user_id" value={selectedUserID} onChange={(event) => onSelectedUserIDChange(event.target.value)} />}
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4 md:flex-row md:items-center md:justify-between">
          <code className="break-all text-base font-semibold">{registrationValue}</code>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton
              disabled={!copyableRegistrationCode}
              size="sm"
              value={copyableRegistrationCode}
              variant="secondary"
            />
            <Button disabled={createPending || !selectedUserID} onClick={onRegenerate} size="sm">
              {createPending ? "生成中" : hasRegistration ? "重新生成" : "生成注册码"}
            </Button>
          </div>
        </div>
        {installURL ? (
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">安装 URL</div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <code className="break-all text-sm">{installURL}</code>
              <CopyButton size="sm" value={installURL} variant="outline" />
            </div>
          </div>
        ) : null}
        {installCommand ? (
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">一键安装命令</div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <code className="break-all text-sm">{installCommand}</code>
              <CopyButton size="sm" value={installCommand} variant="outline" />
            </div>
          </div>
        ) : null}
        {installPowerShellCommand ? (
          <div className="rounded-lg border border-border bg-background p-4">
            <div className="mb-2 text-xs font-medium text-muted-foreground">PowerShell 安装命令</div>
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <code className="break-all text-sm">{installPowerShellCommand}</code>
              <CopyButton size="sm" value={installPowerShellCommand} variant="outline" />
            </div>
          </div>
        ) : null}

        {hasRegistration ? (
          <KeyValueList
            items={[
              { label: "创建时间", value: formatDateTime(createdAt) },
              { label: "过期时间", value: formatDateTime(expiresAt, "永久有效") },
              { label: "最近使用", value: formatDateTime(lastUsedAt, "尚未使用") },
              { label: "使用次数", value: String(usedCount) },
            ]}
            labelWidth={96}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function CollectorTable({
  canManage,
  collectors,
  revokingCollectorId,
  onDelete,
  onRevoke,
}: {
  canManage: boolean;
  collectors: CollectorItem[];
  revokingCollectorId?: string;
  onDelete: (collector: CollectorItem) => void;
  onRevoke: (collector: CollectorItem) => void;
}) {
  return (
    <DataTableShell dense fixedLayout minWidth={1200}>
      <colgroup>
        <col style={{ width: "15%" }} />
        <col style={{ width: "11%" }} />
        <col style={{ width: "11%" }} />
        <col style={{ width: "8%" }} />
        <col style={{ width: "6%" }} />
        <col style={{ width: "9%" }} />
        <col style={{ width: "12%" }} />
        <col style={{ width: "5%" }} />
        <col style={{ width: "5%" }} />
        <col style={{ width: "18%" }} />
      </colgroup>
      <TableHeader>
        <TableRow className="bg-background font-mono text-xs text-muted-foreground">
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">采集器</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">责任账号</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">设备</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">系统</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">版本</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">已注册智能体</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">最近心跳</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">状态</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium">Token</TableHead>
          <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 text-right font-medium">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {collectors.length === 0 ? (
          <TableStateRow colSpan={10}>暂无采集器</TableStateRow>
        ) : (
          collectors.map((collector) => {
            return (
              <TableRow className="hover:bg-foreground/[0.03]" key={collector.collector_id}>
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="grid gap-1">
                    <strong className="break-all font-mono text-sm">{collector.collector_id}</strong>
                    <span className="break-words text-xs text-muted-foreground">{collector.hostname}</span>
                  </div>
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="grid gap-1"><span className="break-words">{collector.user_name || "未归属"}</span><span className="break-all text-xs text-muted-foreground">{collector.user_email || collector.user_id || "-"}</span></div>
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="grid gap-1">
                    <span className="break-words">{collector.device_name}</span>
                    <span className="break-all font-mono text-xs text-muted-foreground">{collector.device_id}</span>
                  </div>
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3">{collector.os} / {collector.arch}</TableCell>
                <TableCell className="break-all border-b border-border px-3 py-3 font-mono text-xs">{collector.collector_version}</TableCell>
                <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{collector.registered_agent_count}</TableCell>
                <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{formatDateTime(collector.last_seen_at, "尚未上报")}</TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <CollectorStatusBadge status={collector.status} />
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3"><Badge variant={collector.token_status === "active" ? "success" : "danger"}>{collector.token_status === "active" ? "有效" : "已撤销"}</Badge></TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="flex justify-end gap-2">
                    <Button asChild size="sm" variant="secondary">
                      <Link to={`/admin/collectors/detail?collector_id=${encodeURIComponent(collector.collector_id)}`}>查看</Link>
                    </Button>
                    {canManage ? <Button
                      aria-label={`撤销 ${collector.collector_id} Token`}
                      disabled={collector.token_status !== "active" || revokingCollectorId === collector.collector_id}
                      onClick={() => onRevoke(collector)}
                      size="sm"
                      variant="outline"
                    >
                      <ShieldOff aria-hidden="true" data-icon="inline-start" />
                      撤销 Token
                    </Button> : null}
                    {canManage && collector.token_status === "revoked" ? (
                      <Button
                        aria-label={`删除 ${collector.collector_id}`}
                        onClick={() => onDelete(collector)}
                        size="icon"
                        variant="destructive"
                      >
                        <Trash2 aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </DataTableShell>
  );
}

function CollectorStatusBadge({ status }: { status: CollectorStatus }) {
  const labelMap: Record<CollectorStatus, string> = {
    online: "在线",
    offline: "离线",
    never: "从未上报",
    revoked: "已停用",
  };

  const variantMap: Record<CollectorStatus, "success" | "warning" | "muted" | "danger"> = {
    online: "success",
    offline: "warning",
    never: "muted",
    revoked: "danger",
  };

  return <Badge variant={variantMap[status]}>{labelMap[status]}</Badge>;
}

type RegistrationState = "missing" | "expired" | "valid";

function getRegistrationState(code: RegistrationCodeDetail | null, serverTime?: string): RegistrationState {
  if (!code?.registration_code) {
    return "missing";
  }

  const expiresAt = code.expires_at ? new Date(code.expires_at).getTime() : Number.POSITIVE_INFINITY;
  const now = serverTime ? new Date(serverTime).getTime() : Date.now();
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return "expired";
  }

  return "valid";
}

function registrationBadgeLabel(state: RegistrationState) {
  if (state === "valid") return "有效";
  if (state === "expired") return "已过期";
  return "暂无注册码";
}

function formatDateTime(value?: string, fallback = "-") {
  return formatBeijingDateTime(value, fallback);
}
