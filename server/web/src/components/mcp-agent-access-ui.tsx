import { Eye, KeyRound, Pencil, RotateCw, Trash2 } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useMemo, useState } from "react";

import {
  CodeBox,
  DataTableShell,
  DetailDrawer,
  EmptyState,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  KeyValueList,
  ResourceList,
  TableStateRow
} from "@/components/governance-ui";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { MCPAccountTokenInfo, MCPAccountTokenResponse, MCPAgent, MCPGrant, MCPCapability, MCPUpstreamServer } from "@/lib/mcp-admin-api";
import { agentCreationSourceLabel } from "@/lib/agent-source";
import { formatDateTime, mcpStatusLabel, mcpStatusVariant } from "@/lib/mcp-admin-ui";

export type AgentTableMode = "admin" | "user";

export function MCPAgentTokenTable({
  agents,
  isLoading,
  mode,
  onOpenToken,
  onOpenGrants,
  onEdit,
  onDelete,
  tokenActionLabel,
  onAddGrant
}: {
  agents: MCPAgent[];
  isLoading: boolean;
  mode: AgentTableMode;
  onOpenToken: (agent: MCPAgent) => void;
  onOpenGrants: (agent: MCPAgent) => void;
  onEdit?: (agent: MCPAgent) => void;
  onDelete?: (agent: MCPAgent) => void;
  tokenActionLabel: "查看详情" | "令牌详情";
  onAddGrant?: (agent: MCPAgent) => void;
}) {
  function openGrantsFromButton(event: MouseEvent<HTMLButtonElement>, agent: MCPAgent) {
    event.stopPropagation();
    onOpenGrants(agent);
  }

  function openAddGrantFromButton(event: MouseEvent<HTMLButtonElement>, agent: MCPAgent) {
    event.stopPropagation();
    onAddGrant?.(agent);
  }

  return (
    <DataTableShell dense fixedLayout minWidth={mode === "admin" ? 1200 : 1120}>
      <colgroup>
        <col style={{ width: "20%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: mode === "admin" ? "8%" : "14%" }} />
        <col style={{ width: "18%" }} />
        <col style={{ width: "8%" }} />
        <col style={{ width: mode === "admin" ? "12%" : "9%" }} />
        <col style={{ width: mode === "admin" ? "14%" : "11%" }} />
      </colgroup>
      <TableHeader>
        <TableRow className="bg-background font-mono text-xs text-muted-foreground">
          {["智能体 ID", "账号绑定", "名称", "创建来源", "状态", "更新时间", "操作"].map((heading) => (
            <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium" key={heading}>{heading}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? <TableStateRow colSpan={7}>...</TableStateRow> : null}
        {!isLoading && agents.length === 0 ? <TableStateRow colSpan={7}>暂无匹配的智能体。</TableStateRow> : null}
        {!isLoading
          ? agents.map((agent) => (
              <TableRow key={agent.agentId}>
                <TableCell className="break-all border-b border-border px-3 py-3 font-mono text-xs leading-5">{agent.agentId}</TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="grid gap-1">
                    <strong className="break-words text-sm font-semibold">{agent.boundUserName || "-"}</strong>
                    <span className="break-words font-mono text-xs text-muted-foreground">{agent.boundUserEmail || "-"}</span>
                  </div>
                </TableCell>
                <TableCell className="break-words border-b border-border px-3 py-3">{agent.name || "-"}</TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <div className="grid gap-1">
                    <Badge className="w-fit whitespace-nowrap" variant="outline">{agentCreationSourceLabel(agent.creationSource)}</Badge>
                    {agent.collector ? (
                      <>
                        <span className="break-all font-mono text-xs text-muted-foreground">{agent.collector.collectorId}</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                          <CollectorStatusBadge status={agent.collector.status} />
                          {agent.collector.lastSeenAt ? (
                            <span className="whitespace-nowrap text-xs text-muted-foreground">心跳 {formatDateTime(agent.collector.lastSeenAt)}</span>
                          ) : null}
                        </div>
                      </>
                    ) : agent.creationSource === "collector" ? (
                      <span className="text-xs text-muted-foreground">采集器关联缺失</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <Badge variant={mcpStatusVariant(agent.status)}>{mcpStatusLabel(agent.status)}</Badge>
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3 font-mono text-xs">
                  <StackedDateTime value={agent.updatedAt} />
                </TableCell>
                <TableCell className="border-b border-border px-3 py-3">
                  <TooltipProvider>
                    <div className="flex flex-wrap items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            aria-label={`查看 ${agent.name || agent.agentId} ${tokenActionLabel === "查看详情" ? "详情" : tokenActionLabel}`}
                            onClick={() => onOpenToken(agent)}
                            size="icon"
                            variant="secondary"
                          >
                            <Eye aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{tokenActionLabel}</TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button aria-label="查看授权" onClick={(event) => openGrantsFromButton(event, agent)} size="icon" variant="secondary">
                            <KeyRound aria-hidden="true" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>查看授权</TooltipContent>
                      </Tooltip>
                      {onEdit ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button aria-label={`编辑 ${agent.agentId} 名称`} onClick={() => onEdit(agent)} size="icon" variant="secondary">
                              <Pencil aria-hidden="true" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>编辑名称</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {onDelete ? (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button aria-label={`删除 ${agent.agentId}`} onClick={() => onDelete(agent)} size="icon" variant="destructive">
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>删除智能体</TooltipContent>
                        </Tooltip>
                      ) : null}
                      {mode === "admin" && onAddGrant ? (
                        <Button onClick={(event) => openAddGrantFromButton(event, agent)} size="sm" variant="primary">
                          添加授权
                        </Button>
                      ) : null}
                    </div>
                  </TooltipProvider>
                </TableCell>
              </TableRow>
            ))
          : null}
      </TableBody>
    </DataTableShell>
  );
}

function StackedDateTime({ value }: { value?: string | null }) {
  const [date, time] = formatDateTime(value).split(" ");

  return (
    <span className="grid gap-0.5 whitespace-nowrap leading-4">
      <span>{date}</span>
      {time ? <span>{time}</span> : null}
    </span>
  );
}

export function CollectorStatusBadge({ status }: { status?: string }) {
  switch (status) {
    case "online":
      return <Badge variant="success">在线</Badge>;
    case "offline":
      return <Badge variant="warning">离线</Badge>;
    case "never":
      return <Badge variant="muted">从未上报</Badge>;
    case "revoked":
      return <Badge variant="danger">已停用</Badge>;
    default:
      return <Badge variant="muted">状态未知</Badge>;
  }
}

export function MCPAgentTokenDrawer({
  agent,
  canManage,
  mode,
  open,
  tokenResult,
  tokenInfo,
  tokenError,
  tokenPending,
  onClose,
  onRevealToken,
  onRotateToken,
  onRevokeToken
}: {
  agent: MCPAgent | null;
  canManage?: boolean;
  open: boolean;
  mode: AgentTableMode;
  tokenResult: MCPAccountTokenResponse | null;
  tokenInfo: MCPAccountTokenInfo | null;
  tokenError?: string | null;
  tokenPending?: boolean;
  onClose: () => void;
  onRevealToken?: (agent: MCPAgent) => void;
  onRotateToken: (agent: MCPAgent) => void;
  onRevokeToken: (agent: MCPAgent) => void;
}) {
  if (!open || !agent) return null;
  const allowTokenManagement = canManage ?? mode === "user";
  const isActive = tokenInfo?.tokenStatus === "active";
  const isCopyDisabled = !isActive || tokenPending || !tokenResult;
  const mcpConfig = tokenResult ? accountMCPConfig(tokenResult.token, agent.agentId) : undefined;

  return (
    <DetailDrawer contextLabel="账户级 Token" onClose={onClose} open={open} subtitle={agent.agentId} title="账户级 Token 与 MCP 配置">
      <KeyValueList
        items={[
          { label: "agent_id", value: agent.agentId },
          { label: "user_id", value: agent.boundUserId || tokenInfo?.userId || "-" },
          { label: "bound_user", value: [agent.boundUserName, agent.boundUserEmail].filter(Boolean).join(" · ") || "-" },
          { label: "创建来源", value: <Badge className="whitespace-nowrap" variant="outline">{agentCreationSourceLabel(agent.creationSource)}</Badge> },
          ...(agent.collector ? [
            { label: "collector_id", value: agent.collector.collectorId },
            { label: "运行实例", value: agent.collector.officeAgentId },
            { label: "设备", value: agent.collector.deviceName || agent.collector.hostname || "-" },
            { label: "device_id", value: agent.collector.deviceId },
            { label: "系统", value: [agent.collector.os, agent.collector.arch].filter(Boolean).join(" / ") || "-" },
            { label: "采集器版本", value: agent.collector.collectorVersion || "-" },
            { label: "采集器状态", value: <CollectorStatusBadge status={agent.collector.status} /> },
            { label: "最近心跳", value: formatDateTime(agent.collector.lastSeenAt) }
          ] : []),
          { label: "token_id", value: tokenInfo?.tokenId || "-" },
          { label: "token_fingerprint", value: tokenInfo?.tokenFingerprint || "-" },
          { label: "token_status", value: tokenInfo?.tokenStatus || "未生成" },
          { label: "scopes", value: tokenInfo?.tokenScopes.join(", ") || "-" },
          { label: "token_expires_at", value: formatDateTime(tokenInfo?.tokenExpiresAt) }
        ]}
      />
      {allowTokenManagement ? <div className="flex flex-wrap gap-2">
        {onRevealToken && isActive && !tokenResult ? (
          <Button disabled={tokenPending} onClick={() => onRevealToken(agent)} variant="secondary">
            <Eye aria-hidden="true" />
            显示令牌
          </Button>
        ) : null}
        <Button disabled={tokenPending} onClick={() => onRotateToken(agent)} variant="primary">
          <RotateCw className="mr-2 h-4 w-4" aria-hidden="true" />
          {tokenInfo ? "轮换访问令牌" : "生成访问令牌"}
        </Button>
        <Button disabled={tokenPending || !isActive} onClick={() => onRevokeToken(agent)} size="sm" variant="destructive">吊销访问令牌</Button>
      </div> : null}
      {tokenError ? <ErrorAlert>{tokenError}</ErrorAlert> : null}
      {allowTokenManagement ? <ResourceList>
        <TokenSecretPane
          disabled={isCopyDisabled}
          title="Token"
          value={tokenResult?.token}
        />
        {tokenResult?.authorizationHeader ? (
          <TokenSecretPane
            disabled={isCopyDisabled}
            title="授权请求头"
            value={tokenResult.authorizationHeader}
          />
        ) : null}
        {mcpConfig !== undefined ? (
          <TokenSecretPane
            copyValue={JSON.stringify(mcpConfig, null, 2)}
            disabled={isCopyDisabled}
            title="MCP 配置"
          >
            <CodeBox value={mcpConfig} />
          </TokenSecretPane>
        ) : null}
      </ResourceList> : null}
    </DetailDrawer>
  );
}

function accountMCPConfig(token: string, agentId: string) {
  return {
    mcpServers: {
      "claw-mcp": {
        url: `${window.location.origin}/mcp`,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Claw-Agent-ID": agentId
        }
      }
    }
  };
}

function TokenSecretPane({
  title,
  value,
  copyValue,
  disabled,
  children
}: {
  title: string;
  value?: string;
  copyValue?: string;
  disabled?: boolean;
  children?: ReactNode;
}) {
  const content = copyValue ?? value ?? "";
  return (
    <Card aria-label={title} className="bg-muted/25 shadow-none" role="region">
      <CardContent className="p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <strong className="text-sm font-semibold">{title}</strong>
          <CopyButton
            disabled={disabled || !content}
            value={content}
            size="sm"
            variant="secondary"
          />
        </div>
        {children ? (
          <div className="mt-3 min-w-0 text-sm text-muted-foreground">{children}</div>
        ) : (
          <p className="mt-1 min-w-0 break-all font-mono text-xs text-muted-foreground">{value || "-"}</p>
        )}
      </CardContent>
    </Card>
  );
}

export function MCPAgentGrantsDrawer({
  agent,
  open,
  mode,
  grants,
  capabilityByID,
  serverByID,
  actionSlot,
  onClose,
  onDeleteGrant
}: {
  agent: MCPAgent | null;
  open: boolean;
  mode: AgentTableMode;
  grants: MCPGrant[];
  capabilityByID: Map<string, MCPCapability>;
  serverByID: Map<string, MCPUpstreamServer>;
  actionSlot?: ReactNode;
  onClose: () => void;
  onDeleteGrant?: (grant: MCPGrant) => void;
}) {
  const [query, setQuery] = useState("");
  const [serverID, setServerID] = useState("all");
  const [domain, setDomain] = useState("all");
  const grantItems = useMemo(
    () =>
      grants.map((grant) => {
        const capability = capabilityByID.get(grant.capabilityId);
        const server = capability ? serverByID.get(capability.upstreamServerId) : undefined;
        return { grant, capability, server };
      }),
    [capabilityByID, grants, serverByID]
  );
  const serverOptions = useMemo(
    () =>
      Array.from(
        new Map(
          grantItems
            .map(({ capability, server }) => {
              const id = capability?.upstreamServerId;
              if (!id) return null;
              return [id, server?.name || id] as const;
            })
            .filter((item): item is readonly [string, string] => Boolean(item))
        ).entries()
      ).sort((left, right) => left[1].localeCompare(right[1])),
    [grantItems]
  );
  const domainOptions = useMemo(
    () =>
      Array.from(new Set(grantItems.map(({ server }) => server?.domain).filter((item): item is string => Boolean(item)))).sort((left, right) =>
        left.localeCompare(right)
      ),
    [grantItems]
  );
  const filteredGrantItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return grantItems.filter(({ grant, capability, server }) => {
      const searchable = [
        grant.id,
        grant.capabilityId,
        grant.grantType,
        grant.createdBy,
        capability?.exposedName,
        capability?.upstreamName,
        capability?.title,
        capability?.type,
        capability?.status,
        capability?.riskLevel,
        server?.id,
        server?.name,
        server?.domain
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (serverID === "all" || capability?.upstreamServerId === serverID) &&
        (domain === "all" || server?.domain === domain)
      );
    });
  }, [domain, grantItems, query, serverID]);

  if (!open || !agent) return null;

  return (
    <DetailDrawer
      contextLabel="授权"
      onClose={onClose}
      open={open}
      subtitle={agent.agentId}
      title="授权信息"
      titleAction={mode === "admin" ? actionSlot : undefined}
    >
      <div className="flex flex-col gap-3">
        <FilterRow compact>
          <FilterSearchField
            aria-label="搜索授权"
            containerClassName="sm:w-72"
            placeholder="搜索授权 / 工具 / 上游服务 / 领域"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <FilterSelect ariaLabel="筛选授权上游服务" value={serverID} onChange={setServerID}>
            <option value="all">全部上游服务</option>
            {serverOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect ariaLabel="筛选授权领域" value={domain} onChange={setDomain}>
            <option value="all">全部领域</option>
            {domainOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </FilterSelect>
        </FilterRow>
      </div>
      <ResourceList>
        {filteredGrantItems.map(({ grant, capability, server }) => {
          return (
            <GrantListCard
              action={
                mode === "admin" && onDeleteGrant ? (
                  <Button className="h-7 px-2 text-xs" onClick={() => onDeleteGrant(grant)} size="sm" variant="destructive">
                    删除授权
                  </Button>
                ) : undefined
              }
              capability={capability}
              grant={grant}
              key={grant.id}
              server={server}
            />
          );
        })}
        {!grants.length ? <EmptyState title="暂无授权。" /> : null}
        {grants.length && !filteredGrantItems.length ? <EmptyState title="暂无匹配授权。" /> : null}
      </ResourceList>
    </DetailDrawer>
  );
}

function GrantListCard({
  grant,
  capability,
  server,
  action
}: {
  grant: MCPGrant;
  capability?: MCPCapability;
  server?: MCPUpstreamServer;
  action?: ReactNode;
}) {
  const title = capability?.exposedName || grant.capabilityId;
  const serverLabel = server?.name || capability?.upstreamServerId || "-";
  const domainLabel = server?.domain || "-";
  const metadata = [
    capability?.type || grant.grantType,
    grant.createdBy ? `创建人 ${grant.createdBy}` : null,
    grant.createdAt ? `创建时间 ${formatDateTime(grant.createdAt)}` : null,
    grant.expiresAt ? `过期时间 ${formatDateTime(grant.expiresAt)}` : null
  ].filter((item): item is string => Boolean(item));

  return (
    <Card className="bg-muted/25 shadow-none" data-testid={`grant-card-${grant.capabilityId}`}>
      <CardContent className="p-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <strong className="min-w-0 truncate text-sm font-semibold">{title}</strong>
            <Badge variant="secondary">{serverLabel}</Badge>
            <Badge variant="muted">{domainLabel}</Badge>
            {capability?.confirmRequired ? <Badge variant="warning">需确认</Badge> : null}
            {capability?.approvalRequired ? <Badge variant="danger">需审批</Badge> : null}
            <Badge variant={mcpStatusVariant(capability?.status || "missing")}>{mcpStatusLabel(capability?.status || "missing")}</Badge>
          </div>
          {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
        </div>
        {metadata.length ? (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
            {metadata.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
