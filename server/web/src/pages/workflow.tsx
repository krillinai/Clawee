import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowLeft, ArrowUp, Check, ChevronsUpDown, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useAdminPermission } from "@/components/admin-permissions";
import { ConfirmDialog, DataTableShell, DetailDrawer, EmptyState, ErrorAlert, FilterRow, FilterSelect, LoadingState, PageHeader, PageShell, TableStateRow } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { permissions } from "@/lib/rbac-api";
import { workflowAdmin, type WorkflowAssignee, type WorkflowInstance, type WorkflowNode, type WorkflowTemplate } from "@/lib/workflow-api";

const emptyTemplate = (): WorkflowTemplate => ({ id: "", name: "", description: "", status: "draft", revision: 0, nodes: [], created_at: "" });
const nodeID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const statusNames: Record<string, string> = { draft: "草稿", enabled: "已启用", disabled: "已停用", running: "运行中", succeeded: "已完成", rejected: "已驳回", terminated: "已终止", pending: "待处理", completed: "已完成", cancelled: "已取消" };
const statusVariants = { draft: "muted", enabled: "success", disabled: "muted", running: "accent", succeeded: "success", rejected: "warning", terminated: "danger", pending: "warning", completed: "success", cancelled: "muted" } as const;
const message = (error: unknown) => error instanceof Error ? error.message : "操作失败";
function StatusBadge({ status }: { status: string }) {
  return <Badge variant={statusVariants[status as keyof typeof statusVariants] ?? "outline"}>{statusNames[status] ?? status}</Badge>;
}
function assigneeName(account?: WorkflowAssignee) {
  return account?.name || account?.email || "未命名账号";
}
function nodeError(nodes: WorkflowNode[]) {
  if (nodes.length === 0) return { index: 0, message: "至少添加一个节点" };
  for (const [index, node] of nodes.entries()) {
    if (!node.title.trim()) return { index, message: `节点 ${index + 1}：请填写标题` };
    if (!node.instruction.trim()) return { index, message: `节点 ${index + 1}：请填写说明 / 任务指令` };
    if (!node.assignee_user_id) return { index, message: `节点 ${index + 1}：请选择负责人` };
  }
  return null;
}

function WorkflowSteps({ nodes, instance }: { nodes: WorkflowNode[]; instance?: WorkflowInstance }) {
  return <ol className="space-y-0">
    {nodes.map((node, index) => {
      const task = instance?.tasks?.find((item) => item.node_id === node.node_id);
      return <li className="relative flex gap-4 pb-5 last:pb-0" key={node.node_id}>
        {index < nodes.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-8 w-px bg-border" />}
        <span className="z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-background text-xs font-medium">{index + 1}</span>
        <div className="min-w-0 flex-1 border-b pb-4 last:border-0">
          <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{node.title || `节点 ${index + 1}`}</strong><Badge variant="outline">{node.type === "agent" ? "Agent" : "审批"}</Badge>{task && <StatusBadge status={task.status} />}{instance?.current_node_id === node.node_id && <Badge variant="accent">当前节点</Badge>}</div>
          <p className="mt-1 break-words text-xs leading-5 text-muted-foreground">负责人：{node.assignee_user_id} · {node.instruction}</p>
          {task && <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><span className="text-muted-foreground">输入</span><pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/40 p-2">{JSON.stringify(task.input, null, 2)}</pre></div>{task.output && <div><span className="text-muted-foreground">输出</span><pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/40 p-2">{JSON.stringify(task.output, null, 2)}</pre></div>}{task.decision && <p>审批：{task.decision === "approve" ? "批准" : "驳回"} {task.comment}</p>}{task.completed_at && <p>处理人：{task.handled_by || task.assignee_user_id} · {new Date(task.completed_at).toLocaleString()}</p>}</div>}
        </div>
      </li>;
    })}
  </ol>;
}

function AssigneePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const cache = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const selected = useQuery({ queryKey: ["workflow-assignees", value], queryFn: () => workflowAdmin.assignees(value), enabled: Boolean(value) });
  const candidates = useQuery({ queryKey: ["workflow-assignees", query], queryFn: () => workflowAdmin.assignees(query), enabled: open });
  const account = selected.data?.items.find((item) => item.user_id === value);
  return <Popover open={open} onOpenChange={(next) => { setOpen(next); if (!next) { setSearch(""); setQuery(""); } }}>
    <PopoverTrigger asChild><Button aria-label="选择负责人" className="w-full justify-between" type="button" variant="outline">
      <span className="truncate">{value ? account ? assigneeName(account) : selected.isLoading ? "正在查询负责人..." : selected.isError ? "负责人查询失败" : "账号已停用或不存在" : "搜索并选择负责人"}</span>
      <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0" />
    </Button></PopoverTrigger>
    <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
      <Command shouldFilter={false}>
        <CommandInput aria-label="搜索负责人" onValueChange={setSearch} placeholder="搜索姓名、邮箱或账号 ID" value={search} />
        <CommandList>
          <CommandEmpty>{candidates.isFetching ? "正在查询成员..." : candidates.isError ? "成员查询失败" : "没有匹配的成员"}</CommandEmpty>
          <CommandGroup heading="成员">
            {candidates.data?.items.map((item) => <CommandItem key={item.user_id} onSelect={() => { cache.setQueryData(["workflow-assignees", item.user_id], { items: [item], meta: { next_cursor: "" } }); onChange(item.user_id); setOpen(false); setSearch(""); }} value={item.user_id}>
              <div className="min-w-0 flex-1"><span className="block truncate font-medium">{assigneeName(item)}</span><span className="block truncate text-xs text-muted-foreground">{item.email} · {item.user_id}</span></div>
              {item.user_id === value && <Check aria-hidden="true" className="size-4" />}
            </CommandItem>)}
          </CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}

export function WorkflowTemplatesPage() {
  const [cursor, setCursor] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const templates = useQuery({ queryKey: ["workflow-templates", cursor], queryFn: () => workflowAdmin.templates(cursor) });
  const assigneeIds = [...new Set(templates.data?.items.map((item) => item.nodes[0]?.assignee_user_id).filter((id): id is string => Boolean(id)) ?? [])];
  const assignees = useQueries({ queries: assigneeIds.map((id) => ({ queryKey: ["workflow-assignees", id], queryFn: () => workflowAdmin.assignees(id) })) });
  const names = new Map(assigneeIds.map((id, index) => {
    const lookup = assignees[index];
    const account = assignees[index]?.data?.items.find((item) => item.user_id === id);
    return [id, lookup?.isLoading ? "正在查询..." : lookup?.isError ? "负责人查询失败" : account ? assigneeName(account) : "账号已停用或不存在"];
  }));

  return <PageShell><PageHeader title="工作流模板" actions={<Button asChild><Link to="/admin/workflow-templates/new"><Plus className="size-4" />新建模板</Link></Button>} />
    <DataTableShell dense minWidth={700}>
      <TableHeader><TableRow><TableHead>名称</TableHead><TableHead>状态</TableHead><TableHead>版本</TableHead><TableHead>节点数</TableHead><TableHead>首节点负责人</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
      <TableBody>
        {templates.isLoading && <TableStateRow colSpan={6}><LoadingState label="正在加载工作流模板" /></TableStateRow>}
        {templates.isError && <TableStateRow colSpan={6} tone="danger"><ErrorAlert error={templates.error}>模板加载失败：{message(templates.error)}</ErrorAlert></TableStateRow>}
        {!templates.isLoading && !templates.isError && !templates.data?.items.length && <TableStateRow colSpan={6}><EmptyState title="暂无工作流模板" /></TableStateRow>}
        {templates.data?.items.map((item) => <TableRow key={item.id}>
          <TableCell className="max-w-64 font-medium"><span className="block truncate" title={item.name}>{item.name}</span></TableCell>
          <TableCell><StatusBadge status={item.status} /></TableCell><TableCell>{item.revision}</TableCell><TableCell>{item.nodes.length}</TableCell>
          <TableCell className="max-w-48 truncate text-muted-foreground" title={names.get(item.nodes[0]?.assignee_user_id)}>{item.nodes[0]?.assignee_user_id ? names.get(item.nodes[0].assignee_user_id) : "未配置"}</TableCell>
          <TableCell className="text-right"><Button asChild size="sm" variant="secondary"><Link aria-label={`编辑${item.name}，版本 ${item.revision}`} to={`/admin/workflow-templates/${encodeURIComponent(item.id)}`}>编辑</Link></Button></TableCell>
        </TableRow>)}
      </TableBody>
    </DataTableShell>
    {(templates.data?.meta.next_cursor || history.length > 0) && <div className="flex gap-2"><Button disabled={!history.length} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }} size="sm" variant="outline">上一页</Button><Button disabled={!templates.data?.meta.next_cursor} onClick={() => { setHistory([...history, cursor]); setCursor(templates.data!.meta.next_cursor); }} size="sm" variant="outline">下一页</Button></div>}
  </PageShell>;
}

