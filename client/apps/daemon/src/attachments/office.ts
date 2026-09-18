import { Worker } from 'node:worker_threads';
import type { RuntimeErrorCode } from '@clawee/protocol';

export const OFFICE_ATTACHMENT_FORMATS: Record<string, 'docx' | 'xlsx' | 'pptx'> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx'
};
export const OFFICE_PARSE_TIMEOUT_MS = 15_000;

export type OfficeExtraction = { content: string; detail?: string };
export type OfficeWorkerRequest = {
  content: Uint8Array;
  mime: string;
  format: 'docx' | 'xlsx' | 'pptx';
  mode: 'validate' | 'extract';
  maxChars: number;
};
type OfficeWorkerResponse = OfficeExtraction | {
  error: { code: RuntimeErrorCode; message: string };
};

export class OfficeAttachmentError extends Error {
  constructor(readonly code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = 'OfficeAttachmentError';
  }
}

export function processOfficeAttachment(
  content: Buffer,
  mime: string,
  mode: OfficeWorkerRequest['mode'],
  maxChars = 40_000
): Promise<OfficeExtraction> {
  return new Promise((resolve, reject) => {
    const format = OFFICE_ATTACHMENT_FORMATS[mime];
    if (format === undefined) {
      reject(new OfficeAttachmentError('ATTACHMENT_TYPE_UNSUPPORTED', '不支持此 Office 附件类型'));
      return;
    }
    // Node 24 开发环境直接运行 TS，打包后只加载编译产物，不依赖 tsx。
    const worker = new Worker(new URL(
      import.meta.url.endsWith('.ts') ? './office-worker.ts' : './office-worker.js',
      import.meta.url
    ), {
      execArgv: [],
      workerData: { content, mime, format, mode, maxChars } satisfies OfficeWorkerRequest,
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 }
    });
    let settled = false;
    const timer = setTimeout(() => void finish(undefined, new OfficeAttachmentError(
      'ATTACHMENT_TYPE_UNSUPPORTED', 'Office 附件解析超时，请缩小文件后重试'
    )), OFFICE_PARSE_TIMEOUT_MS);

    async function finish(result?: OfficeExtraction, error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await worker.terminate().catch(() => undefined);
      if (error !== undefined) reject(error);
      else resolve(result!);
    }
    worker.once('message', (response: OfficeWorkerResponse) => {
      if ('error' in response) {
        void finish(undefined, new OfficeAttachmentError(response.error.code, response.error.message));
      } else void finish(response);
    });
    worker.once('error', () => void finish(undefined, new OfficeAttachmentError(
      'ATTACHMENT_TYPE_UNSUPPORTED', 'Office 附件解析失败或超出资源限制'
    )));
    worker.once('exit', () => void finish(undefined, new OfficeAttachmentError(
      'ATTACHMENT_TYPE_UNSUPPORTED', 'Office 附件解析进程异常退出'
    )));
  });
}
