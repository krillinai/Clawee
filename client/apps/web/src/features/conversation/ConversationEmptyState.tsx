import { Blocks, BookOpen, GitBranch, LayoutDashboard } from 'lucide-react';

const starterActions = [
  { view: 'dashboard', label: '工作台', icon: LayoutDashboard },
  { view: 'workflow', label: '工作流', icon: GitBranch },
  { view: 'plugins', label: '企业Skills', icon: Blocks },
  { view: 'knowledge', label: '企业知识库', icon: BookOpen }
] as const;

export type ConversationStarterView = typeof starterActions[number]['view'];

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
  onOpenView(view: ConversationStarterView): void;
}) {
  return (
    <div className="conversation-starter-actions">
      <div className="conversation-starter-tags" aria-label="常用场景">
        {starterActions.map((action) => {
          const Icon = action.icon;
          return (
            <button
              className="conversation-starter-tag"
              type="button"
              key={action.label}
              onClick={() => props.onOpenView(action.view)}
            >
              <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
              {action.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function timePeriodGreeting(now: Date): '上午' | '下午' | '晚上' {
  const hour = now.getHours();
  if (hour < 12) return '上午';
  if (hour < 18) return '下午';
  return '晚上';
}
