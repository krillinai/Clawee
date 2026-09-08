import { Eye, RotateCw, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ConfirmDialog, ErrorAlert, PageHeader } from "@/components/governance-ui";
import { MCPAgentGrantsDrawer, MCPAgentTokenDrawer, MCPAgentTokenTable } from "@/components/mcp-agent-access-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  deleteMyAgent,
  getMyAccountToken,
  listMyAgents,
  listMyMCPCatalog,
  revealMyAccountToken,
  revokeMyAccountToken,
  rotateMyAccountToken,
  updateMyAgentName,
  type AccountTokenInfo,
  type AccountTokenSecret,
  type AgentAccess,
  type AgentMCPTool,
  type AgentMCPUpstream
} from "@/lib/agent-api";
import type {
  MCPAccountTokenInfo,
  MCPAccountTokenResponse,
  MCPAgent,
  MCPCapability,
  MCPGrant,
  MCPUpstreamServer
} from "@/lib/mcp-admin-api";
import { formatDateTime, mcpStatusLabel, mcpStatusVariant } from "@/lib/mcp-admin-ui";

const accessQueryKey = ["agent-access"] as const;
const tokenQueryKey = ["account-token"] as const;
const catalogQueryKey = ["account-mcp-catalog"] as const;

export function AgentAccessPage() {
  const [searchParams] = useSearchParams();
  const routeAgentId = searchParams.get("agent_id") ?? undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedAgentId, setSelectedAgentId] = useState(routeAgentId);
  const [drawer, setDrawer] = useState<"token" | "grants" | null>(null);
  const [secretResult, setSecretResult] = useState<AccountTokenSecret | null>(null);
  const [tokenOverride, setTokenOverride] = useState<AccountTokenInfo | null>(null);
  const [editingAgent, setEditingAgent] = useState<MCPAgent | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deletingAgent, setDeletingAgent] = useState<MCPAgent | null>(null);

  const agentsQuery = useQuery({ queryKey: accessQueryKey, queryFn: listMyAgents, refetchInterval: 30_000 });
  const tokenQuery = useQuery({ queryKey: tokenQueryKey, queryFn: getMyAccountToken, retry: false });
  const catalogQuery = useQuery({ queryKey: catalogQueryKey, queryFn: () => listMyMCPCatalog() });
  const agents = useMemo(() => (agentsQuery.data ?? []).map(mapUserAgent), [agentsQuery.data]);
  const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId) ?? agents[0] ?? null;
  const catalog = catalogQuery.data?.upstreams ?? [];
  const grants = useMemo(() => mapCatalogGrants(catalog, agents[0]?.boundUserId ?? ""), [agents, catalog]);
  const capabilities = useMemo(() => catalog.flatMap((upstream) => upstream.tools.map((tool) => mapCatalogCapability(upstream, tool))), [catalog]);
  const servers = useMemo(() => catalog.map(mapCatalogServer), [catalog]);
  const capabilityByID = useMemo(() => new Map(capabilities.map((item) => [item.id, item])), [capabilities]);
  const serverByID = useMemo(() => new Map(servers.map((item) => [item.id, item])), [servers]);
  const tokenInfo = toAdminTokenInfo(tokenOverride ?? tokenQuery.data ?? secretResult?.tokenInfo ?? null);
  const tokenResult = toAdminTokenResult(secretResult);

  const revealMutation = useMutation({ mutationFn: revealMyAccountToken, onSuccess: (response) => {
    setSecretResult(response);
    setTokenOverride(response.tokenInfo);
  }});
  const rotateMutation = useMutation({ mutationFn: rotateMyAccountToken, onSuccess: (response) => {
    setSecretResult(response);
    setTokenOverride(response.tokenInfo);
    void queryClient.invalidateQueries({ queryKey: tokenQueryKey });
  }});
  const revokeMutation = useMutation({ mutationFn: revokeMyAccountToken, onSuccess: (response) => {
    setSecretResult(null);
    setTokenOverride((current) => current ? { ...current, tokenStatus: response.tokenStatus } : null);
    void queryClient.invalidateQueries({ queryKey: tokenQueryKey });
  }});
  const updateNameMutation = useMutation({ mutationFn: ({ agentId, name }: { agentId: string; name: string }) => updateMyAgentName(agentId, name), onSuccess: () => {
    setEditingAgent(null);
    void queryClient.invalidateQueries({ queryKey: accessQueryKey });
  }});
  const deleteMutation = useMutation({ mutationFn: (agent: MCPAgent) => deleteMyAgent(agent.agentId), onSuccess: (_, agent) => {
    setDeletingAgent(null);
    if (selectedAgentId === agent.agentId) {
      setSelectedAgentId(undefined);
      setDrawer(null);
    }
    if (routeAgentId === agent.agentId) navigate("/app/agents", { replace: true });
    void queryClient.invalidateQueries({ queryKey: accessQueryKey });
  }});

  const tokenPending = revealMutation.isPending || rotateMutation.isPending || revokeMutation.isPending;
  const tokenError = revealMutation.isError
    ? revealMutation.error.message
    : rotateMutation.isError
      ? rotateMutation.error.message
      : revokeMutation.isError
        ? revokeMutation.error.message
        : null;

  function openToken(agent: MCPAgent) {
    setSelectedAgentId(agent.agentId);
    setDrawer("token");
    revealMutation.reset();
    if (!secretResult && tokenInfo?.tokenStatus === "active") revealMutation.mutate();
  }

  function closeEditDialog() {
    if (updateNameMutation.isPending) return;
    setEditingAgent(null);
    updateNameMutation.reset();
  }

  return (
    <>
      <PageHeader title="我的 Agent 接入">当前账户的所有 active Agent 共用一份 MCP Token 和工具授权，每个 Agent 使用自己的调用身份。</PageHeader>

      <Card>
        <CardHeader className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
          <div><CardTitle>账户 MCP Token</CardTitle><p className="mt-1 text-sm text-muted-foreground">Token 属于当前账户，轮换或吊销后会同时影响账户下所有 Agent。</p></div>
          <Badge variant={mcpStatusVariant(tokenInfo?.tokenStatus ?? "missing")}>{tokenInfo ? mcpStatusLabel(tokenInfo.tokenStatus) : "未生成"}</Badge>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <TokenMetadata label="user_id" value={tokenInfo?.userId || agents[0]?.boundUserId || "-"} />
            <TokenMetadata label="token_fingerprint" value={tokenInfo?.tokenFingerprint || "-"} />
            <TokenMetadata label="scopes" value={tokenInfo?.tokenScopes.join(", ") || "-"} />
            <TokenMetadata label="last_used_at" value={formatDateTime(tokenInfo?.tokenLastUsedAt)} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!tokenInfo || tokenInfo.tokenStatus !== "active" || tokenPending || !agents.length} onClick={() => selectedAgent && openToken(selectedAgent)} variant="secondary"><Eye aria-hidden="true" />查看 Token</Button>
            <Button disabled={tokenPending} onClick={() => rotateMutation.mutate()} variant="primary"><RotateCw aria-hidden="true" />{tokenInfo ? "轮换 Token" : "生成 Token"}</Button>
            <Button disabled={!tokenInfo || tokenInfo.tokenStatus !== "active" || tokenPending} onClick={() => revokeMutation.mutate()} variant="destructive"><ShieldOff aria-hidden="true" />吊销 Token</Button>
          </div>
          {tokenQuery.isError && !tokenInfo ? <p className="text-sm text-muted-foreground">当前账户尚未生成 MCP Token。</p> : null}
          {tokenError ? <ErrorAlert>{tokenError}</ErrorAlert> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>智能体列表</CardTitle><p className="mt-1 text-sm text-muted-foreground">选择 Agent 生成包含其 X-Claw-Agent-ID 的 MCP 配置。</p></CardHeader>
        <CardContent>
          {agentsQuery.isError || catalogQuery.isError ? <ErrorAlert>加载智能体接入信息失败</ErrorAlert> : null}
          <MCPAgentTokenTable
            agents={agents}
            isLoading={agentsQuery.isLoading || catalogQuery.isLoading}
            mode="user"
            onDelete={(agent) => { deleteMutation.reset(); setDeletingAgent(agent); }}
            onEdit={(agent) => { updateNameMutation.reset(); setEditingAgent(agent); setEditingName(agent.name); }}
            onOpenGrants={(agent) => { setSelectedAgentId(agent.agentId); setDrawer("grants"); }}
            onOpenToken={openToken}
            tokenActionLabel="令牌详情"
          />
        </CardContent>
      </Card>

      <MCPAgentTokenDrawer
        agent={selectedAgent}
        mode="user"
        onClose={() => { setDrawer(null); revealMutation.reset(); rotateMutation.reset(); }}
        onRevealToken={() => revealMutation.mutate()}
        onRevokeToken={() => revokeMutation.mutate()}
        onRotateToken={() => rotateMutation.mutate()}
        open={drawer === "token"}
        tokenError={tokenError}
        tokenInfo={tokenInfo}
        tokenPending={tokenPending}
        tokenResult={tokenResult}
      />

      <MCPAgentGrantsDrawer agent={selectedAgent} capabilityByID={capabilityByID} grants={grants} mode="user" onClose={() => setDrawer(null)} open={drawer === "grants"} serverByID={serverByID} />

      <Dialog open={Boolean(editingAgent)} onOpenChange={(open) => { if (!open) closeEditDialog(); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>编辑 Agent 名称</DialogTitle></DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); if (editingAgent) updateNameMutation.mutate({ agentId: editingAgent.agentId, name: editingName }); }}>
            <FieldGroup className="gap-4">
              <Field data-disabled><FieldLabel htmlFor="agent-name-agent-id">Agent ID</FieldLabel><Input disabled id="agent-name-agent-id" value={editingAgent?.agentId ?? ""} /></Field>
              <Field><FieldLabel htmlFor="agent-name">Agent 名称</FieldLabel><Input autoFocus disabled={updateNameMutation.isPending} id="agent-name" onChange={(event) => setEditingName(event.target.value)} value={editingName} /></Field>
            </FieldGroup>
            {updateNameMutation.isError ? <ErrorAlert>{updateNameMutation.error.message}</ErrorAlert> : null}
            <DialogFooter><Button disabled={updateNameMutation.isPending} onClick={closeEditDialog} type="button" variant="outline">取消</Button><Button disabled={updateNameMutation.isPending} type="submit" variant="primary">{updateNameMutation.isPending ? "保存中..." : "保存"}</Button></DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        confirmLabel={deleteMutation.isPending ? "删除中..." : "确认删除智能体"}
        description="删除后，该智能体的账号绑定、登录会话和专属运行数据将失效；账户 Token、账户授权和历史审计记录不受影响。此操作无法撤销。"
        error={deleteMutation.isError ? deleteMutation.error.message : undefined}
        onClose={() => { if (!deleteMutation.isPending) { setDeletingAgent(null); deleteMutation.reset(); } }}
        onConfirm={() => deletingAgent && deleteMutation.mutate(deletingAgent)}
        open={Boolean(deletingAgent)}
        pending={deleteMutation.isPending}
        title="确认删除智能体"
        variant="destructive"
      />
    </>
  );
}

