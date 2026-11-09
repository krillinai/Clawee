import { AlertCircle, CheckCircle2, Edit3, LoaderCircle, Play, Plus, Power, PowerOff, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import {
  ConfirmDialog,
  DataTableShell,
  ErrorAlert,
  LoadingState,
  ModalShell,
  PageHeader,
  PageShell,
  TableStateRow
} from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  createModelGroup,
  createModelUpstreamAccount,
  deleteModelGroup,
  deleteModelUpstreamAccount,
  listModelGroups,
  listModelUpstreamAccounts,
  previewModelUpstreamModels,
  syncModelUpstreamAccount,
  testModelUpstreamAccount,
  updateModelGroup,
  updateModelUpstreamAccount,
  type ModelGroup,
  type ModelUpstreamAccount
} from "@/lib/model-upstream-admin-api";
import { formatDateTime } from "@/lib/mcp-admin-ui";
import { permissions } from "@/lib/rbac-api";

type ModelGatewaySection = "accounts" | "groups";

type AccountForm = {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  manualModels: string;
  syncedModels: string[];
  syncedModelsDirty: boolean;
  modelSyncAt: string | null;
  modelSyncError: string;
  status: "active" | "disabled";
};

type GroupForm = {
  id?: string;
  name: string;
  routeStrategy: "failover" | "round_robin";
  defaultModel: string;
  status: "active" | "disabled";
  accountIds: string[];
};

const emptyAccountForm: AccountForm = {
  name: "",
  baseUrl: "",
  apiKey: "",
  manualModels: "",
  syncedModels: [],
  syncedModelsDirty: false,
  modelSyncAt: null,
  modelSyncError: "",
  status: "active"
};

const emptyGroupForm: GroupForm = {
  name: "",
  routeStrategy: "failover",
  defaultModel: "",
  status: "active",
  accountIds: []
};

const queryKeys = {
  accounts: ["model-upstream-accounts"] as const,
  groups: ["model-upstream-groups"] as const
};

function statusLabel(status: string) {
  return status === "active" ? "启用" : "停用";
}

function statusVariant(status: string) {
  return status === "active" ? "success" : "muted";
}

