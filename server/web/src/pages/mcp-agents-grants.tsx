import { CalendarIcon, Check, ChevronsUpDown, Plus } from "lucide-react";
import type { FormEvent, ReactNode, WheelEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "react-router-dom";

import {
  ConfirmDialog,
  ErrorAlert,
  FilterRow,
  FilterSearchField,
  FilterSelect,
  ModalShell,
  PageHeader,
  PageShell,
  SuccessAlert
} from "@/components/governance-ui";
import { AgentGovernanceTable } from "@/components/agent-governance-table";
import { useAdminPermission } from "@/components/admin-permissions";
import { MCPAgentGrantsDrawer, MCPAgentTokenDrawer } from "@/components/mcp-agent-access-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  createMCPAgent,
  createMCPGrant,
  deleteMCPAgent,
  deleteMCPGrant,
  getMCPAccountToken,
  listMCPAgents,
  listMCPCapabilities,
  listMCPGrants,
  listMCPUpstreamServers,
  revealMCPAccountToken,
  revokeMCPAccountToken,
  rotateMCPAccountToken,
  transferMCPAgent,
  type MCPAgent,
  type MCPAccountTokenResponse,
  type MCPCapability,
  type MCPGrant,
  type MCPUpstreamServer
} from "@/lib/mcp-admin-api";
import { cn } from "@/lib/utils";
import { listAccounts, type Account } from "@/lib/accounts-api";
import { mergeAgentGovernanceRows } from "@/lib/agent-governance";
import { APIError } from "@/lib/api";
import { mcpStatusLabel } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";
import {
  bindOfficeAgentToMCP,
  deleteOfficeAgent,
  getAgentActivityList,
  unbindOfficeAgentFromMCP,
  type AgentListItem
} from "@/lib/office-api";

const agentsQueryKey = ["mcp-agents"] as const;
const grantsQueryKey = ["mcp-grants"] as const;
const capabilitiesQueryKey = ["mcp-capabilities"] as const;
const upstreamServersQueryKey = ["mcp-upstream-servers"] as const;
const accountsQueryKey = ["accounts"] as const;
const officeAgentsQueryKey = ["office-agent-activity"] as const;
const agentStatusOptions = ["all", "active", "disabled", "inactive", "revoked"] as const;
const grantTypeOptions = ["tool", "resource", "prompt"] as const;
const revokeConfirmText = "吊销后该账户下所有 Agent 都将无法访问 MCP Gateway。";
const rotateConfirmText = "轮换后该账户的旧访问令牌将失效，所有 Agent 的 MCP 配置都需要更新。";
const deleteGrantConfirmText = "删除后同账户所有 Agent 都将失去该工具权限。";
const deleteAgentConfirmText = "将删除该 MCP 身份的账号绑定和登录会话；账户 Token 与账户授权保持不变。采集器上报的运行实例不会删除，操作后将显示为“未绑定 MCP 身份”。此操作无法撤销。";
const deleteOfficeAgentConfirmText = "将清理该运行实例及其会话、轮次、活动和工具调用数据；若采集器后续再次上报，该实例会重新出现。此操作无法撤销。";
type CreateAgentForm = {
  userId: string;
  agentId: string;
  clientId: string;
  name: string;
  tenantId: string;
};

type AddGrantForm = {
  capabilityIds: string[];
  grantType: string;
  expiresAt: string;
  serverId: string;
  domain: string;
  type: string;
  status: string;
};

type ConfirmState =
  | { kind: "rotate"; agent: MCPAgent }
  | { kind: "revoke"; agent: MCPAgent }
  | { kind: "deleteAgent"; agent: MCPAgent }
  | { kind: "deleteOfficeAgent"; agent: AgentListItem }
  | { kind: "deleteGrant"; grant: MCPGrant };

