import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { ErrorAlert, LoadingState, ModalShell } from "@/components/governance-ui";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { skillAIReviewApi } from "@/lib/skill-ai-review-api";
import { hasLocalSkillApproval, type SkillSpace } from "@/lib/skillhub-api";

export function SkillSpaceAIReviewSettings({ space, onClose }: { space: SkillSpace; onClose: () => void }) {
  const cache = useQueryClient();
  const queryKey = ["skill-space-ai-review", space.spaceId];
  const query = useQuery({ queryKey, queryFn: () => skillAIReviewApi.getConfig(space.spaceId) });
  const [enabled, setEnabled] = useState(false);
  const [agentId, setAgentId] = useState("");
  const busy = useRef(false);
  const eligible = (space.approvalProvider ?? "local") === "local" && hasLocalSkillApproval(space);
  useEffect(() => { if (query.data) { setEnabled(query.data.enabled); setAgentId(query.data.agent_id); } }, [query.data]);
  const save = useMutation({
    mutationFn: () => skillAIReviewApi.saveConfig(space.spaceId, { enabled, agent_id: agentId }),
    onSuccess: () => { void cache.invalidateQueries({ queryKey }); onClose(); },
    onSettled: () => { busy.current = false; }
  });
  const valid = !enabled || (eligible && Boolean(agentId.trim()));
  return <ModalShell open onClose={() => { if (!busy.current) onClose(); }} title="空间 AI 审核设置" contextLabel={space.name}>
    {query.isLoading ? <LoadingState label="正在加载 AI 审核配置" /> : query.isError ? <ErrorAlert>AI 审核配置加载失败，请重试。<Button variant="outline" onClick={() => void query.refetch()}>重试加载</Button></ErrorAlert> : <form onSubmit={event => { event.preventDefault(); if (!busy.current && valid && !query.isFetching) { busy.current = true; save.mutate(); } }}><FieldGroup>
      <Field orientation="horizontal"><Checkbox id="space-ai-review-enabled" checked={enabled} disabled={save.isPending || (!eligible && !enabled)} onCheckedChange={value => { setEnabled(value === true); if (value !== true) setAgentId(""); }} /><FieldLabel htmlFor="space-ai-review-enabled">启用 AI 前置审核</FieldLabel></Field>
      {!eligible ? <p className="text-sm text-muted-foreground">仅配置本地全员评审名单的空间可启用；钉钉审批或无名单的空间不可启用。</p> : null}
      <Field><FieldLabel htmlFor="space-ai-review-agent">执行 Agent ID{enabled ? "（必填）" : ""}</FieldLabel><Input id="space-ai-review-agent" required={enabled} disabled={!enabled || save.isPending} value={agentId} onChange={event => setAgentId(event.target.value)} /><FieldDescription>使用企业登录返回的 Agent ID，不是设备名称。执行账号必须已有空间读取权限，配置不会自动授权。仅影响新审核轮次。</FieldDescription></Field>
      {save.isError ? <ErrorAlert>保存失败，请确认 Agent 有效、审批配置和空间权限后重试。</ErrorAlert> : null}
      <Field orientation="horizontal" className="justify-end"><Button type="button" variant="outline" disabled={save.isPending} onClick={onClose}>取消</Button><Button type="submit" disabled={save.isPending || query.isFetching || !valid}>{save.isPending ? "保存中..." : "保存 AI 配置"}</Button></Field>
    </FieldGroup></form>}
  </ModalShell>;
}
