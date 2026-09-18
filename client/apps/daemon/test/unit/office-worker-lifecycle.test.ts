import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFICE_PARSE_TIMEOUT_MS, processOfficeAttachment } from '../../src/attachments/office.js';

const workers = vi.hoisted(() => ({ instances: [] as Array<EventEmitter & { terminate: ReturnType<typeof vi.fn> }> }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    terminate = vi.fn(async () => 0);
    constructor() {
      super();
      workers.instances.push(this);
    }
  }
}));
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
afterEach(() => {
  vi.useRealTimers();
  workers.instances = [];
});

describe('Office Worker lifecycle', () => {
  it('terminates a hung worker at the deadline', async () => {
    vi.useFakeTimers();
    const result = processOfficeAttachment(Buffer.from('file'), MIME, 'extract');
    const rejected = expect(result).rejects.toMatchObject({ message: expect.stringContaining('超时') });
    await vi.advanceTimersByTimeAsync(OFFICE_PARSE_TIMEOUT_MS);
    await rejected;
    expect(workers.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it('terminates the worker after receiving parsed content', async () => {
    const result = processOfficeAttachment(Buffer.from('file'), MIME, 'extract');
    workers.instances[0]!.emit('message', { content: 'document text' });
    await expect(result).resolves.toEqual({ content: 'document text' });
    expect(workers.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it.each(['error', 'exit'])('handles a worker %s without hanging', async event => {
    const result = processOfficeAttachment(Buffer.from('file'), MIME, 'extract');
    workers.instances[0]!.emit(event, event === 'error' ? new Error('out of memory') : 1);
    await expect(result).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    expect(workers.instances[0]!.terminate).toHaveBeenCalledOnce();
  });
});
