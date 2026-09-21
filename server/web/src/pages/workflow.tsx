import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { useAdminPermission } from "@/components/admin-permissions";
import { ErrorAlert, PageHeader, PageShell } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { permissions } from "@/lib/rbac-api";
import { workflowAdmin, type WorkflowInstance, type WorkflowNode, type WorkflowTemplate } from "@/lib/workflow-api";

const emptyTemplate = (): WorkflowTemplate => ({ id: "", name: "", description: "", status: "draft", revision: 0, nodes: [], created_at: "" });
const nodeID = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
const statusNames: Record<string, string> = { draft: "草稿", enabled: "已启用", disabled: "已停用", running: "运行中", succeeded: "已完成", rejected: "已驳回", terminated: "已终止", pending: "待处理", completed: "已完成", cancelled: "已取消" };
const message = (error: unknown) => error instanceof Error ? error.message : "操作失败";
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
          <div className="flex flex-wrap items-center gap-2"><strong className="text-sm">{node.title || `节点 ${index + 1}`}</strong><Badge variant="outline">{node.type === "agent" ? "Agent" : "审批"}</Badge>{task && <Badge variant="secondary">{statusNames[task.status]}</Badge>}{instance?.current_node_id === node.node_id && <Badge>当前节点</Badge>}</div>
          <p className="mt-1 text-xs text-muted-foreground">负责人：{node.assignee_user_id} · {node.instruction}</p>
          {task && <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><span className="text-muted-foreground">输入</span><pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/40 p-2">{JSON.stringify(task.input, null, 2)}</pre></div>{task.output && <div><span className="text-muted-foreground">输出</span><pre className="mt-1 overflow-auto whitespace-pre-wrap break-all rounded border bg-muted/40 p-2">{JSON.stringify(task.output, null, 2)}</pre></div>}{task.decision && <p>审批：{task.decision === "approve" ? "批准" : "驳回"} {task.comment}</p>}{task.completed_at && <p>处理人：{task.handled_by || task.assignee_user_id} · {new Date(task.completed_at).toLocaleString()}</p>}</div>}
        </div>
      </li>;
    })}
  </ol>;
}

