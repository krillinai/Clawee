import { BoundedFrameBuffer } from './bounded-buffer.js';

const MAX_APP_SERVER_FRAME_BYTES = 32 * 1024 * 1024;

export class AppServerFrameBuffer extends BoundedFrameBuffer {
  constructor() {
    super(MAX_APP_SERVER_FRAME_BYTES);
  }

  override push(chunk: string): string[] {
    const frames = super.push(chunk);
    // RPC 响应和任务完成通知不可丢弃，否则调用方只能等到超时。
    if (this.truncation().truncated) {
      throw Object.assign(new Error(
        `Codex app-server message exceeds ${MAX_APP_SERVER_FRAME_BYTES} byte limit`
      ), { code: 'CODEX_APP_SERVER_FRAME_TOO_LARGE' });
    }
    return frames;
  }
}
