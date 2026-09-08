import { ExternalLink, Eye } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";

import {
  BooleanBadge,
  DataTableShell,
  DetailDrawer,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  JsonTabs,
  KeyValueList,
  LoadingState,
  MetricCard,
  ModalShell,
  PageHeader,
  PageShell,
  TableStateRow
} from "@/components/governance-ui";
import { CopyButton } from "@/components/copy-button";
import { useAdminPermission } from "@/components/admin-permissions";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  acceptMCPGate,
  getMCPGate,
  listMCPGates,
  rejectMCPGate,
  type MCPGate
} from "@/lib/mcp-admin-api";
import {
  canDecideMCPGate,
  formatDateTime,
  isMCPGateExpired,
  mcpGateStatusLabel,
  mcpGateStatusVariant,
  mcpGateTypeLabel,
  riskLevelLabel
} from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";
import { truncateText } from "@/lib/text";

type GateDialogState =
  | { kind: "accept"; gate: MCPGate }
  | { kind: "reject"; gate: MCPGate }
  | null;

const gatesQueryKey = ["mcp-gates"] as const;
const statusOptions = ["all", "pending", "accepted", "executing", "completed", "rejected", "expired", "failed", "cancelled"] as const;
const typeOptions = ["all", "user_confirmation", "admin_approval"] as const;
const riskOptions = ["all", "high", "medium", "low"] as const;
const decisionTerminalStatuses = new Set(["rejected", "expired", "failed", "cancelled"]);

