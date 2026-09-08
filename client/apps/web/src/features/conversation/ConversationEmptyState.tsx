import { BarChart3, Megaphone, Sparkles, TrendingUp } from 'lucide-react';

const starterActions = [
  { kind: 'dashboard', label: '数据分析', icon: BarChart3 },
  {
    kind: 'skill',
    label: '脚本选题生成',
    skillName: 'content-strategy',
    icon: TrendingUp
  },
  {
    kind: 'skill',
    label: '广告素材审核',
    skillName: 'ad-creative',
    icon: Sparkles
  },
  {
    kind: 'skill',
    label: '视频发布',
    skillName: 'marketing-video',
    icon: Megaphone
  }
] as const;

export function ConversationEmptyState(props: { nickname?: string; now?: Date }) {
  const nickname = props.nickname?.trim() || undefined;
  const greeting = timePeriodGreeting(props.now ?? new Date());
  const greetingText = nickname === undefined
    ? `${greeting}好`
    : `${greeting}好，${nickname}`;

  return (
    <section className="conversation-empty-state" aria-labelledby="conversation-empty-title">
      <div className="conversation-empty-greeting">
        <h2 id="conversation-empty-title">{greetingText}</h2>
        <p>需要帮你做点什么</p>
      </div>
    </section>
  );
}

export function ConversationStarterTags(props: {
  busySkillName?: string;
  error?: string;
  onOpenDashboard(): void;
  onLoadSkill(skillName: string): void;
}) {
  const busyAction = starterActions.find(action => (
    action.kind === 'skill' && action.skillName === props.busySkillName
  ));

  return (
    <div className="conversation-starter-actions">
      <div className="conversation-starter-tags" aria-label="常用场景">
        {starterActions.map((action) => {
          const Icon = action.icon;
          const busy = action.kind === 'skill' && action.skillName === props.busySkillName;
          return (
            <button
              className="conversation-starter-tag"
              type="button"
              key={action.label}
              disabled={props.busySkillName !== undefined}
              aria-busy={busy || undefined}
              onClick={action.kind === 'dashboard'
                ? props.onOpenDashboard
                : () => props.onLoadSkill(action.skillName)}
            >
              <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
              {action.label}
            </button>
          );
        })}
      </div>
      {busyAction !== undefined ? (
        <p className="conversation-starter-feedback" role="status">
          正在加载{busyAction.label} Skill
        </p>
      ) : props.error !== undefined ? (
        <p className="conversation-starter-feedback is-error" role="alert">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

export function timePeriodGreeting(now: Date): '上午' | '下午' | '晚上' {
  const hour = now.getHours();
  if (hour < 12) return '上午';
  if (hour < 18) return '下午';
  return '晚上';
}
