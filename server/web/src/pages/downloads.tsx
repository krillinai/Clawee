import { useQuery } from "@tanstack/react-query";
import { Apple, ArrowLeft, Check, Copy, Download, Laptop, Monitor, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ErrorAlert, LoadingState, PageHeader, PageShell } from "@/components/governance-ui";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { clientDownloads } from "@/lib/client-downloads-api";

const labels: Record<string, string> = { "macos/arm64": "macOS Apple Silicon", "macos/x64": "macOS Intel", "windows/x64": "Windows" };
const platformIcons: Record<string, LucideIcon> = { "macos/arm64": Apple, "macos/x64": Laptop, "windows/x64": Monitor };

function DownloadsFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-[100dvh] bg-muted/30">
      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-12">{children}</div>
    </div>
  );
}

function AdminReturnButton() {
  return (
    <Button asChild className="shrink-0" size="sm" variant="outline">
      <Link to="/admin">
        <ArrowLeft aria-hidden="true" data-icon="inline-start" />
        返回管理后台
      </Link>
    </Button>
  );
}

export function DownloadsPage() {
  const query = useQuery({ queryKey: ["public", "client-downloads"], queryFn: clientDownloads, retry: false });
  const [copied, setCopied] = useState(false);
  if (query.isLoading) return <DownloadsFrame><PageShell><LoadingState label="正在读取下载配置" /></PageShell></DownloadsFrame>;
  if (query.isError || !query.data) return <DownloadsFrame><PageShell><PageHeader actions={<AdminReturnButton />} title="下载客户端" /><ErrorAlert error={query.error}>客户端下载清单暂时不可用，请稍后重试。</ErrorAlert></PageShell></DownloadsFrame>;

  const data = query.data;
  const gateway = data.gateway_url || window.location.origin;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(gateway);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <DownloadsFrame>
      <PageShell>
        <header className="border-b border-border/70 pb-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase text-primary">
                <span className="size-2 rounded-full bg-primary" aria-hidden="true" />
                Clawee Desktop
              </div>
              <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">下载客户端</h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">获取企业客户端安装包，在本地连接你的 Clawee Gateway。</p>
            </div>
            <AdminReturnButton />
          </div>
        </header>

        <section className="rounded-xl border border-border/80 bg-card p-5 shadow-sm sm:p-6" aria-labelledby="gateway-title">
          <div className="flex items-start gap-3">
            <div className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Monitor className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 id="gateway-title" className="text-sm font-semibold">服务端地址</h2>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">客户端首次使用时，在登录页面的服务端地址设置中填入此地址以连接企业服务。</p>
            </div>
          </div>
          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border/70 bg-muted/60 px-3 py-2.5 font-mono text-sm leading-5 text-foreground">{gateway}</code>
            <Button className="shrink-0" variant="outline" onClick={copy}>
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>
        </section>

        <section className="grid gap-4" aria-labelledby="packages-title">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="packages-title" className="text-lg font-semibold">选择平台</h2>
              <p className="mt-1 text-sm text-muted-foreground">当前可用的客户端版本</p>
            </div>
            {data.version ? <Badge variant="muted">稳定版 {data.version}</Badge> : null}
          </div>
          {data.packages.length === 0 ? <ErrorAlert>暂未提供可用的企业客户端安装包。</ErrorAlert> : (
            <div className="grid gap-4 md:grid-cols-3">
              {data.packages.map((item) => {
                const platform = `${item.platform}/${item.arch}`;
                const Icon = platformIcons[platform] ?? Monitor;
                return (
                  <article className="group flex min-h-[238px] flex-col rounded-xl border border-border/80 bg-card p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md" key={platform}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="grid size-11 place-items-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                        <Icon className="size-5" aria-hidden="true" />
                      </div>
                    </div>
                    <h3 className="mt-5 text-base font-semibold">{labels[platform] ?? `${item.platform} ${item.arch}`}</h3>
                    <p className="mt-1 text-sm text-muted-foreground">{item.version}</p>
                    <Button asChild className="mt-5 w-full" variant="default">
                      <a href={item.download_url} target="_blank" rel="noreferrer"><Download aria-hidden="true" />下载安装包</a>
                    </Button>
                    <div className="mt-auto flex gap-2 border-t border-border/70 pt-4 text-[11px] leading-4 text-muted-foreground">
                      <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                      <p className="min-w-0 break-all"><span className="font-medium text-foreground/70">SHA256</span> {item.sha256}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </PageShell>
    </DownloadsFrame>
  );
}
