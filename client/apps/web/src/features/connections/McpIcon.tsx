import {
  Brain,
  Chrome,
  Cloud,
  Database,
  FileText,
  Figma,
  FolderOpen,
  Github,
  Hexagon,
  Mail,
  MessageSquare,
  Monitor,
  MousePointer2,
  Palette,
  Plug,
  Search,
  Slack,
  SquareTerminal,
  Users,
  type LucideIcon
} from 'lucide-react';
import './mcp-icon.css';

type McpIconSize = 'compact' | 'default';

export type McpIconProps = {
  name: string;
  detail?: string;
  size?: McpIconSize;
  className?: string;
};

type McpIconDefinition = {
  icon?: LucideIcon;
  customMark?: 'computer-use' | 'node-repl';
  glyph: string;
  tone?: McpIconTone;
};

type McpIconTone =
  | 'amber'
  | 'blue'
  | 'coral'
  | 'cyan'
  | 'green'
  | 'pink'
  | 'teal'
  | 'violet';

const fallbackTones: McpIconTone[] = [
  'blue',
  'teal',
  'amber',
  'coral',
  'violet',
  'green',
  'pink',
  'cyan'
];

export function McpIcon({
  name,
  detail = '',
  size = 'default',
  className
}: McpIconProps) {
  const definition = resolveMcpIcon(name, detail);
  const tone = definition.tone ?? stableTone(name);
  const Icon = definition.icon;
  const classes = ['mcp-icon', `mcp-icon--${size}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={classes}
      data-mcp-icon={definition.glyph}
      data-tone={tone}
      data-kind={definition.customMark}
      aria-hidden="true"
    >
      {definition.customMark === 'computer-use' ? (
        <span className="mcp-icon__computer-mark">
          <Monitor aria-hidden="true" className="mcp-icon__computer-screen" />
          <span className="mcp-icon__computer-pointer">
            <MousePointer2 aria-hidden="true" fill="currentColor" />
          </span>
        </span>
      ) : null}
      {definition.customMark === 'node-repl' ? (
        <span className="mcp-icon__node-mark">
          <Hexagon aria-hidden="true" fill="currentColor" strokeWidth={1.4} />
          <span>&gt;_</span>
        </span>
      ) : null}
      {Icon === undefined ? null : (
        <Icon className="mcp-icon__main" size={size === 'compact' ? 14 : 20} strokeWidth={2} />
      )}
    </span>
  );
}

function resolveMcpIcon(name: string, detail: string): McpIconDefinition {
  const specific = matchSpecificMcp(`${name} ${detail}`.toLowerCase());
  if (specific !== undefined) return specific;

  const named = matchMcpIdentity(name.toLowerCase());
  if (named !== undefined) return named;

  const described = matchMcpIdentity(detail.toLowerCase());
  if (described !== undefined) return described;

  return { icon: Plug, glyph: 'plug' };
}

function matchSpecificMcp(identity: string): McpIconDefinition | undefined {
  const normalized = identity.replace(/[\s_]+/g, '-');
  if (
    normalized.includes('computer-use')
    || normalized.includes('skycomputeruseclient')
  ) {
    return {
      customMark: 'computer-use',
      glyph: 'computer-use',
      tone: 'coral'
    };
  }
  if (normalized.includes('node-repl')) {
    return {
      customMark: 'node-repl',
      glyph: 'node-repl',
      tone: 'green'
    };
  }
  return undefined;
}

function matchMcpIdentity(identity: string): McpIconDefinition | undefined {
  if (includesAny(identity, ['github', 'gitlab', 'bitbucket'])) {
    return { icon: Github, glyph: 'source', tone: 'violet' };
  }
  if (identity.includes('slack')) {
    return { icon: Slack, glyph: 'slack', tone: 'pink' };
  }
  if (includesAny(identity, ['figma', 'design', '设计'])) {
    return { icon: Figma, glyph: 'design', tone: 'coral' };
  }
  if (includesAny(identity, ['browser', 'chrome', 'playwright', '浏览器'])) {
    return { icon: Chrome, glyph: 'browser', tone: 'blue' };
  }
  if (includesAny(identity, ['database', 'postgres', 'mysql', 'sqlite', '数据库'])) {
    return { icon: Database, glyph: 'database', tone: 'green' };
  }
  if (includesAny(identity, ['knowledge', 'memory', '知识', '记忆'])) {
    return { icon: Brain, glyph: 'knowledge', tone: 'teal' };
  }
  if (includesAny(identity, ['filesystem', 'folder', '文件夹'])) {
    return { icon: FolderOpen, glyph: 'files', tone: 'amber' };
  }
  if (includesAny(identity, ['notion', 'docs', 'document', '文档'])) {
    return { icon: FileText, glyph: 'documents', tone: 'amber' };
  }
  if (includesAny(identity, ['search', '搜索'])) {
    return { icon: Search, glyph: 'search', tone: 'cyan' };
  }
  if (includesAny(identity, ['mail', 'email', '邮箱', '邮件'])) {
    return { icon: Mail, glyph: 'mail', tone: 'coral' };
  }
  if (includesAny(identity, ['crm', 'salesforce', 'customer', '客户'])) {
    return { icon: Users, glyph: 'customers', tone: 'teal' };
  }
  if (includesAny(identity, ['chat', 'message', '消息', '对话'])) {
    return { icon: MessageSquare, glyph: 'messages', tone: 'pink' };
  }
  if (includesAny(identity, ['canvas', 'palette', 'creative', '创意'])) {
    return { icon: Palette, glyph: 'creative', tone: 'coral' };
  }
  if (includesAny(identity, ['stdio', 'terminal', 'shell', '命令行'])) {
    return { icon: SquareTerminal, glyph: 'terminal' };
  }
  if (includesAny(identity, ['http', 'sse', 'cloud', 'remote', '云端'])) {
    return { icon: Cloud, glyph: 'cloud' };
  }
  return undefined;
}

function includesAny(identity: string, keywords: string[]): boolean {
  return keywords.some(keyword => identity.includes(keyword));
}

function stableTone(identity: string): McpIconTone {
  let hash = 0;
  for (const character of identity.trim().toLowerCase()) {
    hash = ((hash << 5) - hash + character.codePointAt(0)!) | 0;
  }
  return fallbackTones[Math.abs(hash) % fallbackTones.length]!;
}
