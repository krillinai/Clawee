import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog, ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { APIError } from "@/lib/api";
import { getClientDownloadsAdmin, getClientDownloadsUpdate, getClientUpdateVersions, getClientUpdateCandidate, saveClientUpdatePolicy, updateClientDownloadsAdmin, type ClientUpdatePolicy, type CustomerUpdatePackage } from "@/lib/client-downloads-admin-api";
import { permissions } from "@/lib/rbac-api";
import { trimInput } from "@/lib/text";
export function ClientDownloadsPage() {
  const canUpdate = useAdminPermission(permissions.clientDownloadsUpdate); const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["client-downloads-admin"], queryFn: getClientDownloadsAdmin });
  const updateQuery = useQuery({ queryKey: ["client-downloads-update"], queryFn: getClientDownloadsUpdate });
  const [gateway, setGateway] = useState(""); const [catalog, setCatalog] = useState(""); const [message, setMessage] = useState("");
  const versionsQuery = useQuery({ queryKey: ["client-update-versions", query.data?.catalog_url], queryFn: getClientUpdateVersions, enabled: !!query.data });
  const [enabled, setEnabled] = useState(false);
  const [targetVersion, setTargetVersion] = useState("");
  const candidateQuery = useQuery({ queryKey: ["client-update-candidate", query.data?.catalog_url, targetVersion], queryFn: () => getClientUpdateCandidate(targetVersion), enabled: !!targetVersion && enabled });
  const [notes, setNotes] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<{ policy: ClientUpdatePolicy; revision: number } | null>(null);
  useEffect(() => { if (query.data) { setGateway(query.data.gateway_url); setCatalog(query.data.catalog_url); } }, [query.data]);
  useEffect(() => {
    if (!updateQuery.data) return;
    setEnabled(updateQuery.data.enabled ?? updateQuery.data.update !== null);
    setTargetVersion(updateQuery.data.update?.version ?? "");
    setNotes(updateQuery.data.update?.notes ?? "");
  }, [updateQuery.data]);
  if (query.isLoading) return <PageShell><LoadingState label="正在读取客户端下载配置" /></PageShell>;
  if (query.isError || !query.data) return <PageShell><PageHeader title="客户端下载" /><ErrorAlert error={query.error}>客户端下载配置暂时不可用。</ErrorAlert></PageShell>;
  const data = query.data;
  const save = async () => {
    if (saving) return;
    setSaving(true); setMessage("");
    try { const updated = await updateClientDownloadsAdmin({ gateway_url: trimInput(gateway), catalog_url: trimInput(catalog), version: data.version }); queryClient.setQueryData(["client-downloads-admin"], { ...data, ...updated }); setMessage("已保存"); }
    catch (error) { setMessage(error instanceof APIError ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const publish = async () => {
    if (!confirmation || publishing || !canUpdate) return;
    setPublishing(true); setUpdateError(""); setUpdateMessage("");
    try {
      const response = await saveClientUpdatePolicy(confirmation.policy, confirmation.revision);
      queryClient.setQueryData(["client-downloads-update"], response);
      setConfirmation(null); setUpdateMessage("客户更新配置已保存。");
    } catch (error) {
      setConfirmation(null);
      setUpdateError(error instanceof APIError ? error.message : "发布失败，请重新读取快照后确认。");
      if (error instanceof APIError && error.status === 409) await updateQuery.refetch();
    } finally { setPublishing(false); }
  };
  return <PageShell>
    <PageHeader title="客户端下载" />
    <div className="max-w-2xl space-y-6">
      <section className="space-y-4" aria-labelledby="downloads-config-title">
        <h2 id="downloads-config-title" className="text-base font-semibold">下载入口配置</h2>
        <label className="grid gap-2 text-sm font-medium">服务端地址<Input value={gateway} onChange={event => setGateway(event.target.value)} disabled={!canUpdate || saving || publishing} /></label>
        <label className="grid gap-2 text-sm font-medium">稳定版 latest.json 地址<Input value={catalog} onChange={event => setCatalog(event.target.value)} disabled={!canUpdate || saving || publishing} /></label>
        <div className="rounded-lg border p-4 text-sm">
          <div className="font-medium">清单状态：{data.manifest_status === "ok" ? "可用" : "不可用"}</div>
          {data.manifest_version ? <div className="mt-1 text-muted-foreground">当前版本：{data.manifest_version}</div> : null}
          <div className="mt-1 text-muted-foreground">{data.packages.length ? `平台包：${data.packages.map(item => `${item.platform}/${item.arch}`).join("、")}` : "当前没有可用的平台包。"}</div>
        </div>
        {message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}
        {canUpdate && <Button onClick={save} disabled={saving || publishing}><Save aria-hidden="true" />{saving ? "正在保存…" : "保存"}</Button>}
        <p className="text-xs text-muted-foreground">最近更新：{data.updated_at ? new Date(data.updated_at).toLocaleString() : "未配置"}</p>
      </section>
      <section className="space-y-4 border-t pt-5" aria-labelledby="customer-update-title">
        <h2 id="customer-update-title" className="text-base font-semibold">客户更新</h2>
        {!canUpdate && <Alert><AlertDescription>暂无客户端下载更新权限，请联系管理员。</AlertDescription></Alert>}
        {updateQuery.isLoading ? <LoadingState label="正在读取客户更新快照" /> : updateQuery.isError || !updateQuery.data ? <ErrorAlert error={updateQuery.error}>客户更新快照暂时不可用。</ErrorAlert> : <>
          <p className="text-sm font-medium">更新状态：{updateQuery.data.enabled ?? updateQuery.data.update !== null ? "已启用" : "已停用"}</p>
          {updateQuery.data.update ? <div className="space-y-2 text-sm">
            <p className="font-medium">已发布版本：{updateQuery.data.update.version} · 修订 {updateQuery.data.revision}</p>
            <p className="text-muted-foreground">发布时间：{new Date(updateQuery.data.update.published_at).toLocaleString()} · 操作者：{updateQuery.data.update.published_by || "未知"}</p>
            <p className="whitespace-pre-wrap break-words">{updateQuery.data.update.notes || "无更新说明"}</p>
            <UpdatePackages packages={updateQuery.data.update.packages} />
          </div> : <p className="text-sm text-muted-foreground">尚未发布客户更新。</p>}
          <div className="flex items-center gap-2"><Checkbox id="enable-client-update" checked={enabled} disabled={!canUpdate || publishing || saving} onCheckedChange={value => setEnabled(value === true)} /><Label htmlFor="enable-client-update">启用客户更新</Label></div>
          <div className="grid gap-2"><Label htmlFor="client-target-version">目标客户端版本</Label><Select value={targetVersion} onValueChange={setTargetVersion} disabled={!enabled || !canUpdate || publishing || saving || versionsQuery.isLoading || versionsQuery.isError}><SelectTrigger id="client-target-version"><SelectValue placeholder="选择已发布版本" /></SelectTrigger><SelectContent>{versionsQuery.data?.versions.map(item => <SelectItem key={item.version} value={item.version}>{item.version}</SelectItem>)}</SelectContent></Select></div>
          {versionsQuery.isLoading && <LoadingState label="正在读取稳定版本目录" />}
          {versionsQuery.isError && <ErrorAlert error={versionsQuery.error}>稳定版本目录暂时不可用。</ErrorAlert>}
          {versionsQuery.data?.versions.length === 0 && <p className="text-sm text-muted-foreground">暂无已发布稳定版本。</p>}
          {enabled && candidateQuery.isLoading && <LoadingState label="正在校验目标版本更新包" />}
          {enabled && candidateQuery.isError && <ErrorAlert error={candidateQuery.error}>目标版本更新包暂时不可用。</ErrorAlert>}
          {enabled && candidateQuery.data && <div className="space-y-3 text-sm"><UpdatePackages packages={candidateQuery.data.packages} />{candidateQuery.data.unavailable_platforms.length > 0 && <Alert><AlertDescription className="whitespace-pre-wrap">{candidateQuery.data.unavailable_platforms.join("\n")}</AlertDescription></Alert>}</div>}
          <label className="grid gap-2 text-sm font-medium">更新说明<Textarea value={notes} maxLength={16384} disabled={!canUpdate || publishing || !enabled} onChange={event => setNotes(event.target.value)} /></label>
          {updateError && <ErrorAlert>{updateError}</ErrorAlert>}
          {updateMessage && <Alert role="status"><AlertDescription>{updateMessage}</AlertDescription></Alert>}
          {canUpdate && <Button disabled={publishing || saving || updateQuery.isFetching || (enabled ? !targetVersion || candidateQuery.isFetching || candidateQuery.isError || !candidateQuery.data?.packages.length : !updateQuery.data.update)} onClick={() => { if (updateQuery.data) setConfirmation({ policy: { enabled, version: targetVersion, notes }, revision: updateQuery.data.revision }); }}><Save aria-hidden="true" />{publishing ? "正在保存…" : "保存更新配置"}</Button>}
        </>}
      </section>
    </div>
    <ConfirmDialog open={confirmation !== null} title={confirmation?.policy.enabled ? "确认启用客户更新" : "确认停用客户更新"} description={confirmation?.policy.enabled ? `连接此服务器且版本低于 ${confirmation.policy.version} 的客户端将自动下载，在本地任务和文件保存结束后安装并重启。` : "尚未进入原生安装流程的更新将停止；已安装版本不会回退。"} confirmLabel="确认保存" pending={publishing} onClose={() => { if (!publishing) setConfirmation(null); }} onConfirm={() => void publish()} />
  </PageShell>;
}

function UpdatePackages({ packages }: { packages: CustomerUpdatePackage[] }) {
  return <Table><TableHeader><TableRow><TableHead>平台 / 架构</TableHead><TableHead>下载地址</TableHead><TableHead className="text-right">大小（字节）</TableHead></TableRow></TableHeader><TableBody>{packages.map(item => <TableRow key={`${item.platform}/${item.arch}`}><TableCell className="whitespace-nowrap">{item.platform}/{item.arch}</TableCell><TableCell className="max-w-xs break-all whitespace-normal">{item.url}</TableCell><TableCell className="text-right">{item.size.toLocaleString()}</TableCell></TableRow>)}</TableBody></Table>;
}
