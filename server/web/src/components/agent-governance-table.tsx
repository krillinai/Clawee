import { KeyRound, MoveRight, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";

import { DataTableShell, TableStateRow } from "@/components/governance-ui";
import { CollectorStatusBadge } from "@/components/mcp-agent-access-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AgentGovernanceRow } from "@/lib/agent-governance";
import type { MCPAgent, MCPGrant } from "@/lib/mcp-admin-api";
import { formatDateTime, mcpStatusLabel, mcpStatusVariant } from "@/lib/mcp-admin-ui";
import type { AgentListItem } from "@/lib/office-api";
import { agentCreationSourceLabel } from "@/lib/agent-source";

type Props = {
  canBindAgents: boolean;
  canDeleteAgents: boolean;
  canOpenToken: boolean;
  canTransferAgents: boolean;
  canUnbindAgents: boolean;
  canReadGrants: boolean;
  rows: AgentGovernanceRow[];
  grantsByUserID: Map<string, MCPGrant[]>;
  isLoading: boolean;
  onOpenToken: (agent: MCPAgent) => void;
  onOpenGrants: (agent: MCPAgent) => void;
  onBind: (agent: AgentListItem) => void;
  onDeleteOfficeAgent: (agent: AgentListItem) => void;
  onUnbind: (agent: AgentListItem) => void;
  onDelete: (agent: MCPAgent) => void;
  onTransfer: (agent: MCPAgent) => void;
};

export function AgentGovernanceTable({
  canBindAgents,
  canDeleteAgents,
  canOpenToken,
  canTransferAgents,
  canUnbindAgents,
  canReadGrants,
  rows,
  grantsByUserID,
  isLoading,
  onOpenToken,
  onOpenGrants,
  onBind,
  onDeleteOfficeAgent,
  onUnbind,
  onDelete,
  onTransfer,
}: Props) {
  function stopAndRun(event: MouseEvent<HTMLButtonElement>, action: () => void) {
    event.stopPropagation();
    action();
  }

  return (
    <DataTableShell dense fixedLayout minWidth={1200}>
      <colgroup>
        <col style={{ width: "16%" }} />
        <col style={{ width: "11%" }} />
        <col style={{ width: "11%" }} />
        <col style={{ width: "11%" }} />
        <col style={{ width: "16%" }} />
        <col style={{ width: "5%" }} />
        <col style={{ width: "14%" }} />
        <col style={{ width: "16%" }} />
      </colgroup>
      <TableHeader>
        <TableRow className="bg-background font-mono text-xs text-muted-foreground">
          {[
            "名称",
            "责任账号",
            "运行实例",
            "MCP 身份",
            "创建来源",
            "授权数",
            "更新时间",
            "操作",
          ].map((heading) => (
            <TableHead className="whitespace-nowrap border-b border-border px-3 py-3 font-medium" key={heading}>
              {heading}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? <TableStateRow colSpan={8}>...</TableStateRow> : null}
        {!isLoading && rows.length === 0 ? <TableStateRow colSpan={8}>暂无匹配的智能体。</TableStateRow> : null}
        {!isLoading
          ? rows.map((row) => {
              const office = row.officeAgent;
              const mcp = row.mcpAgent;
              return (
                <TableRow key={row.key}>
                  <TableCell className="border-b border-border px-3 py-3">
                    <strong className="text-sm font-semibold">{row.displayName}</strong>
                  </TableCell>
                  <TableCell className="border-b border-border px-3 py-3">
                    <div className="grid gap-1">
                      <strong className="text-sm font-semibold">{mcp?.boundUserName || "-"}</strong>
                      <span className="break-words font-mono text-xs text-muted-foreground">
                        {mcp?.boundUserEmail || "-"}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="border-b border-border px-3 py-3">
                    {office ? (
                      <div className="grid gap-1">
                        <Badge className="w-fit max-w-full truncate" title={office.status} variant={office.status === "offline" ? "muted" : "success"}>{mcpStatusLabel(office.status)}</Badge>
                        <div className="grid gap-0.5 text-xs text-muted-foreground">
                          <span>运行实例 ID</span>
                          <span className="break-all font-mono">{office.agent_id}</span>
                        </div>
                        <div className="grid gap-0.5 text-xs text-muted-foreground">
                          <span>设备 ID</span>
                          <span className="break-all font-mono">{office.device_id}</span>
                        </div>
                      </div>
                    ) : (
                      <Badge variant="muted">未接入采集</Badge>
                    )}
                  </TableCell>
                  <TableCell className="border-b border-border px-3 py-3">
                    {mcp ? (
                      <div className="grid gap-1">
                        <Badge className="w-fit max-w-full truncate" title={mcp.status} variant={mcpStatusVariant(mcp.status)}>{mcpStatusLabel(mcp.status)}</Badge>
                        <div className="grid gap-0.5 text-xs text-muted-foreground">
                          <span>MCP Agent ID</span>
                          <span className="break-all font-mono">{mcp.agentId}</span>
                        </div>
                      </div>
                    ) : (
                      <Badge variant="warning">未绑定 MCP 身份</Badge>
                    )}
                  </TableCell>
                  <TableCell className="border-b border-border px-3 py-3">
                    {mcp ? (
                      <div className="grid gap-1">
                        <Badge className="w-fit whitespace-nowrap" variant="outline">{agentCreationSourceLabel(mcp.creationSource)}</Badge>
                        {mcp.collector ? (
                          <>
                            <span className="break-all font-mono text-xs text-muted-foreground">{mcp.collector.collectorId}</span>
                            <div className="flex flex-wrap items-center gap-1.5">
                              <CollectorStatusBadge status={mcp.collector.status} />
                              {mcp.collector.lastSeenAt ? (
                                <span className="whitespace-nowrap text-xs text-muted-foreground">
                                  最后上报 {formatDateTime(mcp.collector.lastSeenAt)}
                                </span>
                              ) : null}
                            </div>
                          </>
                        ) : mcp.creationSource === "collector" ? (
                          <span className="text-xs text-muted-foreground">采集器关联缺失</span>
                        ) : null}
                      </div>
                    ) : "-"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap border-b border-border px-3 py-3 font-mono text-xs">
                    {canReadGrants ? (mcp?.boundUserId ? grantsByUserID.get(mcp.boundUserId)?.length ?? 0 : 0) : "-"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap border-b border-border px-3 py-3 font-mono text-xs">
                    {formatDateTime(mcp?.updatedAt || office?.updated_at || "")}
                  </TableCell>
                  <TableCell className="border-b border-border px-3 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {mcp ? (
                        <>
                          {canOpenToken && mcp.boundUserId ? <Button
                            aria-label={`查看 ${row.displayName} 令牌详情`}
                            onClick={(event) => stopAndRun(event, () => onOpenToken(mcp))}
                            size="sm"
                            variant="secondary"
                          >
                            <KeyRound aria-hidden="true" />
                            令牌详情
                          </Button> : null}
                          {canReadGrants && mcp.boundUserId ? <Button onClick={(event) => stopAndRun(event, () => onOpenGrants(mcp))} size="sm" variant="secondary">
                            查看授权
                          </Button> : null}
                          {canTransferAgents && mcp.boundUserId ? (
                            <Button onClick={(event) => stopAndRun(event, () => onTransfer(mcp))} size="sm" variant="outline">
                              <MoveRight data-icon="inline-start" />迁移
                            </Button>
                          ) : null}
                          {canDeleteAgents ? (
                            <Button
                              aria-label={`删除 MCP 身份 ${row.displayName}`}
                              onClick={(event) => stopAndRun(event, () => onDelete(mcp))}
                              size="sm"
                              variant="destructive"
                            >
                              <Trash2 aria-hidden="true" data-icon="inline-start" />
                              删除 MCP 身份
                            </Button>
                          ) : null}
                        </>
                      ) : null}
                      {office && !mcp ? (
                        <>
                          {canBindAgents ? <Button onClick={(event) => stopAndRun(event, () => onBind(office))} size="sm" variant="primary">
                            接入 MCP
                          </Button> : null}
                          {canDeleteAgents ? <Button
                            aria-label={`清理运行实例 ${row.displayName}`}
                            onClick={(event) => stopAndRun(event, () => onDeleteOfficeAgent(office))}
                            size="sm"
                            variant="destructive"
                          >
                            <Trash2 aria-hidden="true" data-icon="inline-start" />
                            清理运行实例
                          </Button> : null}
                        </>
                      ) : null}
                      {canUnbindAgents && office && mcp ? (
                        <Button onClick={(event) => stopAndRun(event, () => onUnbind(office))} size="sm" variant="outline">
                          解除关联
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          : null}
      </TableBody>
    </DataTableShell>
  );
}
