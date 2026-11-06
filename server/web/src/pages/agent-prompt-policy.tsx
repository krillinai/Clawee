import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { APIError } from "@/lib/api";
import { getAgentPromptPolicy, updateAgentPromptPolicy } from "@/lib/agent-prompt-policy-api";
import { permissions } from "@/lib/rbac-api";

export function AgentPromptPolicyPage() {
  const canUpdate = useAdminPermission(permissions.agentManage);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["agent-prompt-policy"], queryFn: getAgentPromptPolicy });
  const [serverPrompt, setServerPrompt] = useState("");
  const [claweePrompt, setClaweePrompt] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ kind: "success" | "error"; message: string }>();

  useEffect(() => {
    if (!query.data) return;
    setServerPrompt(query.data.serverAgentPrompt);
    setClaweePrompt(query.data.claweeAgentPrompt);
  }, [query.data]);

  if (query.isLoading) return <PageShell><LoadingState label="正在加载智能体提示词" /></PageShell>;
  if (query.isError || !query.data) return <PageShell><PageHeader title="智能体提示词" /><ErrorAlert error={query.error}>智能体提示词加载失败，请稍后重试。</ErrorAlert></PageShell>;

  async function save() {
    if (!canUpdate || saving) return;
    setSaving(true);
    setNotice(undefined);
    try {
      const updated = await updateAgentPromptPolicy({ serverAgentPrompt: serverPrompt, claweeAgentPrompt: claweePrompt });
      queryClient.setQueryData(["agent-prompt-policy"], updated);
      setNotice({ kind: "success", message: `已保存，当前版本 ${updated.version}。` });
    } catch (error) {
      setNotice({ kind: "error", message: error instanceof APIError ? error.message : "保存失败，请稍后重试。" });
    } finally {
      setSaving(false);
    }
  }

  return <PageShell>
    <PageHeader title="智能体提示词" />
    <div className="max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">保存后只对新建 Agent 会话生效，当前会话继续使用创建时的提示词。</p>
      <p className="text-xs text-muted-foreground">当前版本：{query.data.version} · 最后更新：{query.data.updatedAt ? new Date(query.data.updatedAt).toLocaleString() : "未更新"}</p>
      <section className="space-y-2" aria-labelledby="server-agent-prompt-title">
        <h2 id="server-agent-prompt-title" className="text-base font-semibold">服务端智能体提示词</h2>
        <Textarea value={serverPrompt} maxLength={32768} rows={12} disabled={!canUpdate || saving} onChange={event => setServerPrompt(event.target.value)} />
        <p className="text-xs text-muted-foreground">用于服务端 Agent 的客户业务补充规则。</p>
      </section>
      <section className="space-y-2" aria-labelledby="clawee-agent-prompt-title">
        <h2 id="clawee-agent-prompt-title" className="text-base font-semibold">Clawee 智能体提示词</h2>
        <Textarea value={claweePrompt} maxLength={32768} rows={12} disabled={!canUpdate || saving} onChange={event => setClaweePrompt(event.target.value)} />
        <p className="text-xs text-muted-foreground">下发给本地 Clawee Agent 的客户业务补充规则。</p>
      </section>
      {!canUpdate ? <Alert><AlertDescription>暂无 Agent 管理权限，当前页面为只读。</AlertDescription></Alert> : null}
      {notice ? <Alert role={notice.kind === "error" ? "alert" : "status"}><AlertDescription>{notice.message}</AlertDescription></Alert> : null}
      {canUpdate ? <Button type="button" disabled={saving} onClick={() => void save()}><Save aria-hidden="true" />{saving ? "正在保存…" : "保存"}</Button> : null}
    </div>
  </PageShell>;
}