export function WorkflowTemplateEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [form, setForm] = useState<WorkflowTemplate | null>(null);
  const [selectedNode, setSelectedNode] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const detail = useQuery({ queryKey: ["workflow-template", id], queryFn: () => workflowAdmin.template(id!), enabled: Boolean(id) });
  useEffect(() => { setForm(id ? null : emptyTemplate()); }, [id]);
  useEffect(() => { if (detail.data) { setForm(detail.data); setSelectedNode(0); } }, [detail.data]);

  const update = (nodes: WorkflowNode[]) => setForm((current) => current && ({ ...current, nodes: nodes.map((node, order) => ({ ...node, order })) }));
  const editNode = (patch: Partial<WorkflowNode>) => { if (!form) return; update(form.nodes.map((node, index) => index === selectedNode ? { ...node, ...patch } : node)); };
  const move = (direction: number) => { if (!form) return; const other = selectedNode + direction; if (other < 0 || other >= form.nodes.length) return; const nodes = [...form.nodes]; [nodes[selectedNode], nodes[other]] = [nodes[other], nodes[selectedNode]]; update(nodes); setSelectedNode(other); };
  async function save(event: FormEvent) {
    event.preventDefault(); if (!form || busy) return;
    const invalid = form.status === "enabled" ? nodeError(form.nodes) : null;
    if (invalid) { setSelectedNode(invalid.index); setError(invalid.message); return; }
    setBusy(true); setError("");
    try { const saved = await workflowAdmin.save({ id: form.id || undefined, name: form.name, description: form.description, nodes: form.nodes, expected_revision: form.revision }); setForm(saved); void cache.invalidateQueries({ queryKey: ["workflow-templates"] }); void cache.invalidateQueries({ queryKey: ["workflow-template", saved.id] }); if (!id) navigate(`/admin/workflow-templates/${encodeURIComponent(saved.id)}`, { replace: true }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function toggle() {
    if (!form || !form.id || busy) return;
    const invalid = form.status !== "enabled" ? nodeError(form.nodes) : null;
    if (invalid) { setSelectedNode(invalid.index); setError(invalid.message); return; }
    setBusy(true); setError("");
    try { const updated = await workflowAdmin.status(form.id, form.status !== "enabled"); setForm(updated); void cache.invalidateQueries({ queryKey: ["workflow-templates"] }); void cache.invalidateQueries({ queryKey: ["workflow-template", form.id] }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }

  return <PageShell><PageHeader title={id ? "编辑工作流模板" : "新建工作流模板"} actions={<Button asChild variant="outline"><Link to="/admin/workflow-templates"><ArrowLeft className="size-4" />返回列表</Link></Button>} />
    {detail.isLoading && <LoadingState label="正在加载模板配置" />}
    {detail.isError && <ErrorAlert error={detail.error}>模板配置加载失败：{message(detail.error)}</ErrorAlert>}
    {form && <form className="min-w-0 space-y-5" onSubmit={save}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex min-w-0 flex-wrap items-center gap-2"><h2 className="break-all text-base font-semibold">{form.id ? form.name : "新模板"}</h2><StatusBadge status={form.status} /></div><div className="flex gap-2"><Button disabled={busy} type="submit"><Save className="size-4" />保存</Button>{form.id && <Button disabled={busy} onClick={toggle} type="button" variant="outline">{form.status === "enabled" ? "停用" : "启用"}</Button>}</div></div>
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">名称<Input maxLength={128} onChange={(e) => setForm({ ...form, name: e.target.value })} required value={form.name} /></label><label className="grid gap-1 text-sm">描述<Input onChange={(e) => setForm({ ...form, description: e.target.value })} value={form.description} /></label></div>
        <div className="grid gap-5 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]"><section className="min-w-0"><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">执行顺序</h3><Button aria-label="添加节点" onClick={() => { update([...form.nodes, { node_id: nodeID(), order: form.nodes.length, type: "agent", title: "", assignee_user_id: "", instruction: "" }]); setSelectedNode(form.nodes.length); }} size="icon" title="添加节点" type="button" variant="outline"><Plus className="size-4" /></Button></div>
          <ol className="space-y-2">{form.nodes.map((node, index) => <li key={node.node_id}><button aria-current={selectedNode === index ? "step" : undefined} className={`flex w-full items-center gap-3 rounded-md border p-2 text-left text-sm hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedNode === index ? "border-primary bg-accent/60" : "border-border bg-card"}`} onClick={() => setSelectedNode(index)} type="button"><span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-background text-xs">{index + 1}</span><span className="min-w-0 truncate">{node.title || "未命名节点"}</span><Badge className="ml-auto shrink-0" variant="outline">{node.type === "agent" ? "Agent" : "审批"}</Badge></button></li>)}</ol>
        </section>
        {form.nodes[selectedNode] && <section className="min-w-0 space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">节点配置</h3><div className="flex gap-1"><Button aria-label="上移节点" disabled={selectedNode === 0} onClick={() => move(-1)} size="icon" title="上移节点" type="button" variant="ghost"><ArrowUp className="size-4" /></Button><Button aria-label="下移节点" disabled={selectedNode === form.nodes.length - 1} onClick={() => move(1)} size="icon" title="下移节点" type="button" variant="ghost"><ArrowDown className="size-4" /></Button><Button aria-label="删除节点" onClick={() => { update(form.nodes.filter((_, i) => i !== selectedNode)); setSelectedNode(Math.max(0, selectedNode - 1)); }} size="icon" title="删除节点" type="button" variant="ghost"><Trash2 className="size-4" /></Button></div></div>
          <label className="grid gap-1 text-sm">类型<NativeSelect onChange={(e) => editNode({ type: e.target.value as WorkflowNode["type"] })} value={form.nodes[selectedNode].type}><option value="agent">Agent 执行</option><option value="approval">审批</option></NativeSelect></label>
          <label className="grid gap-1 text-sm">标题<Input onChange={(e) => editNode({ title: e.target.value })} value={form.nodes[selectedNode].title} /></label>
          <div className="grid gap-1 text-sm"><span>负责人</span><AssigneePicker onChange={(assignee_user_id) => editNode({ assignee_user_id })} value={form.nodes[selectedNode].assignee_user_id} /></div>
          <label className="grid gap-1 text-sm">说明 / 任务指令<Textarea onChange={(e) => editNode({ instruction: e.target.value })} rows={5} value={form.nodes[selectedNode].instruction} /></label>
        </section>}</div>
      </form>}
  </PageShell>;
}

export function WorkflowInstancesPage() {
  const canTerminate = useAdminPermission(permissions.workflowInstanceTerminate);
  const cache = useQueryClient();
  const [status, setStatus] = useState("all");
  const [cursor, setCursor] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const instances = useQuery({ queryKey: ["workflow-instances", status, cursor], queryFn: () => workflowAdmin.instances(status, cursor) });
  const detail = useQuery({ queryKey: ["workflow-instance", selectedID], queryFn: () => workflowAdmin.instance(selectedID!), enabled: Boolean(selectedID) });
  async function terminate() {
    if (!selectedID || !reason.trim()) return;
    setBusy(true); setError("");
    try { await workflowAdmin.terminate(selectedID, reason); setReason(""); setConfirmOpen(false); void cache.invalidateQueries({ queryKey: ["workflow-instances"] }); void cache.invalidateQueries({ queryKey: ["workflow-instance", selectedID] }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <PageShell><PageHeader title="工作流实例" />
    <FilterRow><FilterSelect ariaLabel="状态筛选" value={status} onChange={(value) => { setStatus(value); setCursor(""); setHistory([]); }}><option value="all">全部状态</option>{["running", "succeeded", "rejected", "terminated"].map((value) => <option key={value} value={value}>{statusNames[value]}</option>)}</FilterSelect></FilterRow>
    <DataTableShell dense minWidth={800}>
      <TableHeader><TableRow><TableHead>实例 ID</TableHead><TableHead>首节点</TableHead><TableHead>状态</TableHead><TableHead>发起人</TableHead><TableHead>开始时间</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
      <TableBody>
        {instances.isLoading && <TableStateRow colSpan={6}><LoadingState label="正在加载工作流实例" /></TableStateRow>}
        {instances.isError && <TableStateRow colSpan={6} tone="danger"><ErrorAlert error={instances.error}>实例加载失败：{message(instances.error)}</ErrorAlert></TableStateRow>}
        {!instances.isLoading && !instances.isError && !instances.data?.items.length && <TableStateRow colSpan={6}><EmptyState title="暂无工作流实例" /></TableStateRow>}
        {instances.data?.items.map((item) => <TableRow data-state={selectedID === item.id ? "selected" : undefined} key={item.id}>
          <TableCell className="max-w-48 truncate font-mono text-xs" title={item.id}>{item.id}</TableCell>
          <TableCell className="max-w-56 truncate font-medium" title={item.nodes[0]?.title}>{item.nodes[0]?.title || "未命名节点"}</TableCell>
          <TableCell><StatusBadge status={item.status} /></TableCell>
          <TableCell className="max-w-40 truncate" title={item.started_by}>{item.started_by}</TableCell>
          <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(item.started_at).toLocaleString()}</TableCell>
          <TableCell className="text-right"><Button aria-label={`查看实例 ${item.id} 详情`} onClick={() => { setSelectedID(item.id); setError(""); }} size="sm" variant="secondary">查看详情</Button></TableCell>
        </TableRow>)}
      </TableBody>
    </DataTableShell>
    {(instances.data?.meta.next_cursor || history.length > 0) && <div className="flex gap-2"><Button disabled={!history.length} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }} size="sm" variant="outline">上一页</Button><Button disabled={!instances.data?.meta.next_cursor} onClick={() => { setHistory([...history, cursor]); setCursor(instances.data!.meta.next_cursor); }} size="sm" variant="outline">下一页</Button></div>}
    <DetailDrawer contextLabel="工作流实例" onClose={() => { setSelectedID(null); setReason(""); setError(""); }} open={Boolean(selectedID)} subtitle={detail.data ? `模板版本 ${detail.data.template_revision} · 发起人 ${detail.data.started_by}` : "实例详情"} title="实例详情" titleAction={detail.data && <StatusBadge status={detail.data.status} />}>
      {detail.isLoading && <LoadingState label="正在加载实例详情" />}
      {detail.isError && <ErrorAlert error={detail.error}>实例详情加载失败：{message(detail.error)}</ErrorAlert>}
      {detail.data && <><p className="break-all font-mono text-xs text-muted-foreground">实例 ID：{detail.data.id}</p><WorkflowSteps nodes={detail.data.nodes} instance={detail.data} />{canTerminate && detail.data.status === "running" && <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row"><Input aria-label="终止原因" onChange={(e) => setReason(e.target.value)} placeholder="终止原因" value={reason} /><Button disabled={busy || !reason.trim()} onClick={() => setConfirmOpen(true)} variant="destructive">终止实例</Button></div>}{error && !confirmOpen && <ErrorAlert>{error}</ErrorAlert>}</>}
    </DetailDrawer>
    <ConfirmDialog open={confirmOpen} title="终止工作流实例" description="终止后将无法继续执行，确定要终止此实例吗？" confirmLabel="确认终止" variant="destructive" pending={busy} error={error} onClose={() => { setConfirmOpen(false); setError(""); }} onConfirm={terminate} />
  </PageShell>;
}
