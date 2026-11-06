import { useEffect, useRef } from 'react';

export function useRunRecoveryTriggers(recover: () => void, connected: boolean) {
  const recoverRef = useRef(recover);
  const previousConnected = useRef(connected);
  recoverRef.current = recover;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const trigger = () => {
      if (document.visibilityState === 'hidden' || timer !== undefined) return;
      timer = setTimeout(() => { timer = undefined; recoverRef.current(); }, 100);
    };
    if (connected && !previousConnected.current) trigger();
    previousConnected.current = connected;
    window.addEventListener('online', trigger);
    window.addEventListener('focus', trigger);
    document.addEventListener('visibilitychange', trigger);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('online', trigger);
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', trigger);
    };
  }, [connected]);
}
