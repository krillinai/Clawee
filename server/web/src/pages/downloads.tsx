import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Copy, Download, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { ThemeSwitcher } from "@/components/theme-switcher";
import { clientDownloads, standardClientDownloadURL } from "@/lib/client-downloads-api";

const signatures = { unsigned: "未签名", signed: "已签名", signed_notarized: "已签名并公证" };

export function DownloadsPage() {
  const query = useQuery({ queryKey: ["public", "client-downloads"], queryFn: clientDownloads, retry: false });
  const [copyStatus, setCopyStatus] = useState("");
  const gateway = query.data?.gateway || window.location.origin;
  const standard = query.data?.standard ?? { url: standardClientDownloadURL };

  async function copyGateway() {
    try {
      await navigator.clipboard.writeText(gateway);
      setCopyStatus("已复制服务端地址");
    } catch {
      setCopyStatus("复制失败，请选择地址手动复制");
    }
  }

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-6 py-4">
          <Link className="flex items-center gap-3 font-semibold" to="/login">
            <img alt="" className="size-8" src="/favicon.svg" />
            Clawee
          </Link>
          <div className="flex items-center gap-4"><Link className="text-sm hover:underline" to="/login">登录管理台</Link><ThemeSwitcher /></div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-8 sm:py-10">
        <h1 className="text-2xl font-semibold">Clawee 客户端下载</h1>
        <section className="border-b border-border py-6" aria-labelledby="gateway-heading">
          <h2 id="gateway-heading" className="text-base font-medium">服务端地址</h2>
          <div className="mt-3 flex items-start gap-3">
            <code className="min-w-0 flex-1 select-all break-all rounded-md bg-muted px-3 py-2 text-sm">{query.isPending ? "正在读取服务端地址..." : gateway}</code>
            <Button aria-label="复制服务端地址" title="复制服务端地址" disabled={query.isPending} onClick={copyGateway} size="icon" variant="outline"><Copy /></Button>
          </div>
          <p className="mt-2 min-h-5 text-xs text-muted-foreground" role="status">{copyStatus}</p>
          {query.isError ? <p className="mt-2 text-sm text-muted-foreground">下载配置暂时不可用。当前显示页面地址；分域部署请向管理员确认服务端地址。</p> : null}
        </section>
        <section className="border-b border-border py-6" aria-labelledby="packages-heading">
          <h2 id="packages-heading" className="text-base font-medium">企业客户端</h2>
          {query.isPending ? <p className="mt-3 text-sm text-muted-foreground">正在读取下载信息...</p> : null}
          {!query.isPending && !query.data?.packages.length ? <p className="mt-3 text-sm text-muted-foreground">暂未提供企业安装包，请使用下方开源标准包。</p> : null}
          <div className="divide-y divide-border">
            {query.data?.packages.map((item) => (
              <div className="py-4" key={`${item.platform}-${item.arch}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium">{item.platform === "macos" ? (item.arch === "arm64" ? "macOS Apple Silicon" : "macOS Intel") : "Windows x64"}</h3>
                    <p className="mt-1 text-xs text-muted-foreground">{item.version} · {signatures[item.signature]}</p>
                  </div>
                  <Button asChild variant="outline"><a href={item.url} target="_blank" rel="noreferrer"><Download />下载安装包</a></Button>
                </div>
                <p className="mt-3 break-all font-mono text-xs text-muted-foreground">SHA256: {item.sha256}</p>
              </div>
            ))}
          </div>
        </section>
        <section className="border-b border-border py-6" aria-labelledby="standard-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="standard-heading" className="text-base font-medium">开源标准包</h2>
            <Button asChild variant="outline"><a href={standard.url} target="_blank" rel="noreferrer"><ExternalLink />下载开源标准包</a></Button>
          </div>
          {standard.version ? <p className="mt-3 text-sm">版本 {standard.version}</p> : null}
          {standard.sha256 ? <p className="mt-2 break-all font-mono text-xs text-muted-foreground">SHA256: {standard.sha256}</p> : null}
          <p className="mt-3 text-sm text-muted-foreground">企业安装包下载失败时，也可安装标准包后手动配置服务端地址。</p>
        </section>
        <section className="py-6" aria-labelledby="setup-heading">
          <h2 id="setup-heading" className="text-base font-medium">连接企业 Gateway</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6">
            <li>下载并安装客户端。</li>
            <li>打开账户页面，在“服务端地址”粘贴上方地址。</li>
            <li>点击“保存地址”，再登录企业账号。</li>
          </ol>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">已有配置会在升级或覆盖安装时保留。切换 Gateway 前，请结束正在执行的任务，已登录时先退出账户，再修改地址。</p>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">无法连接时，请检查 HTTPS 地址和企业网络。地址无需附加 /api 或 /mcp。</p>
        </section>
      </main>
    </div>
  );
}
