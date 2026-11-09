import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalBehavior } from './use-modal-behavior.js';

export type ConfirmOptions = {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
};

export function ConfirmDialog(props: ConfirmOptions & {
  open: boolean;
  className?: string;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  useModalBehavior(dialogRef, {
    open: props.open,
    onClose: props.onCancel,
    closeDisabled: props.busy,
    initialFocusRef: cancelButtonRef
  });

  if (!props.open) return null;

  return createPortal(
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !props.busy) props.onCancel();
      }}
    >
      <section
        ref={dialogRef}
        className={[
          'confirm-dialog',
          props.className
        ].filter(Boolean).join(' ')}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>{props.title}</h2>
          <p id={descriptionId}>{props.description}</p>
        </header>
        <footer>
          <button
            ref={cancelButtonRef}
            type="button"
            className="button-secondary"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {props.cancelLabel ?? '取消'}
          </button>
          <button
            type="button"
            className={props.destructive ? 'confirm-dialog-danger' : 'button-primary'}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? '处理中' : props.confirmLabel}
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}

/**
 * Promise-based replacement for window.confirm that renders the in-app
 * ConfirmDialog. Render the returned element once in the component.
 */
export function useConfirmDialog() {
  const [pending, setPending] = useState<ConfirmOptions>();
  const resolverRef = useRef<(confirmed: boolean) => void>();

  useEffect(() => () => {
    resolverRef.current?.(false);
    resolverRef.current = undefined;
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    resolverRef.current?.(false);
    return new Promise<boolean>(resolve => {
      resolverRef.current = resolve;
      setPending(options);
    });
  }, []);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = undefined;
    setPending(undefined);
    resolve?.(confirmed);
  }, []);

  const onCancel = useCallback(() => settle(false), [settle]);
  const onConfirm = useCallback(() => settle(true), [settle]);

  const element = (
    <ConfirmDialog
      open={pending !== undefined}
      title={pending?.title ?? ''}
      description={pending?.description ?? ''}
      confirmLabel={pending?.confirmLabel ?? '确定'}
      {...(pending?.cancelLabel === undefined ? {} : { cancelLabel: pending.cancelLabel })}
      destructive={pending?.destructive === true}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );

  return { confirm, confirmDialog: element };
}
