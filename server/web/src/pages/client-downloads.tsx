import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { ConfirmDialog, ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { APIError } from "@/lib/api";
import { getClientDownloadsAdmin, getClientDownloadsUpdate, parseCustomerUpdateManifest, publishClientDownloadsUpdate, updateClientDownloadsAdmin, type CustomerUpdateManifest, type CustomerUpdatePackage } from "@/lib/client-downloads-admin-api";
import { permissions } from "@/lib/rbac-api";
import { trimInput } from "@/lib/text";
export function ClientDownloadsPage() {
  const canUpdate = useAdminPermission(permissions.clientDownloadsUpdate); const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["client-downloads-admin"], queryFn: getClientDownloadsAdmin });
  const updateQuery = useQuery({ queryKey: ["client-downloads-update"], queryFn: getClientDownloadsUpdate });
  const [gateway, setGateway] = useState(""); const [catalog, setCatalog] = useState(""); const [message, setMessage] = useState("");
  const [imported, setImported] = useState<CustomerUpdateManifest | null>(null);
  const [notes, setNotes] = useState("");
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [importing, setImporting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<{ manifest: CustomerUpdateManifest; revision: number } | null>(null);
  useEffect(() => { if (query.data) { setGateway(query.data.gateway_url); setCatalog(query.data.catalog_url); } }, [query.data]);
  if (query.isLoading) return <PageShell><LoadingState label="正在读取客户端下载配置" /></PageShell>;
  if (query.isError || !query.data) return <PageShell><PageHeader title="客户端下载" /><ErrorAlert error={query.error}>客户端下载配置暂时不可用。</ErrorAlert></PageShell>;
  const data = query.data;
  const fixedGateway = updateQuery.data?.update?.gateway_url ?? data.gateway_url;
  const save = async () => {
    if (saving) return;
    setSaving(true); setMessage("");
    try { const updated = await updateClientDownloadsAdmin({ gateway_url: trimInput(gateway), catalog_url: trimInput(catalog), version: data.version }); queryClient.setQueryData(["client-downloads-admin"], { ...data, ...updated }); setMessage("已保存"); }
    catch (error) { setMessage(error instanceof APIError ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };
  const importFile = async (file: File) => {
    setImported(null); setNotes(""); setUpdateMessage(""); setUpdateError(""); setImporting(true);
    try {
      if (file.size > 128 * 1024) throw new Error("客户更新清单无效：文件不能超过 128 KiB。");
      const manifest = parseCustomerUpdateManifest(await file.text());
      if (manifest.gateway_url !== new URL(fixedGateway).origin) throw new Error("清单 Gateway 与固定更新渠道不匹配。");
      setImported(manifest); setNotes(manifest.notes);
    } catch (error) { setUpdateError(error instanceof Error ? error.message : "客户更新清单无效。"); }
    finally { setImporting(false); }
  };
  const publish = async () => {
    if (!confirmation || publishing || !canUpdate) return;
    setPublishing(true); setUpdateError(""); setUpdateMessage("");
    try {
      const response = await publishClientDownloadsUpdate(confirmation.manifest, confirmation.revision);
      queryClient.setQueryData(["client-downloads-update"], response);
      setImported(null); setNotes(""); setConfirmation(null); setUpdateMessage("客户更新已发布。");
    } catch (error) {
      setConfirmation(null);
      setUpdateError(error instanceof APIError ? error.message : "发布失败，请重新读取快照后确认。");
      if (error instanceof APIError && error.status === 409) await updateQuery.refetch();
    } finally { setPublishing(false); }
  };
  return <PageShell>
    <PageHeader title="客户端下载">配置客户端下载入口，手动批准客户更新。</PageHeader>
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
        <p className="text-sm text-muted-foreground">仅发布手动批准的客户包快照，不跟随稳定版清单。macOS 使用 ZIP，Windows 使用 NSIS EXE；未登记的平台没有更新。</p>
        {!canUpdate && <Alert><AlertDescription>暂无客户端下载更新权限，请联系管理员。</AlertDescription></Alert>}
        {updateQuery.isLoading ? <LoadingState label="正在读取客户更新快照" /> : updateQuery.isError || !updateQuery.data ? <ErrorAlert error={updateQuery.error}>客户更新快照暂时不可用。</ErrorAlert> : <>
          <p className="break-all text-sm">固定更新渠道：{fixedGateway}</p>
          {updateQuery.data.update ? <div className="space-y-2 text-sm">
            <p className="font-medium">已发布版本：{updateQuery.data.update.version} · 修订 {updateQuery.data.revision}</p>
            <p className="text-muted-foreground">发布时间：{new Date(updateQuery.data.update.published_at).toLocaleString()} · 操作者：{updateQuery.data.update.published_by || "未知"}</p>
            <p className="whitespace-pre-wrap break-words">{updateQuery.data.update.notes || "无更新说明"}</p>
            <UpdatePackages packages={updateQuery.data.update.packages} />
          </div> : <p className="text-sm text-muted-foreground">尚未发布客户更新。</p>}
          <label className="grid gap-2 text-sm font-medium">导入客户更新 JSON 清单<Input type="file" accept=".json,application/json" disabled={!canUpdate || importing || publishing || updateQuery.isFetching || saving} onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importFile(file); }} /></label>
          {importing && <LoadingState label="正在读取本地清单" />}
          {imported && <div className="space-y-3 text-sm">
            <p className="font-medium">待发布版本：{imported.version}</p>
            <UpdatePackages packages={imported.packages} />
            <label className="grid gap-2 font-medium">更新说明<Textarea value={notes} maxLength={16384} disabled={publishing} onChange={event => setNotes(event.target.value)} /></label>
          </div>}
          {updateError && <ErrorAlert>{updateError}</ErrorAlert>}
          {updateMessage && <Alert role="status"><AlertDescription>{updateMessage}</AlertDescription></Alert>}
          {canUpdate && <Button disabled={!imported || importing || publishing || saving || updateQuery.isFetching} onClick={() => { if (imported && updateQuery.data) setConfirmation({ manifest: { ...imported, notes }, revision: updateQuery.data.revision }); }}><Upload aria-hidden="true" />{publishing ? "正在发布…" : "发布更新"}</Button>}
        </>}
      </section>
    </div>
    <ConfirmDialog open={confirmation !== null} title="确认发布客户更新" description={`请确认版本 ${confirmation?.manifest.version ?? ""} 与客户环境兼容，下载地址为版本化不可变地址。发布后替换当前更新快照，不支持撤回。`} confirmLabel="确认兼容并发布" pending={publishing} onClose={() => { if (!publishing) setConfirmation(null); }} onConfirm={() => void publish()} />
  </PageShell>;
}

function UpdatePackages({ packages }: { packages: CustomerUpdatePackage[] }) {
  return <Table><TableHeader><TableRow><TableHead>平台 / 架构</TableHead><TableHead>下载地址</TableHead><TableHead className="text-right">大小（字节）</TableHead></TableRow></TableHeader><TableBody>{packages.map(item => <TableRow key={`${item.platform}/${item.arch}`}><TableCell className="whitespace-nowrap">{item.platform}/{item.arch}</TableCell><TableCell className="max-w-xs break-all whitespace-normal">{item.url}</TableCell><TableCell className="text-right">{item.size.toLocaleString()}</TableCell></TableRow>)}</TableBody></Table>;
}
