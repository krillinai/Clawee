import { fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchModuleLayout } from './WorkbenchModuleLayout.js';

afterEach(() => { window.dispatchEvent(new Event('blur')); });

function renderDesktopLayout() {
  const view = render(<WorkbenchModuleLayout workspace={<div>看板内容</div>}
    conversation={<aside>模块对话内容</aside>} onBack={vi.fn()} />);
  const layout = view.container.firstChild as HTMLElement;
  const bounds = vi.spyOn(layout, 'getBoundingClientRect').mockReturnValue({
    width: 1200, height: 800, left: 0, right: 1200, top: 0, bottom: 800, x: 0, y: 0, toJSON: () => ({})
  });
  fireEvent.resize(window);
  return { ...view, layout, bounds, separator: screen.getByRole('separator', { name: '调整模块和对话区域宽度' }) };
}

describe('WorkbenchModuleLayout', () => {
  it('drags the shared divider and stops resizing after release', () => {
    const { layout, separator } = renderDesktopLayout();
    fireEvent.mouseDown(separator, { button: 0, clientX: 780 });
    fireEvent.mouseMove(window, { clientX: 650 });
    expect(layout.style.getPropertyValue('--workbench-conversation-width')).toBe('550px');
    expect(separator).toHaveAttribute('aria-valuenow', '550');
    expect(document.documentElement).toHaveClass('is-pane-resizing');
    fireEvent.mouseUp(window);
    expect(document.documentElement).not.toHaveClass('is-pane-resizing');
    fireEvent.mouseMove(window, { clientX: 400 });
    expect(separator).toHaveAttribute('aria-valuenow', '550');
  });

  it('limits dragging to readable widths and clamps the conversation when the window becomes narrower', () => {
    const { separator, bounds } = renderDesktopLayout();
    fireEvent.mouseDown(separator, { button: 0, clientX: 100 });
    expect(separator).toHaveAttribute('aria-valuenow', '640');
    fireEvent.mouseMove(window, { clientX: 1190 });
    expect(separator).toHaveAttribute('aria-valuenow', '320');
    fireEvent.mouseMove(window, { clientX: 100 });
    fireEvent.mouseUp(window);
    bounds.mockReturnValue({ width: 950, height: 800, left: 0, right: 950, top: 0, bottom: 800, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.resize(window);
    expect(separator).toHaveAttribute('aria-valuenow', '469');
    expect(separator).toHaveAttribute('aria-valuemax', '469');
  });

  it('supports keyboard resizing and releases the drag shield on unmount', () => {
    const { separator, unmount } = renderDesktopLayout();
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(separator).toHaveAttribute('aria-valuenow', '440');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '420');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', '320');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '640');
    fireEvent.mouseDown(separator, { button: 0, clientX: 780 });
    expect(document.querySelector('.pane-resize-shield')).not.toBeNull();
    unmount();
    expect(document.querySelector('.pane-resize-shield')).toBeNull();
    expect(document.documentElement).not.toHaveClass('is-pane-resizing');
  });

  it('switches mobile views without unmounting the conversation and supports returning to the directory', async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    const unmount = vi.fn();
    function Conversation() {
      useEffect(() => () => unmount(), []);
      return <aside>模块对话内容</aside>;
    }
    const view = render(<WorkbenchModuleLayout workspace={<div>看板内容</div>}
      conversation={<Conversation />} onBack={onBack} />);
    await user.click(screen.getByRole('button', { name: '对话' }));
    expect(view.container.firstChild).toHaveAttribute('data-mobile-view', 'conversation');
    await user.click(screen.getByRole('button', { name: '看板' }));
    expect(view.container.firstChild).toHaveAttribute('data-mobile-view', 'workspace');
    expect(unmount).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '返回模块目录' }));
    expect(onBack).toHaveBeenCalledOnce();
  });
});
