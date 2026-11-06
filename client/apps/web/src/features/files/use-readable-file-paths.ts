import { useEffect, useMemo, useState } from 'react';
import type { WorkspaceFileService } from './FileWorkspaceView.js';

const EMPTY_PATHS: ReadonlySet<string> = new Set();

export function useReadableFilePaths(input: {
  threadId?: string;
  paths: readonly string[];
  service: Pick<WorkspaceFileService, 'getMeta'> | null;
  refreshKey: string;
}): ReadonlySet<string> {
  const { threadId, service, refreshKey } = input;
  const pathsKey = JSON.stringify([...new Set(input.paths)]);
  const request = useMemo(() => ({
    threadId, service, paths: JSON.parse(pathsKey) as string[]
  }), [threadId, service, pathsKey, refreshKey]);
  const [result, setResult] = useState<{ request: typeof request; paths: ReadonlySet<string> }>();

  useEffect(() => {
    if (!request.threadId || !request.service) return;
    const { threadId, service } = request;
    let active = true;
    // 元信息接口会读取文件生成版本摘要；请求成功才确认文件存在且可读。
    void Promise.all(request.paths.map(async path => {
      try {
        const meta = await service.getMeta(threadId, path);
        return meta.type === 'file' ? path : undefined;
      } catch {
        return undefined;
      }
    })).then(paths => {
      if (active) setResult({ request, paths: new Set(paths.filter((path): path is string => path !== undefined)) });
    });
    return () => { active = false; };
  }, [request]);

  return result?.request === request ? result.paths : EMPTY_PATHS;
}