function TokenMetadata({ label, value }: { label: string; value: string }) {
  return <div className="grid gap-1"><span className="font-mono text-xs text-muted-foreground">{label}</span><span className="break-all font-mono text-xs">{value}</span></div>;
}

function mapUserAgent(access: AgentAccess): MCPAgent {
  return {
    agentId: access.agent.agentId,
    boundUserId: access.account.userId,
    boundUserName: access.account.name,
    boundUserEmail: access.account.email,
    clientId: access.agent.clientId,
    name: access.agent.name ?? "",
    tenantId: "",
    actorId: access.agent.actorId,
    status: access.agent.status,
    creationSource: access.agent.creationSource,
    collector: access.agent.collector,
    createdAt: "",
    updatedAt: access.agent.updatedAt ?? ""
  };
}

function toAdminTokenInfo(token: AccountTokenInfo | null): MCPAccountTokenInfo | null {
  return token ? { ...token } : null;
}

function toAdminTokenResult(result: AccountTokenSecret | null): MCPAccountTokenResponse | null {
  return result ? { ...result, tokenInfo: { ...result.tokenInfo } } : null;
}

function mapCatalogGrants(upstreams: AgentMCPUpstream[], userId: string): MCPGrant[] {
  return upstreams.flatMap((upstream) => upstream.tools.filter((tool) => tool.authorized).map((tool) => ({
    id: tool.id,
    userId,
    capabilityId: tool.id,
    grantType: "tool",
    dataScope: {},
    expiresAt: tool.authorizationExpiresAt,
    createdBy: "account-grant",
    createdAt: "",
    updatedAt: ""
  })));
}

function mapCatalogCapability(upstream: AgentMCPUpstream, tool: AgentMCPTool): MCPCapability {
  return {
    id: tool.id,
    upstreamServerId: upstream.id,
    type: "tool",
    upstreamName: tool.upstreamName,
    exposedName: tool.exposedName,
    title: tool.title,
    description: tool.description,
    inputSchema: {},
    outputSchema: {},
    annotations: {},
    riskLevel: tool.riskLevel,
    readOnly: true,
    destructive: false,
    idempotent: true,
    approvalRequired: false,
    confirmRequired: tool.confirmRequired,
    confirmTemplate: "",
    status: tool.status,
    schemaHash: "",
    version: "",
    lastSyncedAt: null,
    createdAt: "",
    updatedAt: ""
  };
}

function mapCatalogServer(upstream: AgentMCPUpstream): MCPUpstreamServer {
  return {
    id: upstream.id,
    name: upstream.name,
    domain: upstream.domain,
    transport: upstream.upstreamTransport,
    endpoint: upstream.mcpEndpoint,
    authType: "",
    credentialRef: "",
    ownerTeam: "",
    namespace: upstream.namespace,
    status: upstream.status,
    createdAt: "",
    updatedAt: ""
  };
}
