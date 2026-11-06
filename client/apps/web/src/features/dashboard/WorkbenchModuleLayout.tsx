import { ArrowLeft } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { beginPaneResize } from '../../components/layout/pane-resize-2026-07-29.js';

const MIN_CONVERSATION_WIDTH = 320;
const MAX_CONVERSATION_WIDTH = 640;
const MIN_WORKSPACE_WIDTH = 480;

export function WorkbenchModuleLayout(props: { workspace: ReactNode; conversation: ReactNode; onBack(): void }) {
  const [mobileView, setMobileView] = useState<'workspace' | 'conversation'>('workspace');
  const [conversationWidth, setConversationWidth] = useState(420);
  const [maxConversationWidth, setMaxConversationWidth] = useState(MAX_CONVERSATION_WIDTH);
  const layoutRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<() => void>();

  useEffect(() => {
    function updateBounds() {
      const width = layoutRef.current?.getBoundingClientRect().width;
      if (width === undefined || width <= 920) return;
      const maximum = Math.min(MAX_CONVERSATION_WIDTH, Math.max(MIN_CONVERSATION_WIDTH, width - MIN_WORKSPACE_WIDTH - 1));
      setMaxConversationWidth(maximum);
      setConversationWidth(previous => Math.min(maximum, Math.max(MIN_CONVERSATION_WIDTH, previous)));
    }
    updateBounds();
    window.addEventListener('resize', updateBounds);
    return () => {
      window.removeEventListener('resize', updateBounds);
      resizeCleanupRef.current?.();
    };
  }, []);

  function updateConversationWidth(clientX: number) {
    const bounds = layoutRef.current?.getBoundingClientRect();
    if (bounds === undefined) return;
    setConversationWidth(Math.min(maxConversationWidth, Math.max(MIN_CONVERSATION_WIDTH, bounds.right - clientX)));
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    setConversationWidth(previous => event.key === 'Home' ? MIN_CONVERSATION_WIDTH
      : event.key === 'End' ? maxConversationWidth
      : Math.min(maxConversationWidth, Math.max(MIN_CONVERSATION_WIDTH, previous + (event.key === 'ArrowLeft' ? 20 : -20))));
  }

  const layoutStyle = { '--workbench-conversation-width': `${conversationWidth}px` } as CSSProperties;
  return <div className="workbench-module-layout" data-mobile-view={mobileView} ref={layoutRef} style={layoutStyle}>
    <div className="workbench-module-mobile-toolbar">
      <button aria-label="返回模块目录" onClick={props.onBack} type="button"><ArrowLeft size={18} aria-hidden="true" /></button>
      <div role="group" aria-label="模块视图">
        <button aria-pressed={mobileView === 'workspace'} onClick={() => setMobileView('workspace')} type="button">看板</button>
        <button aria-pressed={mobileView === 'conversation'} onClick={() => setMobileView('conversation')} type="button">对话</button>
      </div>
    </div>
    <div className="workbench-module-workspace">{props.workspace}</div>
    <div className="pane-resize-handle workbench-module-resize-handle" role="separator"
      aria-label="调整模块和对话区域宽度" aria-orientation="vertical"
      aria-valuemin={MIN_CONVERSATION_WIDTH} aria-valuemax={maxConversationWidth} aria-valuenow={conversationWidth}
      aria-valuetext={`${conversationWidth} 像素`}
      tabIndex={0} onMouseDown={event => { resizeCleanupRef.current = beginPaneResize(event, updateConversationWidth); }}
      onKeyDown={handleResizeKeyDown} />
    {props.conversation}
  </div>;
}