export function MCPGatesPage() {
  const canManage = useAdminPermission(permissions.mcpGateManage);
  const [searchParams] = useSearchParams();
  const gateID = searchParams.get("gate_id") ?? undefined;
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [riskFilter, setRiskFilter] = useState("all");
  const [selectedGateId, setSelectedGateId] = useState<string | null>(gateID ?? null);
  const [dialog, setDialog] = useState<GateDialogState>(null);
  const [rejectReason, setRejectReason] = useState("");
  const submitInFlightRef = useRef(false);

  const gatesQuery = useQuery({
    queryKey: gatesQueryKey,
    queryFn: () => listMCPGates({ limit: 200 })
  });

  const gates = gatesQuery.data ?? [];
  const routeGateInList = Boolean(gateID && gates.some((gate) => gate.id === gateID));
  const routeGateQuery = useQuery({
    enabled: Boolean(gateID) && !gatesQuery.isLoading && !routeGateInList,
    queryKey: ["mcp-gate", gateID],
    queryFn: () => getMCPGate(gateID!)
  });
  const routeGate = routeGateQuery.data ?? null;
  const filteredGates = useMemo(
    () => filterGates(gates, { search, type: typeFilter, status: statusFilter, risk: riskFilter }),
    [gates, riskFilter, search, statusFilter, typeFilter]
  );
  const selectedGate =
    filteredGates.find((gate) => gate.id === selectedGateId) ??
    gates.find((gate) => gate.id === selectedGateId) ??
    (routeGate?.id === selectedGateId ? routeGate : null) ??
    null;
  const metrics = useMemo(() => deriveGateMetrics(gates), [gates]);
  const hasLoadError = gatesQuery.isError;
  const shouldLoadRouteGate = Boolean(gateID) && !routeGateInList;

  useEffect(() => {
    if (gateID) {
      setSelectedGateId(gateID);
    }
  }, [gateID]);

  const acceptMutation = useMutation({
    mutationFn: (gateId: string) => acceptMCPGate(gateId),
    onSuccess: async (updatedGate) => {
      queryClient.setQueryData(["mcp-gate", updatedGate.id], updatedGate);
      await queryClient.invalidateQueries({ queryKey: gatesQueryKey });
      setDialog(null);
      setRejectReason("");
    },
    onSettled: () => {
      submitInFlightRef.current = false;
    }
  });

  const rejectMutation = useMutation({
    mutationFn: ({ gateId, reason }: { gateId: string; reason: string }) => rejectMCPGate(gateId, reason),
    onSuccess: async (updatedGate) => {
      queryClient.setQueryData(["mcp-gate", updatedGate.id], updatedGate);
      await queryClient.invalidateQueries({ queryKey: gatesQueryKey });
      setDialog(null);
      setRejectReason("");
    },
    onSettled: () => {
      submitInFlightRef.current = false;
    }
  });

  function openAcceptFromRow(event: MouseEvent, gate: MCPGate) {
    event.stopPropagation();
    openAccept(gate);
  }

  function openRejectFromRow(event: MouseEvent, gate: MCPGate) {
    event.stopPropagation();
    openReject(gate);
  }

  function openAccept(gate: MCPGate) {
    setDialog({ kind: "accept", gate });
  }

  function openReject(gate: MCPGate) {
    setRejectReason("");
    setDialog({ kind: "reject", gate });
  }

  function closeDialog() {
    if (acceptMutation.isPending || rejectMutation.isPending) return;
    setDialog(null);
    setRejectReason("");
  }

  function submitDialog() {
    if (!dialog) return;
    if (submitInFlightRef.current || acceptMutation.isPending || rejectMutation.isPending) return;
    submitInFlightRef.current = true;
    if (dialog.kind === "accept") {
      acceptMutation.mutate(dialog.gate.id);
      return;
    }
    rejectMutation.mutate({ gateId: dialog.gate.id, reason: rejectReason });
  }

  return (
    <PageShell>
      <PageHeader title="门禁队列">
        统一处理用户确认与管理员审批门禁。页面只提交通过或拒绝决策；执行仍由 Gateway 使用
        mcp_gate_requests 中冻结的参数快照完成。
      </PageHeader>

      {hasLoadError ? (
        <ErrorAlert>MCP 门禁加载失败：无法加载门禁队列。</ErrorAlert>
      ) : null}
      {shouldLoadRouteGate && routeGateQuery.isLoading ? (
        <Alert variant="muted">
          门禁详情加载中...
        </Alert>
      ) : null}
      {shouldLoadRouteGate && routeGateQuery.isError ? (
        <ErrorAlert>门禁详情加载失败：无法加载 {gateID}。</ErrorAlert>
      ) : null}

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <MetricCard foot="待处理且未过期的用户确认" label="用户确认待处理" value={gatesQuery.isLoading ? "..." : metrics.userPending} />
        <MetricCard foot="待处理且未过期的管理员审批" label="管理员审批待处理" value={gatesQuery.isLoading ? "..." : metrics.approvalPending} />
        <MetricCard foot="执行中或已完成" label="已恢复执行" value={gatesQuery.isLoading ? "..." : metrics.resumed} />
        <MetricCard foot="已拒绝、已过期、失败或已取消" label="终态异常" value={gatesQuery.isLoading ? "..." : metrics.terminal} />
      </section>

      <Card>
        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>门禁请求</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              列表同时展示用户确认与管理员审批；待处理且未过期的门禁可直接通过或拒绝。
            </p>
          </div>
          <Badge variant="muted">{filteredGates.length} 条可见</Badge>
        </CardHeader>
        <CardContent>
          <FilterRow>
            <FilterSearchField
              aria-label="搜索门禁"
              containerClassName="sm:w-96"
              placeholder="搜索 gate_id / 工具 / 操作者 / 智能体 / 追踪"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <FilterSelect ariaLabel="筛选门禁类型" value={typeFilter} onChange={setTypeFilter}>
              {typeOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "全部门禁类型" : mcpGateTypeLabel(option)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect ariaLabel="筛选门禁状态" value={statusFilter} onChange={setStatusFilter}>
              {statusOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "全部状态" : mcpGateStatusLabel(option)}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect ariaLabel="筛选风险等级" value={riskFilter} onChange={setRiskFilter}>
              {riskOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "全部风险" : riskLevelLabel(option)}
                </option>
              ))}
            </FilterSelect>
          </FilterRow>

          <DataTableShell dense minWidth={1840}>
            <TableHeader>
              <TableRow className="bg-background font-mono text-xs text-muted-foreground hover:bg-background">
                {["ID", "类型", "状态", "工具", "动作", "操作者", "智能体", "风险", "裁决结果", "过期时间", "参数哈希", "操作"].map(
                  (heading) => (
                    <TableHead className="border-b border-border px-3 py-3 font-medium" key={heading}>
                      {heading}
                    </TableHead>
                  )
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {gatesQuery.isLoading ? (
                <TableStateRow colSpan={12}>
                  <LoadingState label="正在加载 MCP 门禁" />
                </TableStateRow>
              ) : null}
              {!gatesQuery.isLoading && hasLoadError ? (
                <TableStateRow colSpan={12} tone="danger">
                  <ErrorAlert>MCP 门禁加载失败</ErrorAlert>
                </TableStateRow>
              ) : null}
              {!gatesQuery.isLoading && !hasLoadError && filteredGates.length === 0 ? (
                <TableStateRow colSpan={12}>
                  <EmptyState title="暂无匹配的门禁。" />
                </TableStateRow>
              ) : null}
              {!gatesQuery.isLoading && !hasLoadError
                ? filteredGates.map((gate) => (
                    <TableRow key={gate.id}>
                      <TableCell className="border-b border-border px-3 py-3">
                        <div className="grid gap-2">
                          <strong className="block font-mono text-xs">{gate.id}</strong>
                          <div className="flex flex-wrap gap-1">
                            <CopyButton label="复制URL" stopPropagation value={gateDetailURL(gate)} size="sm" variant="secondary" />
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <div className="grid gap-1">
                          <Badge variant={gate.type === "admin_approval" ? "accent" : "warning"}>{mcpGateTypeLabel(gate.type)}</Badge>
                          <div className="font-mono text-xs text-muted-foreground">{displayValue(gate.provider)}</div>
                        </div>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <div className="grid gap-1">
                          <Badge variant={mcpGateStatusVariant(gate.status)}>{mcpGateStatusLabel(gate.status)}</Badge>
                          {gate.status === "pending" && isMCPGateExpired(gate.expiresAt) ? (
                            <div className="font-mono text-xs text-muted-foreground">已过期</div>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <div className="grid gap-1">
                          <span className="block font-mono text-xs">{displayValue(gate.exposedName)}</span>
                          <span className="block font-mono text-xs text-muted-foreground">
                            {displayValue(gate.upstreamServerId)} -&gt; {displayValue(gate.upstreamName)}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">{displayValue(gate.gateSummary.action)}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{displayValue(gate.actorId)}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{displayValue(gate.agentId)}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <Badge variant={gate.gateSummary.riskLevel === "high" ? "danger" : gate.gateSummary.riskLevel === "medium" ? "warning" : "muted"}>
                          {riskLevelLabel(gate.gateSummary.riskLevel)}
                        </Badge>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{displayValue(gate.decidedBy)}</TableCell>
                      <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">{formatDateTime(gate.expiresAt)}</TableCell>
                      <TableCell className="max-w-[180px] border-b border-border px-3 py-3 font-mono text-xs">
                        <span className="block truncate" title={gate.argumentsHash}>
                          {shortHash(gate.argumentsHash)}
                        </span>
                      </TableCell>
                      <TableCell className="border-b border-border px-3 py-3">
                        <div className="flex items-center gap-2 whitespace-nowrap">
                          <Button
                            aria-label={`查看 ${gate.id} 详情`}
                            onClick={() => setSelectedGateId(gate.id)}
                            size="sm"
                            variant="secondary"
                          >
                            <Eye aria-hidden="true" />
                            详情
                          </Button>
                          <GateDecisionActions
                            canManage={canManage}
                            gate={gate}
                            onAccept={(event) => openAcceptFromRow(event, gate)}
                            onReject={(event) => openRejectFromRow(event, gate)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                : null}
            </TableBody>
          </DataTableShell>
        </CardContent>
      </Card>

      <GateDrawer
        canManage={canManage}
        gate={selectedGate}
        onAccept={openAccept}
        onClose={() => setSelectedGateId(null)}
        onReject={openReject}
      />

      <GateDecisionDialog
        acceptPending={acceptMutation.isPending}
        dialog={dialog}
        onClose={closeDialog}
        onRejectReasonChange={setRejectReason}
        onSubmit={submitDialog}
        rejectPending={rejectMutation.isPending}
        rejectReason={rejectReason}
      />
    </PageShell>
  );
}

function GateDrawer({
  canManage,
  gate,
  onAccept,
  onClose,
  onReject
}: {
  canManage: boolean;
  gate: MCPGate | null;
  onAccept: (gate: MCPGate) => void;
  onClose: () => void;
  onReject: (gate: MCPGate) => void;
}) {
  const auditHref = gate
    ? gate.executionAuditId
      ? `/admin/mcp/audits?audit_id=${encodeURIComponent(gate.executionAuditId)}`
      : `/admin/mcp/audits?trace_id=${encodeURIComponent(gate.traceId)}`
    : "/admin/mcp/audits";

  return (
    <DetailDrawer
      contextLabel={gate ? mcpGateTypeLabel(gate.type) : "门禁详情"}
      onClose={onClose}
      open={Boolean(gate)}
      subtitle={gate ? `${mcpGateStatusLabel(gate.status)} · ${gate.exposedName || "-"}` : ""}
      title={gate?.id || ""}
    >
      {gate ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>业务摘要</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <KeyValueList
                items={[
                  { label: "gate_type", value: gate.type },
                  { label: "status", value: gate.status || "-" },
                  { label: "risk_level", value: gate.gateSummary.riskLevel || "-" },
                  { label: "destructive", value: formatBool(gate.gateSummary.destructive) },
                  { label: "read_only", value: formatBool(gate.gateSummary.readOnly) },
                  { label: "system", value: gate.gateSummary.system || "-" },
                  { label: "action", value: gate.gateSummary.action || "-" },
                  { label: "object", value: gate.gateSummary.object || "-" },
                  { label: "tool", value: gate.gateSummary.tool || gate.exposedName || "-" },
                  { label: "actor_id", value: gate.actorId || "-" },
                  { label: "decided_by", value: gate.decidedBy || "-" }
                ]}
              />
              {gate.gateSummary.risks.length > 0 ? (
                <div className="grid gap-2">
                  <div className="font-mono text-xs text-muted-foreground">risks</div>
                  <ul className="grid gap-2 text-sm text-muted-foreground">
                    {gate.gateSummary.risks.map((risk) => (
                      <li key={risk}>
                        <Alert variant="warning">
                          {risk}
                        </Alert>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>参数快照</CardTitle>
            </CardHeader>
            <CardContent>
              {gate.gateSummary.parameters.length > 0 ? (
                <DataTableShell minWidth={560}>
                  <TableHeader className="bg-background font-mono text-xs text-muted-foreground">
                    <TableRow className="hover:bg-background">
                      {["label", "path", "value", "sensitive"].map((heading) => (
                        <TableHead className="border-b border-border px-3 py-2 font-medium" key={heading}>
                          {heading}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {gate.gateSummary.parameters.map((parameter) => (
                      <TableRow key={`${parameter.path}-${parameter.label}`}>
                        <TableCell className="border-b border-border px-3 py-2">{parameter.label || "-"}</TableCell>
                        <TableCell className="border-b border-border px-3 py-2 font-mono text-xs">{parameter.path || "-"}</TableCell>
                        <TableCell className="border-b border-border px-3 py-2 font-mono text-xs">{parameter.value || "-"}</TableCell>
                        <TableCell className="border-b border-border px-3 py-2">
                          <BooleanBadge trueVariant="warning" value={parameter.sensitive} />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </DataTableShell>
              ) : (
                <EmptyState title="暂无参数摘要。" />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>追踪与外部提供方</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <KeyValueList
                items={[
                  { label: "gate_id", value: gate.id },
                  { label: "gate_type", value: gate.type },
                  { label: "gate_provider", value: gate.provider || "-" },
                  { label: "trace_id", value: gate.traceId || "-" },
                  { label: "tenant_id", value: gate.tenantId || "-" },
                  { label: "capability_id", value: gate.capabilityId || "-" },
                  { label: "arguments_hash", value: gate.argumentsHash || "-" },
                  { label: "schema_hash", value: gate.schemaHash || "-" },
                  { label: "confirm_url", value: gate.confirmUrl || "-" },
                  { label: "copy_url", value: gateDetailURL(gate) },
                  { label: "external_instance_id", value: gate.externalInstanceId || "-" },
                  { label: "external_url", value: gate.externalUrl || "-" }
                ]}
              />
              <div className="flex flex-wrap gap-2">
                <CopyButton label="复制链接" value={gateDetailURL(gate)} variant="secondary" />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-start justify-between">
              <div>
                <CardTitle>执行区</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  只读展示冻结参数、执行结果和错误信息；页面不会提交新的工具参数。
                </p>
              </div>
              <Button asChild variant="outline">
                <Link to={auditHref}>
                  跳转审计
                  <ExternalLink aria-hidden="true" />
                </Link>
              </Button>
            </CardHeader>
            <CardContent>
              <div className="[&_pre]:max-h-[360px]">
                <JsonTabs
                  tabs={[
                    { id: "arguments", label: "原始参数", value: gate.requestBody ?? {} },
                    { id: "response", label: "执行结果", value: gate.responseBody ?? { status: gate.status, response_body: null } },
                    {
                      id: "error",
                      label: "错误信息",
                      value: {
                        error: gate.error,
                        decision_reason: gate.decisionReason,
                        decided_by: gate.decidedBy,
                        execution_audit_id: gate.executionAuditId
                      }
                    }
                  ]}
                />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>操作区</CardTitle>
            </CardHeader>
            <CardContent>
              <DrawerOperationState auditHref={auditHref} canManage={canManage} gate={gate} onAccept={onAccept} onReject={onReject} />
            </CardContent>
          </Card>
        </>
      ) : null}
    </DetailDrawer>
  );
}

function DrawerOperationState({
  auditHref,
  canManage,
  gate,
  onAccept,
  onReject
}: {
  auditHref: string;
  canManage: boolean;
  gate: MCPGate;
  onAccept: (gate: MCPGate) => void;
  onReject: (gate: MCPGate) => void;
}) {
  if (canManage && canDecideMCPGate(gate.status, gate.expiresAt)) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onAccept(gate)} size="sm" variant="primary">
          通过
        </Button>
        <Button onClick={() => onReject(gate)} size="sm" variant="destructive">
          拒绝
        </Button>
      </div>
    );
  }

  if (gate.status === "pending" && isMCPGateExpired(gate.expiresAt)) {
    return <p className="text-sm text-muted-foreground">该门禁已过期，不能继续操作。</p>;
  }

  if (gate.status === "accepted" || gate.status === "executing") {
    return <p className="text-sm text-muted-foreground">Gateway 正在使用冻结参数快照恢复执行。</p>;
  }

  if (gate.status === "completed") {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-foreground">已完成执行。</p>
        <Button asChild variant="outline">
          <Link to={auditHref}>查看执行审计</Link>
        </Button>
      </div>
    );
  }

  return <p className="text-sm text-muted-foreground">{gate.decisionReason || gate.error || "该门禁不允许继续操作。"}</p>;
}

function GateDecisionActions({
  canManage,
  gate,
  onAccept,
  onReject
}: {
  canManage: boolean;
  gate: MCPGate;
  onAccept: (event: MouseEvent) => void;
  onReject: (event: MouseEvent) => void;
}) {
  if (!canManage) return null;

  if (!canDecideMCPGate(gate.status, gate.expiresAt)) {
    return (
      <Button disabled size="sm" variant="secondary">
        不可操作
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <Button onClick={onAccept} size="sm" variant="primary">
        通过
      </Button>
      <Button onClick={onReject} size="sm" variant="destructive">
        拒绝
      </Button>
    </div>
  );
}

function GateDecisionDialog({
  acceptPending,
  dialog,
  onClose,
  onRejectReasonChange,
  onSubmit,
  rejectPending,
  rejectReason
}: {
  acceptPending: boolean;
  dialog: GateDialogState;
  onClose: () => void;
  onRejectReasonChange: (value: string) => void;
  onSubmit: () => void;
  rejectPending: boolean;
  rejectReason: string;
}) {
  const gate = dialog?.gate;
  const isAccept = dialog?.kind === "accept";
  const pending = acceptPending || rejectPending;

  return (
    <ModalShell
      contextLabel={gate ? mcpGateTypeLabel(gate.type) : undefined}
      onClose={onClose}
      open={Boolean(dialog)}
      subtitle={gate ? decisionCopy(gate, isAccept) : undefined}
      title={isAccept ? "通过 MCP 调用" : "拒绝 MCP 调用"}
    >
      {gate ? (
        <div className="grid gap-4">
          <KeyValueList
            items={[
              { label: "gate_id", value: gate.id },
              { label: "tool", value: gate.exposedName || gate.gateSummary.tool || "-" },
              { label: "action", value: gate.gateSummary.action || "-" },
              { label: "arguments_hash", value: gate.argumentsHash || "-" }
            ]}
          />
          {!isAccept ? (
            <label className="grid gap-2 text-sm">
              <span className="font-mono text-xs text-muted-foreground">reason</span>
              <Textarea
                className="min-h-24"
                onChange={(event) => onRejectReasonChange(event.target.value)}
                placeholder="例如：参数不正确，需让 Agent 重新发起。"
                value={rejectReason}
              />
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} onClick={onClose} size="sm" variant="secondary">
              取消
            </Button>
            <Button
              disabled={pending}
              onClick={onSubmit}
              size="sm"
              variant={isAccept ? "primary" : "destructive"}
            >
              {pending ? "提交中..." : isAccept ? "通过" : "拒绝"}
            </Button>
          </div>
        </div>
      ) : null}
    </ModalShell>
  );
}

function filterGates(gates: MCPGate[], filters: { search: string; type: string; status: string; risk: string }) {
  const query = filters.search.trim().toLowerCase();

  return gates.filter((gate) => {
    return (
      (!query || gateSearchText(gate).includes(query)) &&
      (filters.type === "all" || gate.type === filters.type) &&
      (filters.status === "all" || gate.status === filters.status) &&
      (filters.risk === "all" || gate.gateSummary.riskLevel === filters.risk)
    );
  });
}

function deriveGateMetrics(gates: MCPGate[]) {
  return {
    userPending: gates.filter((gate) => gate.type === "user_confirmation" && canDecideMCPGate(gate.status, gate.expiresAt)).length,
    approvalPending: gates.filter((gate) => gate.type === "admin_approval" && canDecideMCPGate(gate.status, gate.expiresAt)).length,
    resumed: gates.filter((gate) => gate.status === "completed" || gate.status === "executing").length,
    terminal: gates.filter((gate) => decisionTerminalStatuses.has(gate.status)).length
  };
}

function gateSearchText(gate: MCPGate) {
  return [
    gate.id,
    gate.type,
    gate.status,
    gate.exposedName,
    gate.upstreamName,
    gate.upstreamServerId,
    gate.actorId,
    gate.agentId,
    gate.traceId,
    gate.argumentsHash,
    gate.gateSummary.system,
    gate.gateSummary.action,
    gate.gateSummary.object
  ]
    .join(" ")
    .toLowerCase();
}

function displayValue(value: string | null | undefined) {
  return value && value.trim() ? value : "-";
}

function shortHash(hash: string) {
  return truncateText(hash, 18);
}

function gateDetailURL(gate: MCPGate) {
  return `${window.location.origin}/admin/mcp/gates/${encodeURIComponent(gate.id)}`;
}

function decisionCopy(gate: MCPGate, isAccept: boolean) {
  if (!isAccept) {
    return "拒绝后 Gateway 不调用上游；原因可为空，但会随门禁决策保存。";
  }
  if (gate.type === "admin_approval") {
    return "通过后 Gateway 将使用已冻结的参数快照执行，上游业务系统仍只能由 Gateway 调用。";
  }
  return "通过后 Gateway 将使用已冻结的参数快照执行，不会使用 Agent 后续提交的参数。";
}

function formatBool(value?: boolean) {
  if (value === undefined) return "-";
  return value ? "true" : "false";
}