export function MCPAgentsGrantsPage() {
  const canCreateAgent = useAdminPermission(permissions.agentCreate);
  const canDeleteAgent = useAdminPermission(permissions.agentDelete);
  const canRevealToken = useAdminPermission(permissions.agentTokenReveal);
  const canRotateToken = useAdminPermission(permissions.agentTokenRotate);
  const canRevokeToken = useAdminPermission(permissions.agentTokenRevoke);
  const canBindAgent = useAdminPermission(permissions.agentBind);
  const canUnbindAgent = useAdminPermission(permissions.agentUnbind);
  const canTransferAgents = useAdminPermission(permissions.agentTransfer);
  const canReadGrants = useAdminPermission(permissions.mcpGrantRead);
  const canCreateGrant = useAdminPermission(permissions.mcpGrantCreate);
  const canRevokeGrant = useAdminPermission(permissions.mcpGrantRevoke);
  const canReadCapabilities = useAdminPermission(permissions.mcpCapabilityRead) || canCreateGrant;
  const canReadUpstreams = useAdminPermission(permissions.mcpUpstreamRead);
  const canReadAccounts = useAdminPermission(permissions.accountRead);
  const canReadActivity = useAdminPermission(permissions.activityRead);
  const location = useLocation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [agentStatus, setAgentStatus] = useState("all");
  const [tokenDrawerAgentID, setTokenDrawerAgentID] = useState<string | null>(() => new URLSearchParams(location.search).get("agent_id"));
  const [grantsDrawerAgentID, setGrantsDrawerAgentID] = useState<string | null>(null);
  const [tokenResult, setTokenResult] = useState<MCPAccountTokenResponse | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [addGrantOpen, setAddGrantOpen] = useState(false);
  const [addGrantAgentID, setAddGrantAgentID] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [createForm, setCreateForm] = useState<CreateAgentForm>(defaultCreateAgentForm);
  const [addGrantForm, setAddGrantForm] = useState<AddGrantForm>(defaultAddGrantForm);
  const [addGrantError, setAddGrantError] = useState<string | null>(null);
  const [bindingOfficeAgent, setBindingOfficeAgent] = useState<AgentListItem | null>(null);
  const [bindingMCPAgentID, setBindingMCPAgentID] = useState("");
  const [transferAgent, setTransferAgent] = useState<MCPAgent | null>(null);
  const [transferTargetUserID, setTransferTargetUserID] = useState("");
  const [transferReason, setTransferReason] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const agentsQuery = useQuery({
    queryKey: agentsQueryKey,
    queryFn: () => listMCPAgents()
  });
  const grantsQuery = useQuery({
    queryKey: grantsQueryKey,
    queryFn: () => listMCPGrants(),
    enabled: canReadGrants
  });
  const capabilitiesQuery = useQuery({
    queryKey: capabilitiesQueryKey,
    queryFn: () => listMCPCapabilities(),
    enabled: canReadCapabilities
  });
  const serversQuery = useQuery({
    queryKey: upstreamServersQueryKey,
    queryFn: () => listMCPUpstreamServers(),
    enabled: canReadUpstreams
  });
  const accountsQuery = useQuery({
    queryKey: accountsQueryKey,
    queryFn: listAccounts,
    enabled: (canCreateAgent || canTransferAgents) && canReadAccounts
  });
  const officeAgentsQuery = useQuery({
    queryKey: officeAgentsQueryKey,
    queryFn: getAgentActivityList,
    enabled: canReadActivity
  });

  const agents = agentsQuery.data ?? [];
  const grants = grantsQuery.data ?? [];
  const capabilities = capabilitiesQuery.data ?? [];
  const servers = serversQuery.data ?? [];
  const activeAccounts = (accountsQuery.data ?? []).filter((account) => account.status === "active");
  const governanceRows = useMemo(
    () => mergeAgentGovernanceRows(officeAgentsQuery.data?.agents ?? [], agents),
    [agents, officeAgentsQuery.data?.agents]
  );
  const linkedMCPAgentIDs = useMemo(
    () => new Set((officeAgentsQuery.data?.agents ?? []).map((agent) => agent.mcp_agent_id).filter(Boolean)),
    [officeAgentsQuery.data?.agents]
  );
  const availableMCPAgents = useMemo(
    () => agents.filter((agent) => !linkedMCPAgentIDs.has(agent.agentId)),
    [agents, linkedMCPAgentIDs]
  );
  const capabilityByID = useMemo(() => new Map(capabilities.map((item) => [item.id, item])), [capabilities]);
  const serverByID = useMemo(() => new Map(servers.map((item) => [item.id, item])), [servers]);
  const grantsByUserID = useMemo(() => groupGrantsByUserID(grants), [grants]);
  const tokenDrawerAgent = agents.find((agent) => agent.agentId === tokenDrawerAgentID) ?? null;
  const grantsDrawerAgent = agents.find((agent) => agent.agentId === grantsDrawerAgentID) ?? null;
  const bindingMCPAgent = agents.find((agent) => agent.agentId === bindingMCPAgentID) ?? null;
  const drawerGrants = grantsDrawerAgent?.boundUserId ? grantsByUserID.get(grantsDrawerAgent.boundUserId) ?? [] : [];
  const addGrantTargetAgent = agents.find((agent) => agent.agentId === (addGrantAgentID ?? grantsDrawerAgent?.agentId));
  const addGrantTargetUserID = addGrantTargetAgent?.boundUserId ?? "";
  const addGrantGrantedCapabilityIDs = useMemo(
    () => new Set((addGrantTargetUserID ? grantsByUserID.get(addGrantTargetUserID) ?? [] : []).map((grant) => grant.capabilityId)),
    [addGrantTargetUserID, grantsByUserID]
  );
  const accountTokenQuery = useQuery({
    queryKey: ["mcp-account-token", tokenDrawerAgent?.boundUserId],
    queryFn: () => getMCPAccountToken(tokenDrawerAgent?.boundUserId ?? ""),
    enabled: Boolean(tokenDrawerAgent?.boundUserId),
    retry: false
  });
  const filteredRows = useMemo(
    () =>
      governanceRows.filter((row) => {
        const agent = row.mcpAgent;
        const office = row.officeAgent;
        const normalizedQuery = query.trim().toLowerCase();
        return (
          (!normalizedQuery ||
            row.displayName.toLowerCase().includes(normalizedQuery) ||
            agent?.agentId.toLowerCase().includes(normalizedQuery) ||
            agent?.clientId.toLowerCase().includes(normalizedQuery) ||
            agent?.actorId.toLowerCase().includes(normalizedQuery) ||
            agent?.creationSource?.toLowerCase().includes(normalizedQuery) ||
            office?.agent_id.toLowerCase().includes(normalizedQuery) ||
            office?.collector_id.toLowerCase().includes(normalizedQuery)) &&
          (agentStatus === "all" || agent?.status === agentStatus || office?.status === agentStatus)
        );
      }),
    [agentStatus, governanceRows, query]
  );
  const isLoading = agentsQuery.isLoading ||
    (canReadGrants && grantsQuery.isLoading) ||
    (canReadCapabilities && capabilitiesQuery.isLoading) ||
    (canReadUpstreams && serversQuery.isLoading) ||
    (canReadActivity && officeAgentsQuery.isLoading);
  const hasLoadError = agentsQuery.isError || grantsQuery.isError || capabilitiesQuery.isError || serversQuery.isError || officeAgentsQuery.isError;
  const domainOptions = useMemo(() => uniqueOptions(servers.map((server) => server.domain)), [servers]);
  const typeOptions = useMemo(() => uniqueOptions(capabilities.map((capability) => capability.type)), [capabilities]);
  const statusOptions = useMemo(() => uniqueOptions(capabilities.map((capability) => capability.status)), [capabilities]);
  const addGrantCapabilities = useMemo(
    () =>
      capabilities.filter((capability) => {
        const server = serverByID.get(capability.upstreamServerId);
        return (
          capability.status === addGrantForm.status &&
          !addGrantGrantedCapabilityIDs.has(capability.id) &&
          (addGrantForm.serverId === "all" || capability.upstreamServerId === addGrantForm.serverId) &&
          (addGrantForm.domain === "all" || server?.domain === addGrantForm.domain) &&
          (addGrantForm.type === "all" || capability.type === addGrantForm.type)
        );
      }),
    [
      addGrantForm.domain,
      addGrantForm.serverId,
      addGrantForm.status,
      addGrantForm.type,
      addGrantGrantedCapabilityIDs,
      capabilities,
      serverByID
    ]
  );

  const createAgentMutation = useMutation({
    mutationFn: () =>
      createMCPAgent({
        userId: createForm.userId,
        agentId: createForm.agentId.trim(),
        clientId: emptyToUndefined(createForm.clientId),
        name: emptyToUndefined(createForm.name),
        tenantId: emptyToUndefined(createForm.tenantId),
        status: "active"
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setCreateForm(defaultCreateAgentForm);
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
    }
  });

  const rotateMutation = useMutation({
    mutationFn: (agent: MCPAgent) => rotateMCPAccountToken(agent.boundUserId ?? "", { scopes: ["mcp:call"] }),
    onSuccess: (response) => {
      setConfirmState(null);
      setTokenResult(response);
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
      queryClient.invalidateQueries({ queryKey: ["mcp-account-token", response.tokenInfo.userId] });
    }
  });

  const copyTokenMutation = useMutation({
    mutationFn: async (agent: MCPAgent) => {
      const response = await revealMCPAccountToken(agent.boundUserId ?? "");
      return response;
    },
    onSuccess: setTokenResult
  });

  const revokeMutation = useMutation({
    mutationFn: (agent: MCPAgent) => revokeMCPAccountToken(agent.boundUserId ?? ""),
    onSuccess: () => {
      setConfirmState(null);
      setTokenResult(null);
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
      queryClient.invalidateQueries({ queryKey: ["mcp-account-token", tokenDrawerAgent?.boundUserId] });
    }
  });

  const createGrantMutation = useMutation({
    mutationFn: () =>
      Promise.all(
        addGrantForm.capabilityIds.map((capabilityId) => {
          const expiresAt = emptyToUndefined(addGrantForm.expiresAt);
          return createMCPGrant({
            userId: addGrantTargetUserID,
            capabilityId,
            grantType: addGrantForm.grantType,
            ...(expiresAt ? { expiresAt } : {})
          });
        })
      ),
    onSuccess: () => {
      setAddGrantOpen(false);
      setAddGrantForm(defaultAddGrantForm);
      setAddGrantAgentID(null);
      setAddGrantError(null);
      queryClient.invalidateQueries({ queryKey: grantsQueryKey });
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
    },
    onError: (error) => setAddGrantError(error.message)
  });

  const deleteGrantMutation = useMutation({
    mutationFn: (grant: MCPGrant) => deleteMCPGrant(grant.id),
    onSuccess: () => {
      setConfirmState(null);
      queryClient.invalidateQueries({ queryKey: grantsQueryKey });
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
    }
  });

  const deleteAgentMutation = useMutation({
    mutationFn: (agent: MCPAgent) => deleteMCPAgent(agent.agentId),
    onSuccess: (_, agent) => {
      setConfirmState(null);
      setNotice(`MCP 身份“${agent.name || agent.agentId}”已删除；采集器上报的运行实例不会因此删除。`);
      if (tokenDrawerAgentID === agent.agentId) closeTokenDrawer();
      if (grantsDrawerAgentID === agent.agentId) setGrantsDrawerAgentID(null);
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
      queryClient.invalidateQueries({ queryKey: grantsQueryKey });
      queryClient.invalidateQueries({ queryKey: officeAgentsQueryKey });
    }
  });

  const bindAgentMutation = useMutation({
    mutationFn: ({ officeAgent, mcpAgentID }: { officeAgent: AgentListItem; mcpAgentID: string }) =>
      bindOfficeAgentToMCP(officeAgent.collector_id, officeAgent.agent_id, mcpAgentID),
    onSuccess: () => {
      setBindingOfficeAgent(null);
      setBindingMCPAgentID("");
      queryClient.invalidateQueries({ queryKey: officeAgentsQueryKey });
    }
  });

  const unbindAgentMutation = useMutation({
    mutationFn: (officeAgent: AgentListItem) =>
      unbindOfficeAgentFromMCP(officeAgent.collector_id, officeAgent.agent_id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: officeAgentsQueryKey })
  });

  const deleteOfficeAgentMutation = useMutation({
    mutationFn: (officeAgent: AgentListItem) =>
      deleteOfficeAgent(officeAgent.collector_id, officeAgent.agent_id),
    onSuccess: (_, officeAgent) => {
      setConfirmState(null);
      setNotice(`运行实例“${officeAgent.display_name || officeAgent.agent_id}”的当前采集数据已清理；采集器再次上报后可能重新出现。`);
      queryClient.invalidateQueries({ queryKey: officeAgentsQueryKey });
    }
  });

  const transferAgentMutation = useMutation({
    mutationFn: () => transferMCPAgent({
      agentId: transferAgent?.agentId ?? "",
      sourceUserId: transferAgent?.boundUserId ?? "",
      targetUserId: transferTargetUserID,
      reason: transferReason.trim()
    }),
    onSuccess: () => {
      setTransferAgent(null);
      setTransferTargetUserID("");
      setTransferReason("");
      queryClient.invalidateQueries({ queryKey: agentsQueryKey });
      queryClient.invalidateQueries({ queryKey: accountsQueryKey });
    }
  });

  function submitCreateAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createAgentMutation.mutate();
  }

  function openCreateAgent() {
    createAgentMutation.reset();
    setCreateOpen(true);
  }

  function closeCreateAgent() {
    setCreateOpen(false);
    createAgentMutation.reset();
  }

  function openAgentBinding(officeAgent: AgentListItem) {
    bindAgentMutation.reset();
    setBindingOfficeAgent(officeAgent);
    setBindingMCPAgentID(availableMCPAgents[0]?.agentId ?? "");
  }

  function closeAgentBinding() {
    setBindingOfficeAgent(null);
    setBindingMCPAgentID("");
    bindAgentMutation.reset();
  }

  function openAddGrant(agent: MCPAgent | null = grantsDrawerAgent) {
    if (!agent) return;
    setGrantsDrawerAgentID(agent.agentId);
    setAddGrantAgentID(agent.agentId);
    if (!agent.boundUserId) return;
    const grantedCapabilityIDs = new Set((grantsByUserID.get(agent.boundUserId) ?? []).map((grant) => grant.capabilityId));
    const firstActiveCapability = firstGrantableActiveCapability(capabilities, grantedCapabilityIDs);
    setAddGrantForm({ ...defaultAddGrantForm, capabilityIds: firstActiveCapability ? [firstActiveCapability.id] : [] });
    setAddGrantError(null);
    setAddGrantOpen(true);
  }

  function submitAddGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAddGrantError(null);
    createGrantMutation.mutate();
  }

  function closeTokenDrawer() {
    setTokenDrawerAgentID(null);
    setTokenResult(null);
    copyTokenMutation.reset();
    createAgentMutation.reset();
    rotateMutation.reset();
  }

  function openConfirm(nextConfirmState: ConfirmState) {
    setNotice(null);
    copyTokenMutation.reset();
    rotateMutation.reset();
    revokeMutation.reset();
    deleteGrantMutation.reset();
    deleteAgentMutation.reset();
    deleteOfficeAgentMutation.reset();
    setConfirmState(nextConfirmState);
  }

  function closeConfirm() {
    setConfirmState(null);
    rotateMutation.reset();
    revokeMutation.reset();
    deleteGrantMutation.reset();
    deleteAgentMutation.reset();
    deleteOfficeAgentMutation.reset();
  }

  function runConfirmAction() {
    if (!confirmState) return;
    if (confirmState.kind === "rotate") rotateMutation.mutate(confirmState.agent);
    if (confirmState.kind === "revoke") revokeMutation.mutate(confirmState.agent);
    if (confirmState.kind === "deleteGrant") deleteGrantMutation.mutate(confirmState.grant);
    if (confirmState.kind === "deleteAgent") deleteAgentMutation.mutate(confirmState.agent);
    if (confirmState.kind === "deleteOfficeAgent") deleteOfficeAgentMutation.mutate(confirmState.agent);
  }

  return (
    <PageShell>
      <PageHeader
        actions={canCreateAgent ?
          <Button onClick={openCreateAgent} variant="primary">
            <Plus className="mr-2 h-4 w-4" aria-hidden="true" />
            创建智能体
          </Button> : undefined
        }
        title="智能体管理"
      >
        统一查看 Collector 发现的运行实例与 MCP Gateway 治理身份。两者关联后合并为一个智能体。
      </PageHeader>
      {hasLoadError ? (
        <ErrorBlock>
          智能体管理加载失败：无法加载运行实例、治理身份、授权、能力或上游服务数据。
        </ErrorBlock>
      ) : null}
      {unbindAgentMutation.isError ? <ErrorBlock>解除关联失败：{unbindAgentMutation.error.message}</ErrorBlock> : null}
      {notice ? <SuccessAlert>{notice}</SuccessAlert> : null}

      <Card>
        <CardHeader className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <CardTitle>智能体列表</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">点击列表行查看访问令牌；操作区可查看授权。</p>
          </div>
          <Badge variant="muted">{filteredRows.length} 条可见</Badge>
        </CardHeader>
        <CardContent>
          <FilterRow>
            <FilterSearchField
              aria-label="搜索智能体"
              placeholder="搜索名称 / 运行实例 ID / MCP Agent ID"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <FilterSelect ariaLabel="筛选智能体状态" value={agentStatus} onChange={setAgentStatus}>
              {agentStatusOptions.map((option) => (
                <option key={option} value={option}>
                  {option === "all" ? "全部智能体状态" : mcpStatusLabel(option)}
                </option>
              ))}
            </FilterSelect>
          </FilterRow>
          <AgentGovernanceTable
            canBindAgents={canBindAgent}
            canDeleteAgents={canDeleteAgent}
            canOpenToken={canRevealToken || canRotateToken || canRevokeToken}
            canTransferAgents={canTransferAgents}
            canUnbindAgents={canUnbindAgent}
            canReadGrants={canReadGrants}
            rows={hasLoadError ? [] : filteredRows}
            grantsByUserID={grantsByUserID}
            isLoading={isLoading}
            onBind={openAgentBinding}
            onDeleteOfficeAgent={(agent) => openConfirm({ kind: "deleteOfficeAgent", agent })}
            onUnbind={(officeAgent) => unbindAgentMutation.mutate(officeAgent)}
            onDelete={(agent) => openConfirm({ kind: "deleteAgent", agent })}
            onOpenGrants={(agent) => canReadGrants && setGrantsDrawerAgentID(agent.agentId)}
            onOpenToken={(agent) => {
              if (!agent.boundUserId) return;
              setTokenResult(null);
              copyTokenMutation.reset();
              setTokenDrawerAgentID(agent.agentId);
            }}
            onTransfer={(agent) => {
              transferAgentMutation.reset();
              setTransferAgent(agent);
              setTransferTargetUserID(activeAccounts.find((account) => account.userId !== agent.boundUserId)?.userId ?? "");
              setTransferReason("");
            }}
          />
        </CardContent>
      </Card>

      <MCPAgentTokenDrawer
        agent={tokenDrawerAgent}
        canReveal={canRevealToken}
        canRevoke={canRevokeToken}
        canRotate={canRotateToken}
        mode="admin"
        onClose={closeTokenDrawer}
        onRevealToken={(agent) => copyTokenMutation.mutate(agent)}
        onRevokeToken={(agent) => openConfirm({ kind: "revoke", agent })}
        onRotateToken={(agent) => openConfirm({ kind: "rotate", agent })}
        open={Boolean(tokenDrawerAgent)}
        tokenError={
          copyTokenMutation.isError
            ? agentTokenCopyErrorMessage(copyTokenMutation.error)
            : null
        }
        tokenPending={copyTokenMutation.isPending || rotateMutation.isPending || revokeMutation.isPending}
        tokenInfo={tokenResult?.tokenInfo ?? accountTokenQuery.data ?? null}
        tokenResult={tokenResult}
      />

      <MCPAgentGrantsDrawer
        actionSlot={
          canCreateGrant && canReadCapabilities ?
          <Button className="h-7 px-2 text-xs" disabled={!grantsDrawerAgent} onClick={() => openAddGrant()} variant="primary">
            添加授权
          </Button> : undefined
        }
        agent={grantsDrawerAgent}
        capabilityByID={capabilityByID}
        grants={drawerGrants}
        mode="admin"
        onClose={() => setGrantsDrawerAgentID(null)}
        onDeleteGrant={canRevokeGrant ? (grant) => openConfirm({ kind: "deleteGrant", grant }) : undefined}
        open={canReadGrants && Boolean(grantsDrawerAgent)}
        serverByID={serverByID}
      />

      <CreateAgentModal
        accounts={activeAccounts}
        allowAccountLookup={canReadAccounts}
        error={createAgentMutation.isError ? createAgentMutation.error.message : null}
        form={createForm}
        isPending={createAgentMutation.isPending}
        onChange={setCreateForm}
        onClose={closeCreateAgent}
        onSubmit={submitCreateAgent}
        open={createOpen}
      />

      <ModalShell contextLabel="智能体治理" onClose={closeAgentBinding} open={Boolean(bindingOfficeAgent)} title="接入 MCP">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (bindingOfficeAgent && bindingMCPAgentID) {
              bindAgentMutation.mutate({ officeAgent: bindingOfficeAgent, mcpAgentID: bindingMCPAgentID });
            }
          }}
        >
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="mcp-agent-binding">MCP 治理身份</FieldLabel>
              <NativeSelect
                id="mcp-agent-binding"
                aria-label="选择 MCP 治理身份"
                value={bindingMCPAgentID}
                onChange={(event) => setBindingMCPAgentID(event.target.value)}
              >
                <option value="">选择未关联的 MCP 治理身份</option>
                {availableMCPAgents.map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.name || agent.agentId} ({agent.agentId})
                  </option>
                ))}
              </NativeSelect>
              {availableMCPAgents.length === 0 ? (
                <FieldDescription>暂无可关联的 MCP 治理身份，请先创建智能体。</FieldDescription>
              ) : null}
            </Field>
            {bindAgentMutation.isError ? (
              <ErrorBlock>{agentBindingErrorMessage(bindAgentMutation.error, bindingOfficeAgent, bindingMCPAgent)}</ErrorBlock>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button onClick={closeAgentBinding} type="button" variant="secondary">取消</Button>
              <Button disabled={!bindingMCPAgentID || bindAgentMutation.isPending} type="submit" variant="primary">确认绑定</Button>
            </div>
          </FieldGroup>
        </form>
      </ModalShell>

      <ModalShell contextLabel="智能体治理" onClose={() => setTransferAgent(null)} open={Boolean(transferAgent)} title="迁移 Agent" subtitle={transferAgent?.name || transferAgent?.agentId}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (transferTargetUserID && transferReason.trim()) transferAgentMutation.mutate();
          }}
        >
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="agent-transfer-target">目标账号</FieldLabel>
              {canReadAccounts ? <NativeSelect id="agent-transfer-target" value={transferTargetUserID} onChange={(event) => setTransferTargetUserID(event.target.value)}>
                <option value="">选择启用账号</option>
                {activeAccounts.filter((account) => account.userId !== transferAgent?.boundUserId).map((account) => (
                  <option key={account.userId} value={account.userId}>{account.name || account.email} ({account.email})</option>
                ))}
              </NativeSelect> : <Input id="agent-transfer-target" placeholder="输入目标账号 user_id" required value={transferTargetUserID} onChange={(event) => setTransferTargetUserID(event.target.value)} />}
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-transfer-reason">迁移原因</FieldLabel>
              <Input id="agent-transfer-reason" maxLength={500} required value={transferReason} onChange={(event) => setTransferReason(event.target.value)} />
              <FieldDescription>账户 Token 和账户授权不迁移；Agent 将立即使用目标账户的 Token 与授权。</FieldDescription>
            </Field>
            {transferAgentMutation.isError ? <ErrorBlock>{transferAgentMutation.error.message}</ErrorBlock> : null}
            <Field className="justify-end" orientation="horizontal">
              <Button onClick={() => setTransferAgent(null)} type="button" variant="secondary">取消</Button>
              <Button disabled={transferAgentMutation.isPending || !transferTargetUserID || !transferReason.trim()} type="submit" variant="primary">确认迁移</Button>
            </Field>
          </FieldGroup>
        </form>
      </ModalShell>

      <AddGrantModal
        capabilities={addGrantCapabilities}
        domainOptions={domainOptions}
        error={addGrantError}
        form={addGrantForm}
        isPending={createGrantMutation.isPending}
        onChange={(next) => setAddGrantForm((current) => ({ ...current, ...next }))}
        onClose={() => {
          setAddGrantOpen(false);
          setAddGrantAgentID(null);
        }}
        onSubmit={submitAddGrant}
        open={addGrantOpen}
        servers={servers}
        serverByID={serverByID}
        statusOptions={statusOptions}
        typeOptions={typeOptions}
      />

      <ConfirmModal
        confirmState={confirmState}
        error={
          rotateMutation.isError
            ? rotateMutation.error.message
            : revokeMutation.isError
              ? revokeMutation.error.message
              : deleteGrantMutation.isError
                ? deleteGrantMutation.error.message
                : deleteAgentMutation.isError
                  ? deleteAgentMutation.error.message
                  : deleteOfficeAgentMutation.isError
                    ? deleteOfficeAgentMutation.error.message
                    : null
        }
        isPending={rotateMutation.isPending || revokeMutation.isPending || deleteGrantMutation.isPending || deleteAgentMutation.isPending || deleteOfficeAgentMutation.isPending}
        onClose={closeConfirm}
        onConfirm={runConfirmAction}
      />
    </PageShell>
  );
}

