import { type RefObject, useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open modals in mount order; only the topmost one handles Escape and Tab.
const modalStack: Array<{ ref: RefObject<HTMLElement> }> = [];
let scrollLockCount = 0;
let previousBodyOverflow = '';

export function getFocusableElements(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Shared modal keyboard and focus behavior: Escape closes the topmost modal,
 * Tab stays inside it, body scroll is locked, and focus returns to the
 * previously focused element on close.
 */
export function useModalBehavior(
  dialogRef: RefObject<HTMLElement>,
  options: {
    open: boolean;
    onClose(): void;
    // When true, Escape is ignored (for example while a request is pending).
    closeDisabled?: boolean;
    initialFocusRef?: RefObject<HTMLElement>;
    // Set to false when the caller restores focus itself.
    restoreFocus?: boolean;
  }
) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!options.open) return;
    const token = { ref: dialogRef };
    // A modal nested inside this one stays above it even when both mount together.
    const nestedIndex = modalStack.findIndex(entry => {
      const own = dialogRef.current;
      const other = entry.ref.current;
      return own !== null && other !== null && own !== other && own.contains(other);
    });
    if (nestedIndex >= 0) modalStack.splice(nestedIndex, 0, token);
    else modalStack.push(token);
    const restoreTarget = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (scrollLockCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    scrollLockCount += 1;

    const dialog = dialogRef.current;
    if (dialog !== null && !dialog.contains(document.activeElement)) {
      const target = optionsRef.current.initialFocusRef?.current
        ?? getFocusableElements(dialog)[0]
        ?? dialog;
      target.focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (modalStack[modalStack.length - 1] !== token) return;
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        event.preventDefault();
        if (!optionsRef.current.closeDisabled) optionsRef.current.onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const dialog = dialogRef.current;
      const focusable = getFocusableElements(dialog);
      if (dialog === null || focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const index = modalStack.indexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      scrollLockCount -= 1;
      if (scrollLockCount === 0) document.body.style.overflow = previousBodyOverflow;
      if (optionsRef.current.restoreFocus !== false && restoreTarget?.isConnected) restoreTarget.focus();
    };
  }, [dialogRef, options.open]);
}
