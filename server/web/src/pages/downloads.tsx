import { useQuery } from "@tanstack/react-query";
import { Copy, Download } from "lucide-react";
import { useState } from "react";
import { ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { Button } from "@/components/ui/button";
import { clientDownloads } from "@/lib/client-downloads-api";

const labels: Record<string, string> = { "macos/arm64": "macOS Apple Silicon", "macos/x64": "macOS Intel", "windows/x64": "Windows x64" };
const signatures: Record<string, string> = { unsigned: "未签名", signed: "已签名", signed_notarized: "已签名并公证" };
export function DownloadsPage() {
  const query = useQuery({ queryKey: ["public", "client-downloads"], queryFn: clientDownloads, retry: false });
  const [copied, setCopied] = useState(false);
  if (query.isLoading) return <PageShell><LoadingState label="正在读取下载配置" /></PageShell>;
  if (query.isError || !query.data) return <PageShell><PageHeader title="下载客户端" /><ErrorAlert>客户端发布清单暂时不可用，请稍后重试。</ErrorAlert></PageShell>;
  const data = query.data; const gateway = data.gateway_url || window.location.origin;
  const copy = async () => { try { await navigator.clipboard.writeText(gateway); setCopied(true); } catch { setCopied(false); } };
  return <PageShell><PageHeader title="下载客户端">获取企业客户端安装包。</PageHeader><section className="grid gap-4"><div className="rounded-lg border p-4"><div className="text-sm font-medium">服务端地址</div><div className="mt-2 flex gap-2"><code className="flex-1 rounded bg-muted px-3 py-2 text-sm">{gateway}</code><Button variant="outline" onClick={copy}><Copy />{copied ? "已复制" : "复制"}</Button></div></div>{data.packages.length === 0 ? <ErrorAlert>暂未提供可用的企业客户端安装包。</ErrorAlert> : <div className="grid gap-3 md:grid-cols-3">{data.packages.map((item) => <div className="rounded-lg border p-4" key={`${item.platform}/${item.arch}`}><h3 className="text-sm font-medium">{labels[`${item.platform}/${item.arch}`] ?? `${item.platform} ${item.arch}`}</h3><p className="mt-1 text-xs text-muted-foreground">{item.version} · {signatures[item.signature] ?? item.signature}</p><Button asChild variant="outline" className="mt-3"><a href={item.download_url} target="_blank" rel="noreferrer"><Download />下载安装包</a></Button><p className="mt-2 break-all text-[11px] text-muted-foreground">SHA256: {item.sha256}</p></div>)}</div>}</section></PageShell>;
}