function CreateAgentModal({
  accounts,
  allowAccountLookup,
  open,
  form,
  error,
  isPending,
  onChange,
  onClose,
  onSubmit
}: {
  accounts: Account[];
  allowAccountLookup: boolean;
  open: boolean;
  form: CreateAgentForm;
  error: string | null;
  isPending: boolean;
  onChange: (form: CreateAgentForm) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <ModalShell contextLabel="MCP 网关" onClose={onClose} open={open} title="创建智能体">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="责任账号">
            {allowAccountLookup ? <NativeSelect aria-label="责任账号" required value={form.userId} onChange={(event) => onChange({ ...form, userId: event.target.value })}>
              <option value="">请选择启用账号</option>
              {accounts.map((account) => <option key={account.userId} value={account.userId}>{account.name || account.email} ({account.email})</option>)}
            </NativeSelect> : <Input aria-label="责任账号" placeholder="输入已启用账号的 user_id" required value={form.userId} onChange={(event) => onChange({ ...form, userId: event.target.value })} />}
          </FormField>
          <FormField label="agent_id">
            <Input
              aria-label="agent_id"
              required
              value={form.agentId}
              onChange={(event) => onChange({ ...form, agentId: event.target.value })}
            />
          </FormField>
          <FormField label="client_id">
            <Input aria-label="client_id" value={form.clientId} onChange={(event) => onChange({ ...form, clientId: event.target.value })} />
          </FormField>
          <FormField label="名称">
            <Input aria-label="名称" value={form.name} onChange={(event) => onChange({ ...form, name: event.target.value })} />
          </FormField>
          <FormField label="tenant_id">
            <Input aria-label="tenant_id" value={form.tenantId} onChange={(event) => onChange({ ...form, tenantId: event.target.value })} />
          </FormField>
        </div>
        {error ? <ErrorBlock>{error}</ErrorBlock> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={isPending} onClick={onClose} variant="secondary">
            取消
          </Button>
          <Button disabled={isPending} type="submit" variant="primary">
            {isPending ? "提交中..." : "提交创建"}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function AddGrantModal({
  open,
  form,
  capabilities,
  servers,
  serverByID,
  domainOptions,
  typeOptions,
  statusOptions,
  error,
  isPending,
  onChange,
  onClose,
  onSubmit
}: {
  open: boolean;
  form: AddGrantForm;
  capabilities: MCPCapability[];
  servers: MCPUpstreamServer[];
  serverByID: Map<string, MCPUpstreamServer>;
  domainOptions: string[];
  typeOptions: string[];
  statusOptions: string[];
  error: string | null;
  isPending: boolean;
  onChange: (next: Partial<AddGrantForm>) => void;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const selectedCapabilityIDs = form.capabilityIds.filter((capabilityId) =>
    capabilities.some((capability) => capability.id === capabilityId)
  );
  return (
    <ModalShell contextLabel="MCP 网关" onClose={onClose} open={open} title="添加授权">
      <form className="grid gap-4" onSubmit={onSubmit}>
        <FilterRow compact>
          <FilterSelect ariaLabel="筛选授权上游服务" value={form.serverId} onChange={(value) => onChange({ serverId: value, capabilityIds: [] })}>
            <option value="all">全部上游服务</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>
                {server.name || server.id}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect ariaLabel="筛选授权领域" value={form.domain} onChange={(value) => onChange({ domain: value, capabilityIds: [] })}>
            <option value="all">全部领域</option>
            {domainOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect ariaLabel="筛选授权能力类型" value={form.type} onChange={(value) => onChange({ type: value, capabilityIds: [] })}>
            <option value="all">全部能力类型</option>
            {typeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect ariaLabel="筛选授权状态" value={form.status} onChange={(value) => onChange({ status: value, capabilityIds: [] })}>
            {statusOptions.map((option) => (
              <option key={option} value={option}>
                {mcpStatusLabel(option)}
              </option>
            ))}
          </FilterSelect>
        </FilterRow>

        <CapabilityMultiSelect
          capabilities={capabilities}
          selectedCapabilityIDs={selectedCapabilityIDs}
          serverByID={serverByID}
          onChange={(capabilityIds) => onChange({ capabilityIds })}
        />
        <FormField label="grant_type">
          <NativeSelect
            aria-label="grant_type"
            value={form.grantType}
            onChange={(event) => onChange({ grantType: event.target.value })}
          >
            {grantTypeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField label="expires_at">
          <GrantExpiresAtPicker value={form.expiresAt} onChange={(expiresAt) => onChange({ expiresAt })} />
        </FormField>
        {error ? <ErrorBlock>{error}</ErrorBlock> : null}
        <div className="flex justify-end gap-2">
          <Button disabled={isPending} onClick={onClose} variant="secondary">
            取消
          </Button>
          <Button disabled={isPending || selectedCapabilityIDs.length === 0} type="submit" variant="primary">
            {isPending ? "提交中..." : "提交授权"}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}

function GrantExpiresAtPicker({ value, onChange }: { value: string; onChange: (expiresAt: string) => void }) {
  const selectedDate = parseGrantExpiresAt(value);
  const label = selectedDate ? formatDateOnly(selectedDate) : "未设置过期时间";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label={`expires_at，${label}`}
          className={cn("w-full justify-start text-left font-normal", !selectedDate && "text-muted-foreground")}
          type="button"
          variant="outline"
        >
          <CalendarIcon aria-hidden="true" />
          <span>{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar
          mode="single"
          selected={selectedDate}
          onSelect={(date) => onChange(date ? toGrantExpiresAt(date) : "")}
        />
        {selectedDate ? (
          <div className="border-t p-3">
            <Button className="w-full" onClick={() => onChange("")} type="button" variant="secondary">
              清除过期时间
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function CapabilityMultiSelect({
  capabilities,
  selectedCapabilityIDs,
  serverByID,
  onChange
}: {
  capabilities: MCPCapability[];
  selectedCapabilityIDs: string[];
  serverByID: Map<string, MCPUpstreamServer>;
  onChange: (capabilityIds: string[]) => void;
}) {
  const selectedCapabilities = selectedCapabilityIDs
    .map((capabilityId) => capabilities.find((capability) => capability.id === capabilityId))
    .filter((capability): capability is MCPCapability => Boolean(capability));
  const selectedCapabilityIDSet = new Set(selectedCapabilityIDs);
  const selectedCount = selectedCapabilities.length;
  const selectedSummary =
    selectedCount === 0
      ? "选择能力"
      : selectedCount === 1
        ? `${selectedCapabilities[0].exposedName} (${selectedCapabilities[0].id})`
        : `已选择 ${selectedCount} 个能力`;

  function toggleCapability(capabilityId: string) {
    onChange(
      selectedCapabilityIDSet.has(capabilityId)
        ? selectedCapabilityIDs.filter((item) => item !== capabilityId)
        : [...selectedCapabilityIDs, capabilityId]
    );
  }
  const handleListWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    event.currentTarget.scrollTop += event.deltaY;
    event.stopPropagation();
  }, []);

  return (
    <FormField label="capability_id">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            aria-label={`capability_id，${selectedCount > 0 ? `已选择 ${selectedCount} 个能力` : "未选择能力"}`}
            className="w-full justify-between"
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="truncate">{selectedSummary}</span>
            <ChevronsUpDown className="opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
          <Command>
            <CommandInput placeholder="搜索 capability_id / exposed_name" />
            <CommandList className="max-h-72" onWheel={handleListWheel}>
              <CommandEmpty>没有匹配的能力</CommandEmpty>
              <CommandGroup>
                {capabilities.map((capability) => {
                  const selected = selectedCapabilityIDSet.has(capability.id);
                  const server = serverByID.get(capability.upstreamServerId);
                  const serverLabel = server?.name || capability.upstreamServerId;
                  const domainLabel = server?.domain;
                  return (
                    <CommandItem
                      key={capability.id}
                      aria-selected={selected}
                      className="items-start gap-3 py-2"
                      keywords={[
                        capability.id,
                        capability.exposedName,
                        capability.upstreamName,
                        capability.upstreamServerId,
                        server?.name,
                        server?.domain,
                        capability.type,
                        capability.status
                      ].filter((keyword): keyword is string => Boolean(keyword))}
                      value={`${capability.exposedName} ${capability.id}`}
                      onSelect={() => toggleCapability(capability.id)}
                    >
                      <Checkbox
                        aria-hidden="true"
                        checked={selected}
                        className="mt-1"
                        tabIndex={-1}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-medium">{capability.exposedName}</span>
                          {serverLabel ? <Badge variant="outline">{serverLabel}</Badge> : null}
                          {domainLabel ? <Badge variant="outline">{domainLabel}</Badge> : null}
                          {selected ? <Check className="text-primary" /> : null}
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <span className="truncate font-mono">{capability.id}</span>
                          <Badge variant="outline">{capability.type}</Badge>
                          <Badge variant={capability.status === "active" ? "success" : "muted"}>{mcpStatusLabel(capability.status)}</Badge>
                          {capability.confirmRequired ? <Badge variant="warning">需确认</Badge> : null}
                          {capability.approvalRequired ? <Badge variant="warning">需审批</Badge> : null}
                        </div>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selectedCapabilities.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {selectedCapabilities.map((capability) => (
            <Badge key={capability.id} className="max-w-full" variant="secondary">
              <span className="truncate">{capability.exposedName}</span>
            </Badge>
          ))}
        </div>
      ) : null}
      <span className={cn("text-xs text-muted-foreground", capabilities.length === 0 && "text-danger")}>
        {capabilities.length === 0 ? "当前过滤条件下没有可授权能力" : "可搜索 exposed_name、capability_id、上游服务、类型或状态"}
      </span>
    </FormField>
  );
}

function ConfirmModal({
  confirmState,
  error,
  isPending,
  onClose,
  onConfirm
}: {
  confirmState: ConfirmState | null;
  error: string | null;
  isPending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const text =
    confirmState?.kind === "rotate"
      ? rotateConfirmText
      : confirmState?.kind === "revoke"
        ? revokeConfirmText
        : confirmState?.kind === "deleteGrant"
          ? deleteGrantConfirmText
          : confirmState?.kind === "deleteAgent"
            ? deleteAgentConfirmText
            : confirmState?.kind === "deleteOfficeAgent"
              ? deleteOfficeAgentConfirmText
              : "";
  const buttonLabel =
    confirmState?.kind === "rotate"
      ? "确认轮换访问令牌"
      : confirmState?.kind === "revoke"
        ? "确认吊销访问令牌"
        : confirmState?.kind === "deleteAgent"
          ? "确认删除 MCP 身份"
          : confirmState?.kind === "deleteOfficeAgent"
            ? "确认清理运行实例"
            : "确认删除授权";
  const title =
    confirmState?.kind === "deleteAgent"
      ? "删除 MCP 身份"
      : confirmState?.kind === "deleteOfficeAgent"
        ? "清理运行实例"
        : "确认";
  const description = error ? `${text}\n${error}` : text;

  return (
    <ConfirmDialog
      confirmLabel={isPending ? "处理中..." : buttonLabel}
      description={description}
      onClose={onClose}
      onConfirm={onConfirm}
      open={Boolean(confirmState)}
      pending={isPending}
      title={title}
      variant={confirmState?.kind === "rotate" ? "default" : "destructive"}
    />
  );
}

function FormField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Label className="grid gap-2 text-sm">
      <span className="font-mono text-xs text-muted-foreground">{label}</span>
      {children}
    </Label>
  );
}

function ErrorBlock({ children }: { children: ReactNode }) {
  return <ErrorAlert>{children}</ErrorAlert>;
}

function agentBindingErrorMessage(error: Error, officeAgent: AgentListItem | null, mcpAgent: MCPAgent | null): string {
  if (!(error instanceof APIError)) return `绑定失败：${error.message}`;

  const officeLabel = officeAgent
    ? `运行实例“${officeAgent.display_name || officeAgent.agent_id}”（Agent ID：${officeAgent.agent_id}，Collector ID：${officeAgent.collector_id}）`
    : "当前运行实例";
  const mcpLabel = mcpAgent
    ? `MCP 治理身份“${mcpAgent.name || mcpAgent.agentId}”（Agent ID：${mcpAgent.agentId}，责任账号：${mcpAgentOwnerLabel(mcpAgent)}）`
    : "所选 MCP 治理身份";

  if (error.code === "agent_owner_mismatch") {
    return `无法绑定：${officeLabel}与 ${mcpLabel}不属于同一责任账号。MCP Gateway 仅允许同一责任账号下的运行实例和治理身份建立关联。请改选该运行实例所属账号创建的治理身份；若当前选择应当正确，请检查该采集器的注册账号。`;
  }
  if (error.code === "office_agent_not_found") {
    return `无法绑定：${officeLabel}已不存在或已被清理。请刷新智能体列表后重试。`;
  }
  if (error.code === "mcp_agent_not_found") {
    return `无法绑定：${mcpLabel}已不存在。请刷新列表并重新选择治理身份。`;
  }
  if (error.code === "office_agent_already_bound") {
    return `无法绑定：${officeLabel}已经关联了其他 MCP 治理身份。请先解除原有关联，再执行绑定。`;
  }
  if (error.code === "mcp_agent_already_bound") {
    return `无法绑定：${mcpLabel}已经关联了其他运行实例。一个 MCP 治理身份只能关联一个运行实例，请改选未关联的治理身份。`;
  }
  return `绑定失败：${error.message}`;
}

function mcpAgentOwnerLabel(agent: MCPAgent): string {
  const name = agent.boundUserName?.trim();
  const email = agent.boundUserEmail?.trim();
  if (name && email && name !== email) return `${name} / ${email}`;
  return email || name || agent.boundUserId || "未标明";
}

function agentTokenCopyErrorMessage(error: Error) {
  if (error.message === "account token not found") {
    return "当前账户尚未生成访问令牌。请点击“生成访问令牌”。";
  }
  return error.message;
}

function firstGrantableActiveCapability(capabilities: MCPCapability[], grantedCapabilityIDs: Set<string>) {
  return capabilities.find((capability) => capability.status === "active" && !grantedCapabilityIDs.has(capability.id));
}

function groupGrantsByUserID(grants: MCPGrant[]) {
  const index = new Map<string, MCPGrant[]>();
  for (const grant of grants) {
    index.set(grant.userId, [...(index.get(grant.userId) ?? []), grant]);
  }
  return index;
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function emptyToUndefined(value: string) {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseGrantExpiresAt(value: string) {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function toGrantExpiresAt(date: Date) {
  const localEndOfDay = new Date(date);
  localEndOfDay.setHours(23, 59, 59, 999);
  return localEndOfDay.toISOString();
}

function formatDateOnly(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const defaultCreateAgentForm: CreateAgentForm = {
  userId: "",
  agentId: "",
  clientId: "",
  name: "",
  tenantId: ""
};

const defaultAddGrantForm: AddGrantForm = {
  capabilityIds: [],
  grantType: "tool",
  expiresAt: "",
  serverId: "all",
  domain: "all",
  type: "all",
  status: "active"
};
