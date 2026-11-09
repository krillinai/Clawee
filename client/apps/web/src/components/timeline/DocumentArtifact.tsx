import { ChevronDown, ExternalLink, FileText, FolderOpen } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type DocumentArtifactActions = {
  open(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  revealLabel: string;
};

export function DocumentArtifact(props: {
  path: string;
  fileName: string;
  typeLabel: string;
  onPreview?(path: string): void;
  actions?: DocumentArtifactActions;
}) {
  const [menu, setMenu] = useState<{ right: number; top?: number; bottom?: number }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
    function dismiss(event: PointerEvent) {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setMenu(undefined);
    }
    function keydown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMenu(undefined);
      triggerRef.current?.focus();
    }
    function close() { setMenu(undefined); }
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', keydown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  function showMenu() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect || !props.actions) return;
    setMenu({
      right: Math.max(8, window.innerWidth - rect.right),
      ...(window.innerHeight - rect.bottom >= 100
        ? { top: rect.bottom + 4 }
        : { bottom: window.innerHeight - rect.top + 4 })
    });
  }

  async function execute(action: 'open' | 'reveal') {
    if (busy || !props.actions) return;
    setMenu(undefined);
    triggerRef.current?.focus();
    setBusy(true);
    setError(undefined);
    try {
      await props.actions[action](props.path);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法完成文件操作，请重试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="timeline-document-artifact">
      <div className="timeline-artifact-card timeline-document-card" aria-busy={busy}>
        <button
          type="button"
          className="timeline-artifact-preview"
          title={props.fileName}
          aria-label={`打开成果 ${props.fileName}`}
          onClick={() => { setError(undefined); props.onPreview?.(props.path); }}
        >
          <FileText aria-hidden="true" size={17} />
          <span className="timeline-artifact-copy">
            <strong>{props.fileName}</strong>
            <span>{props.typeLabel}</span>
          </span>
          <span className="timeline-artifact-action">预览</span>
        </button>
        {props.actions ? (
          <button
            ref={triggerRef}
            type="button"
            className="timeline-artifact-menu-trigger"
            aria-label={`文档操作 ${props.fileName}`}
            aria-haspopup="menu"
            aria-expanded={menu !== undefined}
            aria-controls={menu ? menuId : undefined}
            disabled={busy}
            onClick={() => menu ? setMenu(undefined) : showMenu()}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); showMenu(); }
            }}
          >
            <ChevronDown aria-hidden="true" size={14} />
          </button>
        ) : null}
      </div>
      {error ? <p className="inline-error timeline-artifact-error" role="alert">{error}</p> : null}
      {menu && props.actions ? createPortal(
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label={`文档操作 ${props.fileName}`}
          className="timeline-artifact-menu"
          style={menu}
          onBlur={event => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)
              && event.relatedTarget !== triggerRef.current) setMenu(undefined);
          }}
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
            const current = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
              : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          <button type="button" role="menuitem" onClick={() => void execute('open')}>
            <ExternalLink aria-hidden="true" size={15} />使用默认应用打开
          </button>
          <button type="button" role="menuitem" onClick={() => void execute('reveal')}>
            <FolderOpen aria-hidden="true" size={15} />{props.actions.revealLabel}
          </button>
        </div>, document.body
      ) : null}
    </div>
  );
}
