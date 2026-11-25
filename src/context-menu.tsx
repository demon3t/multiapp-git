import React, { useLayoutEffect, useRef } from 'react';

export function ContextItem({ label, disabled, shortcut, onClick }: {
  label: string; disabled?: boolean; shortcut?: string; onClick: () => void;
}) {
  return <button type="button" role="menuitem" className="menu-command" disabled={disabled}
    aria-label={label} aria-keyshortcuts={shortcut} title={label} onClick={onClick}>
    <span>{label}</span>{shortcut && <kbd aria-hidden="true">{shortcut.replace('Control', 'Ctrl')}</kbd>}
  </button>;
}

export function ContextMenu({ anchor, point, label, onClose, onKeyDown, children }: {
  anchor: HTMLButtonElement; point?: { x: number; y: number }; label: string; onClose: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>; children: React.ReactNode;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = menu.current!;
    const bounds = anchor.getBoundingClientRect();
    box.style.left = Math.max(4, Math.min(point?.x ?? bounds.left, window.innerWidth - box.offsetWidth - 4)) + 'px';
    box.style.top = Math.max(4, Math.min(point?.y ?? bounds.bottom, window.innerHeight - box.offsetHeight - 4)) + 'px';
    box.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !box.contains(event.target) && !anchor.contains(event.target)) onClose();
    }
    window.addEventListener('pointerdown', outside);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', onClose);
      if (anchor.isConnected && box.contains(document.activeElement)) anchor.focus({ preventScroll: true });
    };
  }, [anchor, point, onClose]);

  return <div ref={menu} role="menu" aria-label={label} className="repo-menu-panel branch-menu" onKeyDown={event => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!buttons.length) return;
      const index = buttons.findIndex(button => button === document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else onKeyDown?.(event);
  }}>{children}</div>;
}
