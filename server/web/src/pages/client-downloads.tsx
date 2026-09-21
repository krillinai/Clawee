import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { useAdminPermission } from "@/components/admin-permissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { APIError } from "@/lib/api";
import { getClientDownloadsAdmin, updateClientDownloadsAdmin } from "@/lib/client-downloads-admin-api";
import { permissions } from "@/lib/rbac-api";
import { trimInput } from "@/lib/text";
export function ClientDownloadsPage() {
  const canUpdate = useAdminPermission(permissions.clientDownloadsUpdate); const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["client-downloads-admin"], queryFn: getClientDownloadsAdmin });
  const [gateway, setGateway] = useState(""); const [catalog, setCatalog] = useState(""); const [message, setMessage] = useState("");
  useEffect(() => { if (query.data) { setGateway(query.data.gateway_url); setCatalog(query.data.catalog_url); } }, [query.data]);
  if (query.isLoading) return <PageShell><LoadingState label="正在读取客户端下载配置" /></PageShell>;
  if (query.isError || !query.data) return <PageShell><PageHeader title="客户端下载" /><ErrorAlert>客户端下载配置暂时不可用。</ErrorAlert></PageShell>;
  const data = query.data;
  const save = async () => { setMessage(""); try { const updated = await updateClientDownloadsAdmin({ gateway_url: trimInput(gateway), catalog_url: trimInput(catalog), version: data.version }); queryClient.setQueryData(["client-downloads-admin"], { ...data, ...updated }); setMessage("已保存"); } catch (error) { setMessage(error instanceof APIError ? error.message : "保存失败"); } };
  return <PageShell><PageHeader title="客户端下载">配置 Gateway 地址和稳定版 latest.json 地址。</PageHeader><div className="max-w-2xl space-y-5"><label className="grid gap-2 text-sm font-medium">服务端地址<Input value={gateway} onChange={(e) => setGateway(e.target.value)} disabled={!canUpdate} /></label><label className="grid gap-2 text-sm font-medium">稳定版 latest.json 地址<Input value={catalog} onChange={(e) => setCatalog(e.target.value)} disabled={!canUpdate} /></label><div className="rounded-lg border p-4 text-sm"><div className="font-medium">清单状态：{data.manifest_status === "ok" ? "可用" : "不可用"}</div>{data.manifest_version ? <div className="mt-1 text-muted-foreground">当前版本：{data.manifest_version}</div> : null}{data.packages.length > 0 ? <div className="mt-1 text-muted-foreground">平台包：{data.packages.map((item) => `${item.platform}/${item.arch}`).join("、")}</div> : <div className="mt-1 text-muted-foreground">当前没有可用的平台包。</div>}</div>{message && <Alert><AlertDescription>{message}</AlertDescription></Alert>}{canUpdate && <Button onClick={save}><Save />保存</Button>}<p className="text-xs text-muted-foreground">最近更新：{data.updated_at ? new Date(data.updated_at).toLocaleString() : "未配置"}</p></div></PageShell>;
}
