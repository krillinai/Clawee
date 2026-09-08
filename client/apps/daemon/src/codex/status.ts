import type {
  CodexAvailabilityProbe,
  CodexRuntimeStatus,
  CodexStatusResponse
} from '@clawee/protocol';
import type { RuntimeCapabilityMatrix } from './capabilities.js';
import type { ResolvedCodexHome } from './home.js';

export type BuildCodexStatusResponseInput = {
  codexBin: string;
  codexHome: ResolvedCodexHome;
  capabilities: RuntimeCapabilityMatrix;
  runtime: CodexRuntimeStatus;
  availabilityProbe?: CodexAvailabilityProbe;
};

export function buildCodexStatusResponse(
  input: BuildCodexStatusResponseInput
): CodexStatusResponse {
  const diagnostics = input.availabilityProbe?.status === 'failed'
    ? [
        `Codex 后台可用性验证失败：${
          input.availabilityProbe.message ?? input.availabilityProbe.errorCode ?? '未知错误'
        }`
      ]
    : [];
  return {
    codexBin: input.codexBin,
    codexVersion: input.capabilities.codexVersion,
    codexHome: input.codexHome.path,
    codexHomeMode: input.codexHome.mode,
    codexHomeSource: input.codexHome.source,
    codexHomeWritable: input.codexHome.writable,
    capabilities: input.capabilities,
    diagnostics,
    runtime: { ...input.runtime },
    ...(input.availabilityProbe === undefined
      ? {}
      : { availabilityProbe: { ...input.availabilityProbe } })
  };
}
