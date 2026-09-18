import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { ErrorAlert, ModalShell } from "@/components/governance-ui";
import { Button } from "@/components/ui/button";
import { getSharedFilePreview, sharedFileDownloadURL, type SharedFile } from "@/lib/shared-files-api";

export function SharedFilePreview({ file, onClose }: { file: SharedFile; onClose(): void }) {
  const [content, setContent] = useState<{ kind: "text" | "image" | "pdf"; value: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setContent(undefined);
    setError(undefined);
    void (async () => {
      try {
        const response = await getSharedFilePreview(file.fileId, controller.signal);
        const mime = response.headers.get("content-type")?.split(";", 1)[0];
        if (mime === "text/plain") {
          const value = await response.text();
          if (!controller.signal.aborted) setContent({ kind: "text", value });
        } else if (mime === "application/pdf" || ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime ?? "")) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setContent({ kind: mime === "application/pdf" ? "pdf" : "image", value: objectUrl });
        } else {
          throw new Error("暂不支持预览此文件，请下载后查看");
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "文件预览失败，请重试或下载后查看");
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.fileId, file.revision]);

  return (
    <ModalShell open title={`预览 ${file.fileName}`} subtitle={file.logicalPath} onClose={onClose} contentClassName="sm:max-w-[1000px] [&_h2]:break-all [&_p]:break-all">
      <div className="h-[60dvh] min-h-0 overflow-auto">
        {error ? <ErrorAlert>{error}</ErrorAlert> : !content ? <p role="status">正在加载预览...</p>
          : content.kind === "text" ? <pre className="m-0 font-mono text-xs leading-6">{content.value}</pre>
            : content.kind === "image" ? <img className="mx-auto max-h-full max-w-full object-contain" src={content.value} alt={file.fileName} onError={() => setError("图片预览失败，请下载后查看")} />
              : <object className="h-full w-full" data={content.value} type="application/pdf" aria-label={`${file.fileName} PDF 预览`}><p>当前环境无法预览 PDF，请下载后查看</p></object>}
      </div>
      <div className="flex justify-end">
        <Button asChild variant="outline"><a href={sharedFileDownloadURL(file.fileId)}><Download aria-hidden="true" />下载</a></Button>
      </div>
    </ModalShell>
  );
}
