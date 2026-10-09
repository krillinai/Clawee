import { acquireRuntimeLock, RuntimeLockError } from '../../src/runtime-lock.js';

try {
  const release = await acquireRuntimeLock(process.argv[2]!);
  process.on('message', () => {
    void release().then(() => process.exit(0));
  });
  process.send?.({ type: 'ready' });
} catch (error) {
  process.send?.({ type: 'failed', code: error instanceof RuntimeLockError ? error.code : String(error) });
  process.exit(1);
}
