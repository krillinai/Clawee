import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { RunResponse, SharedDriveArtifact } from '@clawee/protocol';
import { SharedDriveArtifacts, Timeline } from './Timeline.js';

vi.mock('react-virtuoso', async () => import('../../test/react-virtuoso-mock.js'));

const artifact: SharedDriveArtifact = { space_id: 'space_1', file_id: 'file_1', logical_path: 'tasks/remote/report.pdf', file_name: 'report.pdf', content_type: 'application/pdf', size_bytes: 6, revision: 1, sha256: 'a'.repeat(64) };
const run: RunResponse = { id: 'run_1', threadId: 'thread_1', status: 'succeeded', sharedDriveState: { uploads: [], downloads: [{ artifact, status: 'downloaded', relativePath: artifact.logical_path }] } };

describe('网盘交付成果', () => {
  it('远程部分上传失败在下载成功后仍显示固定提示，重开后可恢复', () => {
    const restored: RunResponse = JSON.parse(JSON.stringify({ ...run, sharedDriveState: { ...run.sharedDriveState, remoteDeliveries: [{ taskId: 'remote_1', status: 'incomplete', errors: [{ file_name: 'second.pdf', code: 'UPLOAD_FAILED', message: '文件传输失败' }] }] } }));
    const view = render(<Timeline items={[{ kind: 'assistant_message', id: 'message', runId: run.id, text: '已取回报告', source: 'runtime' }]} runs={[restored]} canOpenFile={() => true} onOpenFile={vi.fn()} />);
    expect(screen.getByText('文件未全部上传')).toBeInTheDocument();
    expect(screen.getByText('second.pdf：文件传输失败')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开成果 report.pdf' })).toBeInTheDocument();
    view.rerender(<SharedDriveArtifacts run={{ ...restored, sharedDriveState: { ...restored.sharedDriveState!, remoteDeliveries: [{ taskId: 'remote_1', status: 'complete', errors: [] }] } }} canOpenFile={() => true} />);
    expect(screen.queryByText('文件未全部上传')).not.toBeInTheDocument();
  });
  it('远程没有成功文件或错误明细时仍提示未完成', () => {
    const remoteOnly: RunResponse = JSON.parse(JSON.stringify({ ...run, sharedDriveState: { uploads: [], downloads: [], remoteDeliveries: [{ taskId: 'remote_1', status: 'incomplete', errors: [] }] } }));
    render(<Timeline items={[{ kind: 'assistant_message', id: 'message', runId: run.id, text: '任务已结束', source: 'runtime' }]} runs={[remoteOnly]} />);
    expect(screen.getByText('文件未全部上传')).toBeInTheDocument();
  });
  it.each(['tasks/remote/report.pdf', './tasks/remote/report.pdf', 'tasks\\remote\\report.pdf'])('登记成果与回复路径 %s 只显示一张卡，保留其他文件和旧运行成果', path => {
    render(<Timeline items={[
      { kind: 'assistant_message', id: 'old', runId: 'old_run', text: '[旧报告](tasks/remote/report.pdf)', source: 'runtime' },
      { kind: 'assistant_message', id: 'message', runId: run.id, text: `[报告](${path}) 和 [附录](outputs/appendix.pdf)`, source: 'runtime' }
    ]} runs={[run]} onOpenFile={vi.fn()} canOpenFile={() => true} />);
    expect(screen.getAllByRole('button', { name: '打开成果 report.pdf' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: '打开成果 appendix.pdf' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '报告' })).toBeInTheDocument();
  });
  it('无需模型回复中的路径即可恢复成果，保留文件可读校验', () => {
    const open = vi.fn();
    const view = render(<SharedDriveArtifacts run={run} canOpenFile={() => true} onOpenFile={open} />);
    fireEvent.click(screen.getByRole('button', { name: '打开成果 report.pdf' }));
    expect(open).toHaveBeenCalledWith(artifact.logical_path);
    view.rerender(<SharedDriveArtifacts run={run} canOpenFile={() => false} />);
    expect(screen.getByText('本地文件不存在或不可读')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '打开成果 report.pdf' })).not.toBeInTheDocument();
  });
  it('同一轮回复多次引用同图只显示一次，保留其他目录和历史轮次的同名图', () => {
    const open = vi.fn();
    const view = render(<Timeline items={[
      { kind: 'assistant_message', id: 'old-image', runId: 'old_run', text: '[历史图](outputs/lake.png)', source: 'runtime' },
      { kind: 'assistant_message', id: 'preview-image', runId: run.id, text: '[预览图](./outputs/lake.png)', source: 'runtime' },
      { kind: 'assistant_message', id: 'final-image', runId: run.id, text: '[成品图](outputs/lake.png) 和 [另一张](other/lake.png)', source: 'runtime' }
    ]} onOpenFile={open} canOpenFile={() => true} />);
    expect(screen.getAllByRole('button', { name: '打开成果 lake.png' })).toHaveLength(3);
    fireEvent.click(screen.getByRole('link', { name: '预览图' }));
    expect(open).toHaveBeenCalledWith('./outputs/lake.png');
    view.unmount();
  });
  it('保留失败文件卡片，允许重试；终态 pending 明确显示中断', async () => {
    const retry = vi.fn(async () => undefined);
    render(<SharedDriveArtifacts run={{ ...run, sharedDriveState: { uploads: [{ path: 'a.txt', logicalPath: 'tasks/a.txt', status: 'pending' }], downloads: [{ artifact, status: 'failed', error: { file_name: 'report.pdf', code: 'LOCAL_EXISTS', message: '本地内容不同，已保留本地文件。' } }] } }} onRetry={retry} />);
    expect(screen.getByText('文件未全部上传')).toBeInTheDocument();
    expect(screen.getByText(/传输中断，尚未完成/)).toBeInTheDocument();
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText('本地内容不同，已保留本地文件。')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试下载' }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith('run_1'));
  });
});
