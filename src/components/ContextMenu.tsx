import React, { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

export interface ContextMenuAction {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  separatorBefore?: boolean;
  icon?: React.ReactNode;
  shortcut?: string;
  checked?: boolean;
  danger?: boolean;
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
  const hasAnyChecked = actions.some((action) => action.checked !== undefined);
  const hasAnyIcon = actions.some((action) => Boolean(action.icon));

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
      ready: true,
    });
    if (!menu.contains(document.activeElement)) {
      menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
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
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = current;
    if (event.key === 'ArrowDown') next = current < 0 ? 0 : (current + 1) % items.length;
    else if (event.key === 'ArrowUp') next = current < 0 ? items.length - 1 : (current - 1 + items.length) % items.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = items.length - 1;
    else return;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      ref={menuRef}
      className="app-context-menu"
      role="menu"
      style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}
      onKeyDown={handleKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {actions.map((action, index) => {
        const isCheckboxItem = action.checked !== undefined;
        return (
          <React.Fragment key={`${action.label}:${index}`}>
            {action.separatorBefore && <div className="app-context-menu-divider" role="separator" />}
            <button
              type="button"
              role={isCheckboxItem ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={isCheckboxItem ? action.checked : undefined}
              className={`app-context-menu-item${action.danger ? ' is-danger' : ''}${action.checked ? ' is-checked' : ''}`}
              disabled={action.disabled}
              onClick={() => {
                action.onSelect();
                onClose();
              }}
            >
              <span className="app-context-menu-item-left">
                {(hasAnyChecked || hasAnyIcon) && (
                  <span className="app-context-menu-icon" aria-hidden="true">
                    {action.checked ? <Check size={13} /> : action.icon ?? null}
                  </span>
                )}
                <span className="app-context-menu-label">{action.label}</span>
              </span>
              {action.shortcut && <span className="app-context-menu-shortcut">{action.shortcut}</span>}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
};
