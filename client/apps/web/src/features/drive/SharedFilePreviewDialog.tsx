import type { EnterpriseSharedFileResponse } from '@clawee/protocol';
import { Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiClientError } from '../../runtime/errors.js';

export function SharedFilePreviewDialog(props: {
  file: EnterpriseSharedFileResponse;
  readPreview(fileId: string, signal?: AbortSignal): Promise<Response>;
  canDownload: boolean;
  onDownload(): void;
  onClose(): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [content, setContent] = useState<{ kind: 'text' | 'image' | 'pdf'; value: string }>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const dialog = dialogRef.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setContent(undefined);
    setError(undefined);
    void (async () => {
      try {
        const response = await props.readPreview(props.file.fileId, controller.signal);
        const mime = response.headers.get('content-type')?.split(';', 1)[0];
        if (mime === 'text/plain') {
          const value = await response.text();
          if (!controller.signal.aborted) setContent({ kind: 'text', value });
        } else if (mime === 'application/pdf' || ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime ?? '')) {
          const blob = await response.blob();
          if (controller.signal.aborted) return;
          objectUrl = URL.createObjectURL(blob);
          setContent({ kind: mime === 'application/pdf' ? 'pdf' : 'image', value: objectUrl });
        } else {
          throw new Error('暂不支持预览此文件，请下载后查看');
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof ApiClientError && failure.status === 413
          ? '文件超过预览大小限制，请下载后查看'
          : failure instanceof ApiClientError && failure.status === 415
            ? '暂不支持预览此文件，请下载后查看'
            : '文件预览失败，文件可能已不可访问，请重试或下载后查看');
      }
    })();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [props.file.fileId, props.file.revision, props.readPreview]);

  return createPortal(
    <dialog ref={dialogRef} className="shared-file-preview-dialog" aria-label={`预览 ${props.file.fileName}`} onCancel={props.onClose}>
      <header>
        <strong>{props.file.fileName}</strong>
        <button type="button" aria-label="关闭文件预览" title="关闭" onClick={props.onClose}><X size={18} aria-hidden="true" /></button>
      </header>
      <div className="shared-file-preview-body">
        {error ? <p role="alert">{error}</p> : !content ? <p role="status">正在加载预览...</p>
          : content.kind === 'text' ? <pre>{content.value}</pre>
            : content.kind === 'image' ? <img src={content.value} alt={props.file.fileName} onError={() => setError('图片预览失败，请下载后查看')} />
              : <object data={content.value} type="application/pdf" aria-label={`${props.file.fileName} PDF 预览`}><p>当前环境无法预览 PDF，请下载后查看</p></object>}
      </div>
      <footer>
        <button type="button" className="shared-drive-primary-button" disabled={!props.canDownload} onClick={props.onDownload} title={props.canDownload ? '保存到当前项目' : '请先选择本地项目'}>
          <Download size={16} aria-hidden="true" />保存到当前项目
        </button>
      </footer>
    </dialog>,
    document.body
  );
}