function mutationError(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function uniqueModels(accounts: Array<{ models: string[] }>) {
  return Array.from(new Set(accounts.flatMap((account) => account.models))).sort();
}

function modelNamesFromText(value: string) {
  return value.split(/[\n,]/).map((model) => model.trim()).filter(Boolean);
}

type TestState = {
  accountId: string;
  accountName: string;
  model: string;
  status: "loading" | "success" | "error";
  reply?: string;
  latencyMs?: number;
  error?: string;
};

export function ModelUpstreamsPage({ section = "accounts" }: { section?: ModelGatewaySection }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canCreate = useAdminPermission(permissions.mcpUpstreamCreate);
  const canUpdate = useAdminPermission(permissions.mcpUpstreamUpdate);
  const canDelete = useAdminPermission(permissions.mcpUpstreamDelete);
  const [accountForm, setAccountForm] = useState<AccountForm | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ kind: "account" | "group"; id: string; name: string } | null>(null);
  const [testState, setTestState] = useState<TestState | null>(null);
  const [previewModels, setPreviewModels] = useState<string[]>([]);
  const [previewStatus, setPreviewStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [previewError, setPreviewError] = useState("");

  const accountsQuery = useQuery({
    queryKey: queryKeys.accounts,
    queryFn: listModelUpstreamAccounts
  });
  const groupsQuery = useQuery({
    queryKey: queryKeys.groups,
    queryFn: listModelGroups
  });

  useEffect(() => {
    if (!accountForm) {
      setPreviewModels([]);
      setPreviewStatus("idle");
      setPreviewError("");
      return;
    }
    const baseUrl = accountForm.baseUrl.trim();
    const apiKey = accountForm.apiKey.trim();
    if (!baseUrl || !apiKey) {
      setPreviewModels([]);
      setPreviewStatus("idle");
      setPreviewError("");
      return;
    }

    let cancelled = false;
    setPreviewStatus("loading");
    setPreviewError("");
    const timer = window.setTimeout(() => {
      previewModelUpstreamModels({ baseUrl, apiKey })
        .then((models) => {
          if (cancelled) return;
          setPreviewModels(models);
          setPreviewStatus("success");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setPreviewModels([]);
          setPreviewStatus("error");
          setPreviewError(mutationError(error));
        });
    }, 500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accountForm?.apiKey, accountForm?.baseUrl]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.accounts }),
      queryClient.invalidateQueries({ queryKey: queryKeys.groups })
    ]);
  };

  const saveAccountMutation = useMutation({
    mutationFn: (form: AccountForm) => {
      const syncedModels = previewStatus === "success" ? previewModels : form.syncedModelsDirty ? form.syncedModels : undefined;
      const input = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        apiKey: form.apiKey,
        syncedModels,
        manualModels: modelNamesFromText(form.manualModels),
        status: form.status
      };
      return form.id ? updateModelUpstreamAccount({ ...input, id: form.id }) : createModelUpstreamAccount(input);
    },
    onSuccess: async () => {
      setAccountForm(null);
      await refresh();
    }
  });

  const saveGroupMutation = useMutation({
    mutationFn: (form: GroupForm) => {
      const input = {
        name: form.name.trim(),
        routeStrategy: form.routeStrategy,
        defaultModel: form.defaultModel.trim(),
        status: form.status,
        accounts: form.accountIds.map((upstreamAccountId, index) => ({ upstreamAccountId, priority: index, weight: 1 }))
      };
      return form.id ? updateModelGroup({ ...input, id: form.id }) : createModelGroup(input);
    },
    onSuccess: async () => {
      setGroupForm(null);
      await refresh();
    }
  });

  const syncMutation = useMutation({
    mutationFn: syncModelUpstreamAccount,
    onSuccess: async (account) => {
      setAccountForm((current) => current?.id === account.id ? {
        ...current,
        syncedModels: account.syncedModels,
        syncedModelsDirty: false,
        modelSyncAt: account.modelSyncAt,
        modelSyncError: account.modelSyncError
      } : current);
      setPreviewModels([]);
      setPreviewStatus("idle");
      setPreviewError("");
      await refresh();
    }
  });

  const testMutation = useMutation({
    mutationFn: (target: { id: string; name: string }) => testModelUpstreamAccount(target.id),
  });

  function startTest(account: ModelUpstreamAccount) {
    const target = { id: account.id, name: account.name };
    testMutation.reset();
    setTestState({
      accountId: account.id,
      accountName: account.name,
      model: account.models[0] ?? "第一个可用模型",
      status: "loading"
    });
    testMutation.mutate(target, {
      onSuccess: (result) => setTestState((current) => current?.accountId === account.id ? { accountId: account.id, accountName: account.name, status: "success", ...result } : current),
      onError: (error) => setTestState((current) => current?.accountId === account.id ? { accountId: account.id, accountName: account.name, model: account.models[0] ?? "第一个可用模型", status: "error", error: mutationError(error) } : current)
    });
  }

  const statusMutation = useMutation({
    mutationFn: (target: { account: ModelUpstreamAccount; status: "active" | "disabled" }) =>
      updateModelUpstreamAccount({
        id: target.account.id,
        name: target.account.name,
        baseUrl: target.account.baseUrl,
        apiKey: "",
        manualModels: target.account.manualModels,
        status: target.status
      }),
    onSuccess: async () => {
      await refresh();
    }
  });

  const deleteMutation = useMutation({
    mutationFn: (target: { kind: "account" | "group"; id: string }) =>
      target.kind === "account" ? deleteModelUpstreamAccount(target.id) : deleteModelGroup(target.id),
    onSuccess: async () => {
      setDeleteTarget(null);
      await refresh();
    }
  });

  const accounts = accountsQuery.data ?? [];
  const groups = groupsQuery.data ?? [];
  const listError = accountsQuery.error || groupsQuery.error;
  const loading = accountsQuery.isLoading || groupsQuery.isLoading;
  const writePending = saveAccountMutation.isPending || saveGroupMutation.isPending || syncMutation.isPending;
  const accountModelCatalog = useMemo(() => {
    if (!accountForm) return [];
    const manualModels = modelNamesFromText(accountForm.manualModels);
    const syncedModels = previewStatus === "success" ? previewModels : accountForm.syncedModels;
    const manualSet = new Set(manualModels);
    return Array.from(new Set([...syncedModels, ...manualModels])).sort().map((model) => ({
      model,
      source: syncedModels.includes(model) && manualSet.has(model) ? "上游 + 手动" : syncedModels.includes(model) ? previewStatus === "success" ? "实时预览" : "已同步" : "手动补充"
    }));
  }, [accountForm, previewModels, previewStatus]);
  const groupsByAccount = useMemo(() => {
    const result = new Map<string, string[]>();
    for (const group of groups) {
      for (const account of group.accounts) {
        result.set(account.upstreamAccountId, [...(result.get(account.upstreamAccountId) ?? []), group.name]);
      }
    }
    return result;
  }, [groups]);

  function openAccount(account?: ModelUpstreamAccount) {
    setPreviewModels([]);
    setPreviewStatus("idle");
    setPreviewError("");
    setAccountForm(account ? {
      id: account.id,
      name: account.name,
      baseUrl: account.baseUrl,
      apiKey: "",
      manualModels: account.manualModels.join("\n"),
      syncedModels: account.syncedModels,
      syncedModelsDirty: false,
      modelSyncAt: account.modelSyncAt,
      modelSyncError: account.modelSyncError,
      status: account.status
    } : { ...emptyAccountForm });
    saveAccountMutation.reset();
    syncMutation.reset();
  }

  function openGroup(group?: ModelGroup) {
    setGroupForm(group ? {
      id: group.id,
      name: group.name,
      routeStrategy: group.routeStrategy,
      defaultModel: group.defaultModel,
      status: group.status,
      accountIds: group.accounts.map((account) => account.upstreamAccountId)
    } : { ...emptyGroupForm });
    saveGroupMutation.reset();
  }

  function removeAccountModel(model: string) {
    setAccountForm((current) => current ? {
      ...current,
      syncedModels: current.syncedModels.filter((item) => item !== model),
      syncedModelsDirty: true,
      manualModels: modelNamesFromText(current.manualModels).filter((item) => item !== model).join("\n")
    } : current);
    setPreviewModels((current) => current.filter((item) => item !== model));
  }

  return (
    <PageShell>
      <PageHeader
        title="模型网关"
        actions={section === "accounts" && canCreate ? <Button onClick={() => openAccount()}><Plus aria-hidden="true" />新增上游账号</Button> : section === "groups" && canCreate ? <Button onClick={() => openGroup()}><Plus aria-hidden="true" />新增模型组</Button> : null}
      >
        先配置上游账号，再将账号加入模型组。模型组向下游客户端提供模型目录，并按配置在上游账号之间故障切换或负载均衡。
      </PageHeader>

      <Tabs value={section} onValueChange={(value) => navigate(`/admin/model-gateway/${value}`)}>
        <TabsList aria-label="模型网关功能">
          <TabsTrigger value="accounts">上游账号 {accounts.length}</TabsTrigger>
          <TabsTrigger value="groups">模型组 {groups.length}</TabsTrigger>
        </TabsList>
      </Tabs>

      {listError ? <ErrorAlert error={listError}>模型网关配置加载失败，请检查服务端数据库连接。</ErrorAlert> : null}
      {statusMutation.error ? <ErrorAlert error={statusMutation.error}>上游账号状态更新失败：{mutationError(statusMutation.error)}</ErrorAlert> : null}
      {loading ? <LoadingState label="模型网关配置加载中" /> : section === "accounts" ? (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>上游账号</CardTitle>
            <p className="text-sm text-muted-foreground">每个账号维护自己的真实模型目录。自动同步来自上游 /models，手动模型用于补充上游未返回的模型。</p>
          </CardHeader>
          <CardContent className="p-0">
            <DataTableShell embedded minWidth={1080}>
              <TableHeader>
                <TableRow>
                  <TableHead>账号</TableHead>
                  <TableHead>接入地址</TableHead>
                  <TableHead>模型目录</TableHead>
                  <TableHead>同步状态</TableHead>
                  <TableHead>所属模型组</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-[250px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.length === 0 ? <TableStateRow colSpan={7}>暂无上游账号，请先新增一个 OpenAI 兼容接入点。</TableStateRow> : accounts.map((account) => (
                  <TableRow key={account.id}>
                    <TableCell>
                      <div className="font-medium">{account.name}</div>
                      <div className="mt-1 font-mono text-xs text-muted-foreground">{account.id}</div>
                    </TableCell>
                    <TableCell className="max-w-[220px] truncate font-mono text-xs" title={account.baseUrl}>{account.baseUrl}</TableCell>
                    <TableCell className="max-w-[300px]">
                      <div className="mb-1 flex flex-wrap gap-1">
                        {account.syncedModels.length ? <Badge variant="outline">自动 {account.syncedModels.length}</Badge> : null}
                        {account.manualModels.length ? <Badge variant="outline">手动 {account.manualModels.length}</Badge> : null}
                        {!account.models.length ? <span className="text-xs text-muted-foreground">暂无模型</span> : null}
                      </div>
                      <div className="max-h-20 overflow-y-auto break-words text-xs text-muted-foreground" title={account.models.join("、")}>{account.models.join("、") || "-"}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={account.modelSyncError ? "danger" : account.modelSyncAt ? "success" : "muted"}>
                        {account.modelSyncError ? "同步失败" : account.modelSyncAt ? "已同步" : "未同步"}
                      </Badge>
                      <div className="mt-1 text-xs text-muted-foreground">{account.modelSyncAt ? formatDateTime(account.modelSyncAt) : "尚未同步"}</div>
                      {account.modelSyncError ? <div className="mt-1 max-w-[180px] truncate text-xs text-destructive" title={account.modelSyncError}>{account.modelSyncError}</div> : null}
                    </TableCell>
                    <TableCell className="text-xs">{groupsByAccount.get(account.id)?.join("、") || <span className="text-muted-foreground">未加入模型组</span>}</TableCell>
                    <TableCell><Badge variant={statusVariant(account.status)}>{statusLabel(account.status)}</Badge></TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                          {canUpdate ? <Button aria-label={`测试 ${account.name} 的上游连接`} disabled={testMutation.isPending} onClick={() => startTest(account)} size="sm" variant="outline"><Play aria-hidden="true" className={testMutation.isPending && testMutation.variables?.id === account.id ? "animate-pulse" : ""} />测试</Button> : null}
                        {canUpdate ? <Button aria-label={`手动同步 ${account.name} 的模型`} disabled={syncMutation.isPending} onClick={() => syncMutation.mutate(account.id)} size="sm" variant="outline"><RefreshCw aria-hidden="true" className={syncMutation.isPending && syncMutation.variables === account.id ? "animate-spin" : ""} />手动同步</Button> : null}
                        {canUpdate ? <Button aria-label={`编辑 ${account.name}`} onClick={() => openAccount(account)} size="sm" variant="secondary"><Edit3 aria-hidden="true" />编辑</Button> : null}
                        {canUpdate ? <Button aria-label={`${account.status === "active" ? "停用" : "启用"} ${account.name}`} disabled={statusMutation.isPending && statusMutation.variables?.account.id === account.id} onClick={() => statusMutation.mutate({ account, status: account.status === "active" ? "disabled" : "active" })} size="sm" variant={account.status === "active" ? "secondary" : "primary"}>{account.status === "active" ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}{account.status === "active" ? "停用" : "启用"}</Button> : null}
                        {canDelete ? <Button aria-label={`删除 ${account.name}`} onClick={() => setDeleteTarget({ kind: "account", id: account.id, name: account.name })} size="sm" variant="destructive"><Trash2 aria-hidden="true" />删除</Button> : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </DataTableShell>
          </CardContent>
        </Card>
      ) : (
        <Card className="shadow-none">
          <CardHeader>
            <CardTitle>模型组</CardTitle>
            <p className="text-sm text-muted-foreground">模型列表由组内上游账号的模型目录去重汇聚生成，组内不单独维护模型。</p>
          </CardHeader>
          <CardContent className="p-0">
            <DataTableShell embedded minWidth={1080}>
              <TableHeader>
                <TableRow>
                  <TableHead>模型组</TableHead>
                  <TableHead>路由策略</TableHead>
                  <TableHead>模型汇聚</TableHead>
                  <TableHead>上游账号</TableHead>
                  <TableHead>默认模型</TableHead>
                  <TableHead>状态</TableHead>
                  <TableHead className="w-[170px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.length === 0 ? <TableStateRow colSpan={7}>暂无模型组，请先配置上游账号再创建模型组。</TableStateRow> : groups.map((group) => {
                  const models = uniqueModels(group.accounts);
                  return (
                    <TableRow key={group.id}>
                      <TableCell>
                        <div className="font-medium">{group.name}</div>
                        <div className="mt-1 font-mono text-xs text-muted-foreground">{group.id}</div>
                      </TableCell>
                      <TableCell>{group.routeStrategy === "round_robin" ? "负载均衡" : "故障切换"}</TableCell>
                      <TableCell className="max-w-[300px]">
                        <div className="mb-1 text-xs font-medium">{models.length} 个模型</div>
                        <div className="max-h-12 overflow-hidden text-xs text-muted-foreground" title={models.join("、")}>{models.join("、") || "暂无模型，请先同步账号"}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {group.accounts.length ? group.accounts.map((account) => <Badge key={account.upstreamAccountId} variant="outline">{account.name}</Badge>) : <span className="text-xs text-muted-foreground">未配置</span>}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{group.defaultModel || "跟随请求"}</TableCell>
                      <TableCell><Badge variant={statusVariant(group.status)}>{statusLabel(group.status)}</Badge></TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {canUpdate ? <Button aria-label={`编辑 ${group.name}`} onClick={() => openGroup(group)} size="sm" variant="secondary"><Edit3 aria-hidden="true" />编辑</Button> : null}
                          {canDelete && group.id !== "default" ? <Button aria-label={`删除 ${group.name}`} onClick={() => setDeleteTarget({ kind: "group", id: group.id, name: group.name })} size="sm" variant="destructive"><Trash2 aria-hidden="true" />删除</Button> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </DataTableShell>
          </CardContent>
        </Card>
      )}

      <ModalShell open={Boolean(testState)} onClose={() => { setTestState(null); testMutation.reset(); }} title={testState ? `上游连接测试 · ${testState.accountName}` : "上游连接测试"} subtitle="已使用该账号的第一个可用模型发送 hello。">
        {testState ? <div className="grid gap-4">
          {testState.status === "loading" ? <div aria-live="polite" className="flex items-center gap-3 rounded-md border border-blue-500/30 bg-blue-500/10 p-4" role="status">
            <LoaderCircle aria-hidden="true" className="size-5 shrink-0 animate-spin text-blue-500" />
            <div className="min-w-0"><div className="font-medium">正在测试上游连接</div><div className="mt-1 text-sm text-muted-foreground">正在使用 {testState.model} 发送 hello，请等待上游响应。</div></div>
          </div> : null}
          {testState.status === "success" ? <div aria-live="polite" className="flex items-center gap-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-4" role="status">
            <CheckCircle2 aria-hidden="true" className="size-5 shrink-0 text-emerald-500" />
            <div><div className="font-medium">上游连接成功</div><div className="mt-1 text-sm text-muted-foreground">已收到上游模型的文本回复。</div></div>
          </div> : null}
          {testState.status === "error" ? <div aria-live="assertive" className="flex items-start gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-4" role="alert">
            <AlertCircle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-red-500" />
            <div><div className="font-medium">上游连接测试失败</div><div className="mt-1 break-words text-sm text-muted-foreground">{testState.error}</div></div>
          </div> : null}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border border-border bg-muted/20 p-3"><div className="text-xs text-muted-foreground">测试模型</div><div className="mt-1 font-mono text-sm">{testState.model}</div></div>
            <div className="rounded-md border border-border bg-muted/20 p-3"><div className="text-xs text-muted-foreground">响应耗时</div><div className="mt-1 text-sm">{testState.status === "loading" ? "等待中…" : testState.latencyMs !== undefined ? `${testState.latencyMs} ms` : "-"}</div></div>
          </div>
          {testState.status === "loading" ? <div className="min-h-24 rounded-md border border-dashed border-border bg-muted/10 p-4 text-sm text-muted-foreground">请求已经发出，正在等待上游返回结果…</div> : null}
          {testState.status === "success" ? <div className="grid gap-2"><Label>上游回复</Label><div className="min-h-24 whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 p-3 text-sm">{testState.reply}</div></div> : null}
          <div className="flex justify-end"><Button onClick={() => { setTestState(null); testMutation.reset(); }} type="button">关闭</Button></div>
        </div> : null}
      </ModalShell>

      <ModalShell open={Boolean(accountForm)} onClose={() => setAccountForm(null)} title={accountForm?.id ? "编辑上游账号" : "新增上游账号"} subtitle="密钥只用于服务端请求上游，不会回显到页面。">
        {accountForm ? <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); saveAccountMutation.mutate(accountForm); }}>
          <div className="grid gap-2"><Label htmlFor="model-upstream-name">账号名称</Label><Input id="model-upstream-name" value={accountForm.name} onChange={(event) => setAccountForm({ ...accountForm, name: event.target.value })} placeholder="例如：主力模型账号" required /></div>
          <div className="grid gap-2"><Label htmlFor="model-upstream-base-url">Base URL</Label><Input id="model-upstream-base-url" value={accountForm.baseUrl} onChange={(event) => setAccountForm({ ...accountForm, baseUrl: event.target.value })} placeholder="https://api.example.com/v1" required /></div>
          <div className="grid gap-2"><Label htmlFor="model-upstream-api-key">API Key{accountForm.id ? "（留空表示保持原密钥）" : ""}</Label><Input id="model-upstream-api-key" type="password" value={accountForm.apiKey} onChange={(event) => setAccountForm({ ...accountForm, apiKey: event.target.value })} placeholder={accountForm.id ? "留空保持原密钥" : "sk-..."} required={!accountForm.id} /></div>
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-3">
              <Label>上游支持的模型</Label>
              <div className="flex items-center gap-2">
                {previewStatus === "loading" ? <span className="text-xs text-muted-foreground">正在获取上游模型...</span> : null}
                {previewStatus === "success" ? <span className="text-xs text-emerald-600">已实时获取 {previewModels.length} 个模型</span> : null}
                {previewStatus === "error" ? <span className="text-xs text-destructive">模型列表获取失败</span> : null}
                {previewStatus === "idle" && accountForm.modelSyncAt ? <span className="text-xs text-muted-foreground">最近同步：{formatDateTime(accountForm.modelSyncAt)}</span> : null}
                {accountForm.id ? <Button aria-label="手动同步模型" disabled={syncMutation.isPending} onClick={() => { if (accountForm.id) syncMutation.mutate(accountForm.id); }} size="sm" type="button" variant="outline"><RefreshCw aria-hidden="true" className={syncMutation.isPending ? "animate-spin" : ""} />手动同步</Button> : null}
              </div>
            </div>
            <div className="max-h-56 overflow-y-auto border border-border bg-muted/20 p-3">
              {accountModelCatalog.length ? <div className="grid gap-2 sm:grid-cols-2">{accountModelCatalog.map((item) => <div className="flex min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 py-2" key={item.model}><span className="min-w-0 truncate font-mono text-xs" title={item.model}>{item.model}</span><div className="flex shrink-0 items-center gap-1"><Badge variant="outline">{item.source}</Badge><Button aria-label={`删除模型 ${item.model}`} onClick={() => removeAccountModel(item.model)} size="icon" type="button" variant="ghost"><Trash2 aria-hidden="true" /></Button></div></div>)}</div> : <p className="text-sm text-muted-foreground">输入 Base URL 和 API Key 后，将立即从上游 /models 获取真实模型列表。</p>}
            </div>
            {accountModelCatalog.length ? <p className="text-xs text-muted-foreground">删除模型后点击“保存账号”使目录变更生效。</p> : null}
            {syncMutation.error ? <ErrorAlert error={syncMutation.error}>模型手动同步失败：{mutationError(syncMutation.error)}</ErrorAlert> : null}
            {previewStatus === "error" ? <p className="text-xs text-destructive">{previewError || "请检查 Base URL、API Key 和上游接口是否可用。"}</p> : null}
            {accountForm.modelSyncError && previewStatus === "idle" ? <p className="text-xs text-destructive">最近一次同步失败：{accountForm.modelSyncError}</p> : null}
          </div>
          <div className="grid gap-2"><Label htmlFor="model-upstream-manual-models">手动补充模型（可选）</Label><Textarea id="model-upstream-manual-models" rows={4} value={accountForm.manualModels} onChange={(event) => setAccountForm({ ...accountForm, manualModels: event.target.value })} placeholder="每行一个模型，例如 clawee-vision\n也支持逗号分隔" /><p className="text-xs text-muted-foreground">仅用于补充上游未返回的模型；保存时不会再次请求上游。</p></div>
          <div className="grid gap-2"><Label htmlFor="model-upstream-status">状态</Label><NativeSelect id="model-upstream-status" value={accountForm.status} onChange={(event) => setAccountForm({ ...accountForm, status: event.target.value as AccountForm["status"] })}><option value="active">启用</option><option value="disabled">停用</option></NativeSelect></div>
          {saveAccountMutation.error ? <ErrorAlert error={saveAccountMutation.error}>上游账号保存失败：{mutationError(saveAccountMutation.error)}</ErrorAlert> : null}
          <div className="flex justify-end gap-2"><Button onClick={() => setAccountForm(null)} type="button" variant="outline">取消</Button><Button disabled={writePending} type="submit">{saveAccountMutation.isPending ? "保存中..." : "保存账号"}</Button></div>
        </form> : null}
      </ModalShell>

      <ModalShell open={Boolean(groupForm)} onClose={() => setGroupForm(null)} title={groupForm?.id ? "编辑模型组" : "新增模型组"} subtitle="组内账号共同提供模型目录；请求会按策略在支持目标模型的账号之间路由。">
        {groupForm ? <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); saveGroupMutation.mutate(groupForm); }}>
          <div className="grid gap-2"><Label htmlFor="model-group-name">模型组名称</Label><Input id="model-group-name" value={groupForm.name} onChange={(event) => setGroupForm({ ...groupForm, name: event.target.value })} placeholder="例如：生产模型组" required /></div>
          <div className="grid gap-2"><Label htmlFor="model-group-strategy">路由策略</Label><NativeSelect id="model-group-strategy" value={groupForm.routeStrategy} onChange={(event) => setGroupForm({ ...groupForm, routeStrategy: event.target.value as GroupForm["routeStrategy"] })}><option value="failover">故障切换</option><option value="round_robin">负载均衡</option></NativeSelect></div>
          <div className="grid gap-2"><Label htmlFor="model-group-default-model">默认模型（可选）</Label><Input id="model-group-default-model" value={groupForm.defaultModel} onChange={(event) => setGroupForm({ ...groupForm, defaultModel: event.target.value })} placeholder="留空表示跟随客户端请求" /></div>
          <div className="grid gap-2"><Label>加入上游账号</Label>{accounts.length ? <div className="grid gap-2 border border-border p-3">{accounts.map((account) => <label className="flex items-start gap-3 px-2 py-2 hover:bg-muted/40" key={account.id}><input checked={groupForm.accountIds.includes(account.id)} className="mt-1 size-4" onChange={(event) => setGroupForm({ ...groupForm, accountIds: event.target.checked ? [...groupForm.accountIds, account.id] : groupForm.accountIds.filter((id) => id !== account.id) })} type="checkbox" /><span className="min-w-0"><span className="block text-sm font-medium">{account.name}</span><span className="block truncate font-mono text-xs text-muted-foreground">{account.models.length} 个模型 · {account.baseUrl}</span></span></label>)}</div> : <p className="border border-dashed border-border p-4 text-sm text-muted-foreground">请先创建上游账号，再添加到模型组。</p>}</div>
          <div className="grid gap-2"><Label htmlFor="model-group-status">状态</Label><NativeSelect id="model-group-status" value={groupForm.status} onChange={(event) => setGroupForm({ ...groupForm, status: event.target.value as GroupForm["status"] })}><option value="active">启用</option><option value="disabled">停用</option></NativeSelect></div>
          {saveGroupMutation.error ? <ErrorAlert error={saveGroupMutation.error}>模型组保存失败：{mutationError(saveGroupMutation.error)}</ErrorAlert> : null}
          <div className="flex justify-end gap-2"><Button onClick={() => setGroupForm(null)} type="button" variant="outline">取消</Button><Button disabled={writePending || accounts.length === 0} type="submit">{saveGroupMutation.isPending ? "保存中..." : "保存模型组"}</Button></div>
        </form> : null}
      </ModalShell>

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={deleteTarget?.kind === "account" ? "删除上游账号" : "删除模型组"}
        description={`确定删除“${deleteTarget?.name ?? ""}”吗？${deleteTarget?.kind === "account" ? "删除后它会从所属模型组中移除。" : "用户已绑定该组时，后续请求会重新选择可用模型组。"}`}
        confirmLabel="确认删除"
        variant="destructive"
        pending={deleteMutation.isPending}
        error={deleteMutation.error ? mutationError(deleteMutation.error) : undefined}
        onClose={() => { if (!deleteMutation.isPending) setDeleteTarget(null); }}
        onConfirm={() => { if (deleteTarget) deleteMutation.mutate({ kind: deleteTarget.kind, id: deleteTarget.id }); }}
      />
    </PageShell>
  );
}
