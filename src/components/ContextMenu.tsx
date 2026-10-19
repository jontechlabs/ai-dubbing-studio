import { useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';

export interface ContextAction {
  label: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
}
export interface ContextRequest {
  x: number;
  y: number;
  label: string;
  actions: ContextAction[];
  opener: HTMLElement | null;
  scrollOffsets: { element: Element; left: number; top: number }[];
}
export type OpenContextMenu = (
  event: MouseEvent<HTMLElement>,
  label: string,
  actions: ContextAction[],
) => void;

export function ContextMenu({
  request,
  onClose,
}: {
  request: ContextRequest;
  onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: request.x, y: request.y });
  const dismiss = (restore = false) => {
    if (restore && request.opener?.isConnected) request.opener.focus({ preventScroll: true });
    onClose();
  };
  useLayoutEffect(() => {
    const element = menu.current!;
    const bounds = element.getBoundingClientRect();
    setPosition({
      x: Math.max(8, Math.min(request.x, window.innerWidth - bounds.width - 8)),
      y: Math.max(8, Math.min(request.y, window.innerHeight - bounds.height - 8)),
    });
    (element.querySelector<HTMLElement>('button:not(:disabled)') ?? element).focus({
      preventScroll: true,
    });
    const outside = (event: Event) => {
      if (event.target instanceof Node && !element.contains(event.target)) onClose();
    };
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && element.contains(event.target)) return;
      const initial = request.scrollOffsets.find((s) => s.element === event.target);
      // A right click can first reveal a track and queue its scroll event.
      // Ignore that already completed scroll; close only for a new movement.
      if (
        initial &&
        initial.element.scrollLeft === initial.left &&
        initial.element.scrollTop === initial.top
      )
        return;
      onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (request.opener?.isConnected) request.opener.focus({ preventScroll: true });
      onClose();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('focusin', outside);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    window.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('focusin', outside);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('keydown', escape, true);
    };
  }, [request, onClose]);
  return createPortal(
    <div
      ref={menu}
      className="app-context-menu"
      role="menu"
      aria-label={request.label}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Tab') {
          event.preventDefault();
          dismiss(true);
          return;
        }
        const buttons = Array.from(
          menu.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        );
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : event.key === 'ArrowDown'
                ? (current + 1) % buttons.length
                : event.key === 'ArrowUp'
                  ? (current + buttons.length - 1) % buttons.length
                  : -1;
        if (index >= 0) {
          event.preventDefault();
          buttons[index].focus();
        }
      }}
    >
      <div className="context-menu-title" aria-hidden="true">
        {request.label}
      </div>
      {request.actions.map((action) => (
        <button
          key={action.label}
          role="menuitem"
          disabled={action.disabled}
          className={action.danger ? 'danger' : ''}
          onClick={() => {
            dismiss(true);
            action.run();
          }}
        >
          <span>{action.label}</span>
          {action.shortcut && <kbd>{action.shortcut}</kbd>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
