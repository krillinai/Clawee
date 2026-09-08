import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Ban, TerminalSquare, Trash2 } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";

import { CopyButton } from "@/components/copy-button";
import { ConfirmDialog, DataTableShell, EmptyState, ErrorAlert, KeyValueList, LoadingState, PageHeader, PageShell, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatBeijingDateTime } from "@/lib/datetime";
import { mcpStatusLabel } from "@/lib/mcp-admin-ui";
import {
  createMyCollectorRegistrationCode,
  deleteMyCollector,
  fetchMyCollectorRegistrationCode,
  getMyCollector,
  listMyCollectors,
  revokeMyCollectorToken,
  type CollectorItem,
  type RegistrationCodeDetail,
} from "@/lib/office-api";

export function AppCollectorsPage() {
  const [searchParams] = useSearchParams();
  const collectorId = searchParams.get("collector_id") ?? "";
  return collectorId ? <CollectorDetail collectorId={collectorId} /> : <CollectorList />;
}

function CollectorList() {
  const queryClient = useQueryClient();
  const [deleteTarget, setDeleteTarget] = useState<CollectorItem | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<CollectorItem | null>(null);
  const query = useQuery({ queryKey: ["app-collectors"], queryFn: listMyCollectors });
  const registrationQuery = useQuery({
    queryKey: ["app-collector-registration-code"],
    queryFn: fetchMyCollectorRegistrationCode,
  });
  const createRegistration = useMutation({
    mutationFn: createMyCollectorRegistrationCode,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["app-collector-registration-code"] });
    },
  });
  const deleteCollector = useMutation({
    mutationFn: (collectorId: string) => deleteMyCollector(collectorId),
    onSuccess: async () => {
      setDeleteTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["app-collectors"] });
    },
  });
  const revokeCollector = useMutation({
    mutationFn: (collectorId: string) => revokeMyCollectorToken(collectorId),
    onSuccess: async () => {
      setRevokeTarget(null);
      await queryClient.invalidateQueries({ queryKey: ["app-collectors"] });
    },
  });
  const items = query.data ?? [];
  return (
    <PageShell>
      <PageHeader title="我的 Collector" />
      <CollectorRegistrationPanel
        createError={createRegistration.isError}
        loadError={registrationQuery.isError}
        loading={registrationQuery.isLoading}
        pending={createRegistration.isPending}
        registration={registrationQuery.data ?? null}
        onGenerate={() => createRegistration.mutate()}
      />
      <DataTableShell dense minWidth={1040}>
        <TableHeader><TableRow><TableHead>设备</TableHead><TableHead>设备 ID</TableHead><TableHead>系统</TableHead><TableHead>版本</TableHead><TableHead>Agent</TableHead><TableHead>最近心跳时间</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {query.isLoading ? <TableStateRow colSpan={8}><LoadingState label="正在加载 Collector" /></TableStateRow> : null}
          {query.isError ? <TableStateRow colSpan={8} tone="danger"><ErrorAlert>Collector 加载失败</ErrorAlert></TableStateRow> : null}
          {!query.isLoading && !query.isError && items.length === 0 ? <TableStateRow colSpan={8}><EmptyState title="暂无 Collector" description="生成注册码并完成安装后，设备会出现在这里。" /></TableStateRow> : null}
          {items.map((item) => (
            <TableRow key={item.collector_id}>
              <TableCell><div className="font-medium">{item.device_name || item.hostname || item.collector_id}</div><div className="font-mono text-xs text-muted-foreground">{item.collector_id}</div></TableCell>
              <TableCell className="font-mono text-xs">{item.device_id || "-"}</TableCell>
              <TableCell>{item.os} / {item.arch}</TableCell>
              <TableCell className="font-mono text-xs">{item.collector_version || "-"}</TableCell>
              <TableCell>{item.registered_agent_count}</TableCell>
              <TableCell className="font-mono text-xs">{formatBeijingDateTime(item.last_seen_at, "尚未上报")}</TableCell>
              <TableCell><Badge variant={item.status === "online" ? "success" : item.status === "revoked" ? "danger" : "muted"}>{mcpStatusLabel(item.status)}</Badge></TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button asChild size="sm" variant="secondary"><Link to={`/app/collectors/detail?collector_id=${encodeURIComponent(item.collector_id)}`}>查看</Link></Button>
                  {item.status === "offline" && item.token_status === "active" ? (
                    <Button
                      aria-label={`撤销 ${item.collector_id} Token`}
                      disabled={revokeCollector.isPending}
                      onClick={() => {
                        revokeCollector.reset();
                        setRevokeTarget(item);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <Ban aria-hidden="true" data-icon="inline-start" />
                      撤销 Token
                    </Button>
                  ) : null}
                  {item.token_status === "revoked" ? (
                    <Button
                      aria-label={`删除 ${item.collector_id}`}
                      onClick={() => {
                        deleteCollector.reset();
                        setDeleteTarget(item);
                      }}
                      size="icon"
                      variant="destructive"
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTableShell>
      <ConfirmDialog
        confirmLabel={revokeCollector.isPending ? "撤销中..." : "确认撤销"}
        description={revokeTarget ? `撤销后，采集器 ${revokeTarget.collector_id} 将无法继续上报；如需再次使用，需要重新注册。` : ""}
        error={revokeCollector.isError ? `撤销失败：${revokeCollector.error.message}` : undefined}
        onClose={() => {
          if (!revokeCollector.isPending) setRevokeTarget(null);
        }}
        onConfirm={() => revokeTarget && revokeCollector.mutate(revokeTarget.collector_id)}
        open={Boolean(revokeTarget)}
        pending={revokeCollector.isPending}
        title="撤销采集器 Token"
        variant="destructive"
      />
      <ConfirmDialog
        confirmLabel={deleteCollector.isPending ? "删除中..." : "确认删除"}
        description={deleteTarget ? `删除后，采集器 ${deleteTarget.collector_id} 及其采集状态将无法恢复。` : ""}
        error={deleteCollector.isError ? `删除失败：${deleteCollector.error.message}` : undefined}
        onClose={() => {
          if (!deleteCollector.isPending) setDeleteTarget(null);
        }}
        onConfirm={() => deleteTarget && deleteCollector.mutate(deleteTarget.collector_id)}
        open={Boolean(deleteTarget)}
        pending={deleteCollector.isPending}
        title="删除采集器"
        variant="destructive"
      />
    </PageShell>
  );
}

function CollectorRegistrationPanel({
  createError,
  loadError,
  loading,
  pending,
  registration,
  onGenerate,
}: {
  createError: boolean;
  loadError: boolean;
  loading: boolean;
  pending: boolean;
  registration: RegistrationCodeDetail | null;
  onGenerate: () => void;
}) {
  const expired = Boolean(registration?.expires_at && new Date(registration.expires_at).getTime() <= Date.now());
  const valid = Boolean(registration?.exists && registration.registration_code && !expired);
  const activeRegistration = valid ? registration : null;
  const status = valid ? "有效" : expired ? "已过期" : "暂无注册码";

  return (
    <Card className="min-w-0 shadow-none">
      <CardHeader className="gap-3">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <CardTitle>采集器注册码</CardTitle>
          <Badge variant={valid ? "success" : expired ? "warning" : "muted"}>{status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        {createError ? <ErrorAlert>生成采集器注册码失败，请稍后重试。</ErrorAlert> : null}
        {loadError ? <ErrorAlert>加载采集器注册码失败，请稍后重试。</ErrorAlert> : null}

        {!activeRegistration ? (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4 md:flex-row md:items-center md:justify-between">
            <span className="text-sm text-muted-foreground">
              {loading ? "正在加载注册码" : expired ? "注册码已过期，请重新生成。" : "暂无注册码"}
            </span>
            <Button disabled={pending || loading} onClick={onGenerate} size="sm">
              <TerminalSquare aria-hidden="true" data-icon="inline-start" />
              {pending ? "生成中" : registration?.exists ? "重新生成" : "生成注册码"}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex justify-end">
              <Button disabled={pending} onClick={onGenerate} size="sm">
                <TerminalSquare aria-hidden="true" data-icon="inline-start" />
                {pending ? "生成中" : "重新生成"}
              </Button>
            </div>
            {activeRegistration.registration_code ? <RegistrationValue label="注册码" value={activeRegistration.registration_code} /> : null}
            {activeRegistration.install_command ? <RegistrationValue label="Shell 一键安装命令" value={activeRegistration.install_command} /> : null}
            {activeRegistration.install_powershell_command ? <RegistrationValue label="PowerShell 安装命令" value={activeRegistration.install_powershell_command} /> : null}
            {activeRegistration.install_url ? <RegistrationValue label="安装 URL" value={activeRegistration.install_url} /> : null}
            <KeyValueList
              items={[
                { label: "创建时间", value: formatBeijingDateTime(activeRegistration.created_at) },
                { label: "过期时间", value: formatBeijingDateTime(activeRegistration.expires_at, "永久有效") },
                { label: "最近使用", value: formatBeijingDateTime(activeRegistration.last_used_at, "尚未使用") },
                { label: "使用次数", value: String(activeRegistration.used_count) },
              ]}
              labelWidth={96}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RegistrationValue({ label, value }: { label: string; value: string }) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-background p-4">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex min-w-0 flex-col gap-3 md:flex-row md:items-start">
        <code className="min-w-0 flex-1 break-all text-sm">{value}</code>
        <CopyButton size="sm" value={value} variant="outline" />
      </div>
    </section>
  );
}

function CollectorDetail({ collectorId }: { collectorId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["app-collector", collectorId], queryFn: () => getMyCollector(collectorId) });
  const revoke = useMutation({
    mutationFn: () => revokeMyCollectorToken(collectorId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["app-collector", collectorId] });
      void queryClient.invalidateQueries({ queryKey: ["app-collectors"] });
    }
  });
  if (query.isLoading) return <PageShell><LoadingState label="正在加载 Collector" /></PageShell>;
  if (query.isError || !query.data) return <PageShell><ErrorAlert>Collector 不存在或无权访问</ErrorAlert></PageShell>;
  const item = query.data;
  return (
    <PageShell>
      <Button asChild className="self-start" size="sm" variant="ghost"><Link to="/app/collectors"><ArrowLeft aria-hidden="true" />返回</Link></Button>
      <PageHeader title={item.device_name || item.hostname || item.collector_id} actions={item.token_status === "active" ? <Button disabled={revoke.isPending} onClick={() => revoke.mutate()} variant="destructive"><Ban aria-hidden="true" />撤销 Token</Button> : undefined} />
      {revoke.isError ? <ErrorAlert>Token 撤销失败</ErrorAlert> : null}
      <dl className="grid gap-px overflow-hidden rounded-md border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
        {[["collector_id", item.collector_id], ["设备", item.device_name || item.hostname || "-"], ["系统", `${item.os} / ${item.arch}`], ["版本", item.collector_version || "-"], ["Agent 数", String(item.registered_agent_count)], ["Token", item.token_status]].map(([label, value]) => <div className="bg-card p-4" key={label}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all font-mono text-sm">{value}</dd></div>)}
      </dl>
    </PageShell>
  );
}
