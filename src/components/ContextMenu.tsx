import React, { useEffect, useRef, useState } from 'react';

export interface ContextMenuAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  actions: ContextMenuAction[];
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, actions, onClose, triggerRef }) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
      ready: true,
    });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y, actions]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef?.current?.contains(target)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    };
    window.addEventListener('pointerdown', closeOutside);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOutside);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose, triggerRef]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []);
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === 'ArrowDown') next = (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  return <div
    ref={menuRef}
    className="app-context-menu"
    role="menu"
    style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
    onKeyDown={handleKeyDown}
    onContextMenu={event => event.preventDefault()}
  >
    {actions.map((action, index) => <React.Fragment key={`${action.label}:${index}`}>
      {action.separatorBefore && <div className="app-context-menu-divider" role="separator" />}
      <button type="button" role="menuitem" disabled={action.disabled} onClick={() => { action.onSelect(); onClose(); }}>
        {action.label}
      </button>
    </React.Fragment>)}
  </div>;
};