export function WorkflowTemplatesPage() {
  const cache = useQueryClient();
  const [cursor, setCursor] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [selectedID, setSelectedID] = useState<string | null>(null);
  const [form, setForm] = useState<WorkflowTemplate | null>(null);
  const [selectedNode, setSelectedNode] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [assigneeQuery, setAssigneeQuery] = useState("");
  const templates = useQuery({ queryKey: ["workflow-templates", cursor], queryFn: () => workflowAdmin.templates(cursor) });
  const detail = useQuery({ queryKey: ["workflow-template", selectedID], queryFn: () => workflowAdmin.template(selectedID!), enabled: Boolean(selectedID) });
  const assignees = useQuery({ queryKey: ["workflow-assignees", assigneeQuery], queryFn: () => workflowAdmin.assignees(assigneeQuery) });
  useEffect(() => { if (detail.data) { setForm(detail.data); setSelectedNode(0); } }, [detail.data]);

  const update = (nodes: WorkflowNode[]) => setForm((current) => current && ({ ...current, nodes: nodes.map((node, order) => ({ ...node, order })) }));
  const editNode = (patch: Partial<WorkflowNode>) => { if (!form) return; update(form.nodes.map((node, index) => index === selectedNode ? { ...node, ...patch } : node)); };
  const move = (direction: number) => { if (!form) return; const other = selectedNode + direction; if (other < 0 || other >= form.nodes.length) return; const nodes = [...form.nodes]; [nodes[selectedNode], nodes[other]] = [nodes[other], nodes[selectedNode]]; update(nodes); setSelectedNode(other); };
  async function save(event: FormEvent) {
    event.preventDefault(); if (!form || busy) return;
    const invalid = form.status === "enabled" ? nodeError(form.nodes) : null;
    if (invalid) { setSelectedNode(invalid.index); setError(invalid.message); return; }
    setBusy(true); setError("");
    try { const saved = await workflowAdmin.save({ id: form.id || undefined, name: form.name, description: form.description, nodes: form.nodes, expected_revision: form.revision }); setSelectedID(saved.id); setForm(saved); void cache.invalidateQueries({ queryKey: ["workflow-templates"] }); void cache.invalidateQueries({ queryKey: ["workflow-template", saved.id] }); }
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

  return <PageShell><PageHeader title="工作流模板" actions={<Button onClick={() => { setSelectedID(null); setForm(emptyTemplate()); setSelectedNode(0); setError(""); }}><Plus className="size-4" />新建模板</Button>} />
    <div className="grid gap-6 xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
      <section className="min-w-0 border-r pr-4"><h2 className="mb-3 text-sm font-semibold">模板</h2>{templates.isError && <ErrorAlert>{message(templates.error)}</ErrorAlert>}{templates.isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}
        <div className="grid gap-1">{templates.data?.items.map((item) => <button className={`w-full rounded border p-3 text-left text-sm hover:bg-muted/50 ${selectedID === item.id ? "border-primary bg-muted/50" : "border-transparent"}`} key={item.id} onClick={() => { setSelectedID(item.id); setError(""); }} type="button"><span className="flex items-center justify-between gap-2"><strong className="truncate">{item.name}</strong><Badge variant="outline">{statusNames[item.status]}</Badge></span><span className="mt-1 block text-xs text-muted-foreground">版本 {item.revision} · 首节点 {item.nodes[0]?.assignee_user_id || "未配置"}</span></button>)}</div>
        {templates.data?.meta.next_cursor || history.length > 0 ? <div className="mt-4 flex gap-2"><Button disabled={!history.length} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }} size="sm" variant="outline">上一页</Button><Button disabled={!templates.data?.meta.next_cursor} onClick={() => { setHistory([...history, cursor]); setCursor(templates.data!.meta.next_cursor); }} size="sm" variant="outline">下一页</Button></div> : null}
      </section>
      {form ? <form className="min-w-0 space-y-5" onSubmit={save}>
        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{form.id ? form.name : "新模板"}</h2><div className="flex gap-2"><Button disabled={busy} type="submit"><Save className="size-4" />保存</Button>{form.id && <Button disabled={busy} onClick={toggle} type="button" variant="outline">{form.status === "enabled" ? "停用" : "启用"}</Button>}</div></div>
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm">名称<Input maxLength={128} onChange={(e) => setForm({ ...form, name: e.target.value })} required value={form.name} /></label><label className="grid gap-1 text-sm">描述<Input onChange={(e) => setForm({ ...form, description: e.target.value })} value={form.description} /></label></div>
        <div className="grid gap-5 lg:grid-cols-[minmax(200px,280px)_minmax(0,1fr)]"><section className="min-w-0"><div className="mb-3 flex items-center justify-between"><h3 className="text-sm font-semibold">执行顺序</h3><Button aria-label="添加节点" onClick={() => { update([...form.nodes, { node_id: nodeID(), order: form.nodes.length, type: "agent", title: "", assignee_user_id: "", instruction: "" }]); setSelectedNode(form.nodes.length); }} size="icon" title="添加节点" type="button" variant="outline"><Plus className="size-4" /></Button></div>
          <ol className="space-y-0">{form.nodes.map((node, index) => <li className="relative pb-4 last:pb-0" key={node.node_id}>{index < form.nodes.length - 1 && <span className="absolute bottom-0 left-4 top-9 w-px bg-border" />}<button aria-current={selectedNode === index ? "step" : undefined} className={`relative flex w-full items-center gap-3 rounded border p-2 text-left text-sm ${selectedNode === index ? "border-primary bg-muted/50" : "bg-background"}`} onClick={() => setSelectedNode(index)} type="button"><span className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-xs">{index + 1}</span><span className="min-w-0 truncate">{node.title || "未命名节点"}</span><Badge className="ml-auto" variant="outline">{node.type === "agent" ? "Agent" : "审批"}</Badge></button></li>)}</ol>
        </section>
        {form.nodes[selectedNode] && <section className="min-w-0 space-y-3"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold">节点配置</h3><div className="flex gap-1"><Button aria-label="上移节点" disabled={selectedNode === 0} onClick={() => move(-1)} size="icon" title="上移节点" type="button" variant="ghost"><ArrowUp className="size-4" /></Button><Button aria-label="下移节点" disabled={selectedNode === form.nodes.length - 1} onClick={() => move(1)} size="icon" title="下移节点" type="button" variant="ghost"><ArrowDown className="size-4" /></Button><Button aria-label="删除节点" onClick={() => { update(form.nodes.filter((_, i) => i !== selectedNode)); setSelectedNode(Math.max(0, selectedNode - 1)); }} size="icon" title="删除节点" type="button" variant="ghost"><Trash2 className="size-4" /></Button></div></div>
          <label className="grid gap-1 text-sm">类型<NativeSelect onChange={(e) => editNode({ type: e.target.value as WorkflowNode["type"] })} value={form.nodes[selectedNode].type}><option value="agent">Agent 执行</option><option value="approval">审批</option></NativeSelect></label>
          <label className="grid gap-1 text-sm">标题<Input onChange={(e) => editNode({ title: e.target.value })} value={form.nodes[selectedNode].title} /></label>
          <label className="grid gap-1 text-sm">负责人<Input aria-label="搜索负责人" maxLength={100} onChange={(e) => setAssigneeQuery(e.target.value)} placeholder="搜索姓名、邮箱或账号 ID" value={assigneeQuery} /><NativeSelect onChange={(e) => editNode({ assignee_user_id: e.target.value })} value={form.nodes[selectedNode].assignee_user_id}><option value="">选择账号</option>{form.nodes[selectedNode].assignee_user_id && !assignees.data?.items.some((account) => account.user_id === form.nodes[selectedNode].assignee_user_id) && <option value={form.nodes[selectedNode].assignee_user_id}>{form.nodes[selectedNode].assignee_user_id}</option>}{assignees.data?.items.map((account) => <option key={account.user_id} value={account.user_id}>{account.name || account.email}</option>)}</NativeSelect></label>
          <label className="grid gap-1 text-sm">说明 / 任务指令<Textarea onChange={(e) => editNode({ instruction: e.target.value })} rows={5} value={form.nodes[selectedNode].instruction} /></label>
        </section>}</div>
      </form> : <p className="text-sm text-muted-foreground">选择模板查看配置</p>}
    </div>
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
  const instances = useQuery({ queryKey: ["workflow-instances", status, cursor], queryFn: () => workflowAdmin.instances(status, cursor) });
  const detail = useQuery({ queryKey: ["workflow-instance", selectedID], queryFn: () => workflowAdmin.instance(selectedID!), enabled: Boolean(selectedID) });
  async function terminate() {
    if (!selectedID || !reason.trim() || !window.confirm("确定终止这个实例？")) return;
    setBusy(true); setError("");
    try { await workflowAdmin.terminate(selectedID, reason); setReason(""); void cache.invalidateQueries({ queryKey: ["workflow-instances"] }); void cache.invalidateQueries({ queryKey: ["workflow-instance", selectedID] }); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <PageShell><PageHeader title="工作流实例" /><div className="mb-4 max-w-48"><NativeSelect aria-label="状态筛选" onChange={(e) => { setStatus(e.target.value); setCursor(""); setHistory([]); }} value={status}><option value="all">全部状态</option>{["running", "succeeded", "rejected", "terminated"].map((value) => <option key={value} value={value}>{statusNames[value]}</option>)}</NativeSelect></div>
    <div className="grid gap-6 xl:grid-cols-[minmax(240px,320px)_minmax(0,1fr)]"><section className="space-y-1 border-r pr-4">{instances.isError && <ErrorAlert>{message(instances.error)}</ErrorAlert>}{instances.isLoading && <p className="text-sm text-muted-foreground">加载中…</p>}{instances.data?.items.map((item) => <button className={`w-full rounded border p-3 text-left text-sm hover:bg-muted/50 ${selectedID === item.id ? "border-primary bg-muted/50" : "border-transparent"}`} key={item.id} onClick={() => setSelectedID(item.id)} type="button"><span className="flex justify-between gap-2"><strong className="truncate">{item.nodes[0]?.title || item.id}</strong><Badge variant="outline">{statusNames[item.status]}</Badge></span><span className="mt-1 block text-xs text-muted-foreground">{new Date(item.started_at).toLocaleString()} · {item.started_by}</span></button>)}
      {instances.data?.meta.next_cursor || history.length > 0 ? <div className="flex gap-2 pt-3"><Button disabled={!history.length} onClick={() => { setCursor(history[history.length - 1]); setHistory(history.slice(0, -1)); }} size="sm" variant="outline">上一页</Button><Button disabled={!instances.data?.meta.next_cursor} onClick={() => { setHistory([...history, cursor]); setCursor(instances.data!.meta.next_cursor); }} size="sm" variant="outline">下一页</Button></div> : null}</section>
      <section className="min-w-0">{detail.isError && <ErrorAlert>{message(detail.error)}</ErrorAlert>}{detail.data && <><div className="mb-5 flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">实例 {detail.data.id}</h2><p className="text-xs text-muted-foreground">模板版本 {detail.data.template_revision} · 发起人 {detail.data.started_by}</p></div><Badge>{statusNames[detail.data.status]}</Badge></div><WorkflowSteps nodes={detail.data.nodes} instance={detail.data} />{canTerminate && detail.data.status === "running" && <div className="mt-5 flex gap-2 border-t pt-4"><Input aria-label="终止原因" onChange={(e) => setReason(e.target.value)} placeholder="终止原因" value={reason} /><Button disabled={busy || !reason.trim()} onClick={terminate} variant="destructive">终止</Button></div>}{error && <ErrorAlert>{error}</ErrorAlert>}</>}</section></div>
  </PageShell>;
}
