import { act, renderHook, waitFor } from '@testing-library/react';
import type { WorkspaceFileMeta } from '@clawee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { useReadableFilePaths } from './use-readable-file-paths.js';

const meta: WorkspaceFileMeta = {
  path: 'report.md', name: 'report.md', type: 'file', kind: 'markdown', mime: 'text/markdown',
  size: 0, mtimeMs: 1, versionToken: 'v1', previewable: false, editable: false, readonly: true
};

describe('会话文件可读性校验', () => {
  it('检查完成前隐藏文件，仅保留检查成功的文件，允许空文件和只读文件', async () => {
    let resolveMeta!: (value: WorkspaceFileMeta) => void;
    const getMeta = vi.fn((threadId: string, path: string): Promise<WorkspaceFileMeta> => {
      if (path === 'report.md') return new Promise(resolve => { resolveMeta = resolve; });
      return Promise.reject(new Error(path));
    });
    const service = { getMeta };
    const { result } = renderHook(() => useReadableFilePaths({
      threadId: 'thread-1', paths: ['report.md', 'missing.md', 'denied.pdf', 'network.html'],
      service, refreshKey: 'idle'
    }));

    expect(result.current.size).toBe(0);
    expect(getMeta).toHaveBeenCalledWith('thread-1', 'report.md');
    await act(async () => resolveMeta(meta));
    expect([...result.current]).toEqual(['report.md']);
  });

  it('相同路径去重，流式文本更新但路径不变时不重复检查', async () => {
    const getMeta = vi.fn(async () => meta);
    const service = { getMeta };
    const { result, rerender } = renderHook(({ paths }) => useReadableFilePaths({
      threadId: 'thread-1', paths, service, refreshKey: 'running'
    }), { initialProps: { paths: ['report.md', 'report.md'] } });

    await waitFor(() => expect(result.current.has('report.md')).toBe(true));
    rerender({ paths: ['report.md', 'report.md'] });
    expect(result.current.has('report.md')).toBe(true);
    expect(getMeta).toHaveBeenCalledTimes(1);
  });

  it('任务结束后重新检查，文件稍后写入才显示，删除后检查失败则隐藏', async () => {
    const getMeta = vi.fn()
      .mockRejectedValueOnce(new Error('FILE_NOT_FOUND'))
      .mockResolvedValueOnce(meta)
      .mockRejectedValueOnce(new Error('FILE_NOT_FOUND'));
    const service = { getMeta };
    const { result, rerender } = renderHook(({ refreshKey }) => useReadableFilePaths({
      threadId: 'thread-1', paths: ['report.md'], service, refreshKey
    }), { initialProps: { refreshKey: 'running' } });

    await act(async () => {});
    expect(result.current.size).toBe(0);
    rerender({ refreshKey: 'done-1' });
    expect(result.current.size).toBe(0);
    await waitFor(() => expect(result.current.has('report.md')).toBe(true));
    rerender({ refreshKey: 'done-2' });
    expect(result.current.size).toBe(0);
    await act(async () => {});
    expect(result.current.size).toBe(0);
    expect(getMeta).toHaveBeenCalledTimes(3);
  });

  it.each(['thread', 'service'] as const)('切换 %s 后立即隐藏旧结果，并忽略旧请求的延迟响应', async change => {
    let resolveOld!: (value: WorkspaceFileMeta) => void;
    const oldService = { getMeta: vi.fn((threadId: string): Promise<WorkspaceFileMeta> => {
      if (threadId === 'thread-2') return Promise.reject(new Error('PERMISSION_DENIED'));
      return new Promise(resolve => { resolveOld = resolve; });
    }) };
    const newService = { getMeta: vi.fn(async () => { throw new Error('PERMISSION_DENIED'); }) };
    const { result, rerender } = renderHook(props => useReadableFilePaths({
      ...props, paths: ['report.md'], refreshKey: 'idle'
    }), { initialProps: { threadId: 'thread-1', service: oldService } });

    rerender({ threadId: change === 'thread' ? 'thread-2' : 'thread-1', service: change === 'thread' ? oldService : newService });
    expect(result.current.size).toBe(0);
    await act(async () => resolveOld(meta));
    expect(result.current.size).toBe(0);
    expect((change === 'thread' ? oldService : newService).getMeta).toHaveBeenCalledWith(change === 'thread' ? 'thread-2' : 'thread-1', 'report.md');
  });

  it('没有会话或文件服务时不显示文件', () => {
    const { result } = renderHook(() => useReadableFilePaths({
      paths: ['report.md'], service: null, refreshKey: 'idle'
    }));
    expect(result.current.size).toBe(0);
  });
});
