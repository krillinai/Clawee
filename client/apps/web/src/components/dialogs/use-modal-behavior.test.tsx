import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useConfirmDialog } from './ConfirmDialog.js';
import { useModalBehavior } from './use-modal-behavior.js';

function Modal(props: { name: string; open: boolean; onClose(): void; children?: React.ReactNode }) {
  const ref = useRef<HTMLElement | null>(null);
  useModalBehavior(ref, { open: props.open, onClose: props.onClose });
  if (!props.open) return null;
  return (
    <section ref={ref} role="dialog" aria-modal="true" aria-label={props.name}>
      <button type="button">{props.name} 第一项</button>
      <button type="button">{props.name} 最后一项</button>
      {props.children}
    </section>
  );
}

describe('useModalBehavior', () => {
  it('closes only the topmost modal on Escape', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    render(
      <Modal name="外层" open onClose={closeOuter}>
        <Modal name="内层" open onClose={closeInner} />
      </Modal>
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
  });

  it('keeps Tab focus inside the dialog', () => {
    render(<Modal name="弹窗" open onClose={vi.fn()} />);
    const first = screen.getByRole('button', { name: '弹窗 第一项' });
    const last = screen.getByRole('button', { name: '弹窗 最后一项' });

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores focus to the trigger and unlocks scroll after closing', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>打开</button>
          <Modal name="弹窗" open={open} onClose={() => setOpen(false)} />
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
  });
});

describe('useConfirmDialog', () => {
  function Harness(props: { onResult(confirmed: boolean): void }) {
    const { confirm, confirmDialog } = useConfirmDialog();
    return (
      <>
        <button
          type="button"
          onClick={() => void confirm({
            title: '删除项目',
            description: '删除后无法恢复',
            confirmLabel: '删除',
            destructive: true
          }).then(props.onResult)}
        >
          删除
        </button>
        {confirmDialog}
      </>
    );
  }

  it('resolves true on confirm and false on Escape', async () => {
    const onResult = vi.fn();
    render(<Harness onResult={onResult} />);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    const dialog = screen.getByRole('alertdialog', { name: '删除项目' });
    fireEvent.click(dialog.querySelector('.confirm-dialog-danger')!);
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(true));

    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(screen.getByRole('alertdialog', { name: '删除项目' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onResult).toHaveBeenLastCalledWith(false));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
