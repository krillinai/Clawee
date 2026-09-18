import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../../runtime/errors.js';
import { SharedFilePreviewDialog } from './SharedFilePreviewDialog.js';

const file = {
  fileId: 'file_1', fileName: 'guide.html', spaceId: 'space_1', spaceName: '资料', logicalPath: 'guide.html',
  sizeBytes: 10, sha256: 'a'.repeat(64), contentType: 'text/html', revision: 1, updatedByUserId: 'user', updatedByAgentId: '', updatedAt: ''
};
const showModalDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
const closeDescriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'close');

describe('共享文件预览', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = vi.fn(() => 'blob:preview');
      static revokeObjectURL = vi.fn();
    });
  });
  afterEach(() => {
    cleanup();
    if (showModalDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', showModalDescriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    if (closeDescriptor) Object.defineProperty(HTMLDialogElement.prototype, 'close', closeDescriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
    vi.unstubAllGlobals();
  });

  it('以纯文本展示 HTML，无项目也可预览', async () => {
    const readPreview = vi.fn(async (_fileId: string, _signal?: AbortSignal) => new Response('<script>alert(1)</script>', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }));
    const view = render(<SharedFilePreviewDialog file={file} readPreview={readPreview} canDownload={false} onDownload={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(view.baseElement.querySelector('script')).toBeNull();
    expect(screen.getByRole('button', { name: '保存到当前项目' })).toBeDisabled();
    expect(readPreview).toHaveBeenCalledWith('file_1', expect.any(AbortSignal));
    view.unmount();
    expect(readPreview.mock.calls[0]?.[1]?.aborted).toBe(true);
  });

  it.each([413, 415])('预览被拒绝时保留下载操作（%s）', async status => {
    const readPreview = vi.fn(async () => { throw new ApiClientError({ status, code: 'ERROR', message: 'error' }); });
    const onDownload = vi.fn();
    render(<SharedFilePreviewDialog file={file} readPreview={readPreview} canDownload onDownload={onDownload} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(status === 413 ? '文件超过预览大小限制' : '暂不支持预览');
    fireEvent.click(screen.getByRole('button', { name: '保存到当前项目' }));
    expect(onDownload).toHaveBeenCalledOnce();
  });

  it.each(['image/png', 'application/pdf'])('展示媒体并在关闭时释放 URL（%s）', async mime => {
    const readPreview = vi.fn(async () => new Response('media', { headers: { 'Content-Type': mime } }));
    const view = render(<SharedFilePreviewDialog file={file} readPreview={readPreview} canDownload onDownload={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledOnce());
    expect(view.baseElement.querySelector(mime === 'image/png' ? 'img' : 'object')).not.toBeNull();
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });
});
