import { useEffect, useState } from 'react';
import { SkillAuthorAvatar } from './SkillMarketCover.js';

export function EnterpriseSkillParticipantAvatar(props: {
  skillId: string;
  userId?: string;
  name: string;
  src?: string;
  onLoadAvatar?(skillId: string, userId: string): Promise<Response>;
}) {
  const [objectUrl, setObjectUrl] = useState<string>();
  const { skillId, userId, src, onLoadAvatar } = props;

  useEffect(() => {
    setObjectUrl(undefined);
    if (userId === undefined || src === undefined || onLoadAvatar === undefined) return;
    let canceled = false;
    let createdUrl: string | undefined;
    void onLoadAvatar(skillId, userId)
      .then(async response => {
        if (!response.ok) return;
        const blob = await response.blob();
        if (canceled) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      })
      .catch(() => undefined);
    return () => {
      canceled = true;
      if (createdUrl !== undefined) URL.revokeObjectURL(createdUrl);
    };
  }, [skillId, userId, src, onLoadAvatar]);

  if (objectUrl !== undefined) {
    return <img alt={props.name} className="skill-market-avatar skill-market-avatar--small" src={objectUrl} onError={() => setObjectUrl(undefined)} />;
  }
  return <SkillAuthorAvatar name={props.name} src={onLoadAvatar === undefined ? src : undefined} />;
}
