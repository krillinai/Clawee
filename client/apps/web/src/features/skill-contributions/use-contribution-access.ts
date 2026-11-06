import { useEffect, useState } from 'react';
import type { createEnterpriseService } from '../../services/enterprise-service-2026-07-30.js';

export function useContributionAccess(service: ReturnType<typeof createEnterpriseService> | null, signedIn: boolean, identityKey: string) {
  const [access, setAccess] = useState<{ key: string; allowed: boolean; checking: boolean; error?: string }>({ key: '', allowed: false, checking: true });
  useEffect(() => {
    let stopped = false;
    setAccess({ key: identityKey, allowed: false, checking: signedIn });
    async function refresh() {
      if (!signedIn || !service) return;
      try {
        const result = await service.getSkillContributionCapability();
        if (!stopped) setAccess({ key: identityKey, allowed: result.allowed, checking: false });
      } catch {
        if (!stopped) setAccess({ key: identityKey, allowed: false, checking: false, error: 'Skill 贡献授权暂不可用' });
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    window.addEventListener('focus', refresh);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [service, signedIn, identityKey]);
  return {
    allowed: signedIn && access.key === identityKey && access.allowed,
    checking: access.key !== identityKey || access.checking,
    error: access.key === identityKey ? access.error : undefined,
    revoke: () => setAccess({ key: identityKey, allowed: false, checking: false })
  };
}
