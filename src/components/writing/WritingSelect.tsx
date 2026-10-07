import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './WritingSelect.css';

export interface WritingSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface WritingSelectProps {
  label: string;
  value: string;
  options: readonly WritingSelectOption[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
}

interface MenuPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  placement: 'above' | 'below';
}

const VIEWPORT_GUTTER = 8;
const MENU_GAP = 4;
const DEFAULT_MENU_MAX_HEIGHT = 320;
const OPTION_WIDTH_RESERVE = 56;

function nextEnabledIndex(options: readonly WritingSelectOption[], start: number, direction: 1 | -1): number {
  if (options.length === 0) return -1;
  for (let step = 0; step < options.length; step++) {
    const index = (start + direction * step + options.length * 2) % options.length;
    if (!options[index].disabled) return index;
  }
  return -1;
}

export const WritingSelect: React.FC<WritingSelectProps> = ({ label, value, options, onValueChange, disabled = false }) => {
  const reactId = useId();
  const triggerId = `writing-select-trigger-${reactId}`;
  const listboxId = `writing-select-listbox-${reactId}`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef('');
  const typeaheadTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [popupHost, setPopupHost] = useState<HTMLElement | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const selectedIndex = useMemo(() => options.findIndex(option => option.value === value), [options, value]);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : null;
  const optionsSignature = options.map(option => `${option.value}\u0000${option.label}\u0000${Boolean(option.disabled)}`).join('\u0001');

  const clearTypeahead = useCallback(() => {
    typeaheadRef.current = '';
    if (typeaheadTimerRef.current !== null) {
      window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = null;
    }
  }, []);

  const closeMenu = useCallback((restoreFocus = false) => {
    clearTypeahead();
    setOpen(false);
    setPopupHost(null);
    setPosition(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, [clearTypeahead]);

  const choose = useCallback((index: number) => {
    const option = options[index];
    if (!option || option.disabled || disabled) return;
    onValueChange(option.value);
    closeMenu(true);
  }, [closeMenu, disabled, onValueChange, options]);

  const openMenu = useCallback((initialDirection: 1 | -1 = 1) => {
    if (disabled) return;
    const host = triggerRef.current?.closest<HTMLElement>('.writing-dialog');
    if (!host) return;
    clearTypeahead();
    const initial = selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : nextEnabledIndex(options, initialDirection === 1 ? 0 : options.length - 1, initialDirection);
    setActiveIndex(initial);
    setPopupHost(host);
    setOpen(true);
  }, [clearTypeahead, disabled, options, selectedIndex]);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    const host = popupHost;
    if (!trigger || !popup || !host || !open) return;

    const triggerRect = trigger.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const minX = Math.max(VIEWPORT_GUTTER, hostRect.left);
    const maxX = Math.min(window.innerWidth - VIEWPORT_GUTTER, hostRect.right);
    const maxWidth = Math.max(0, maxX - minX);
    const longestLabelWidth = Array.from(popup.querySelectorAll<HTMLElement>('.writing-select-option > span'))
      .reduce((widest, optionLabel) => Math.max(widest, optionLabel.scrollWidth), 0);
    const naturalWidth = Math.max(popup.scrollWidth, longestLabelWidth + OPTION_WIDTH_RESERVE);
    const width = Math.min(maxWidth, Math.max(triggerRect.width, naturalWidth));
    const left = Math.max(minX, Math.min(triggerRect.left, maxX - width));
    const topBoundary = Math.max(VIEWPORT_GUTTER, hostRect.top);
    const bottomBoundary = Math.min(window.innerHeight - VIEWPORT_GUTTER, hostRect.bottom);
    const belowSpace = Math.max(0, bottomBoundary - triggerRect.bottom - MENU_GAP);
    const aboveSpace = Math.max(0, triggerRect.top - topBoundary - MENU_GAP);
    const naturalHeight = Math.min(popup.scrollHeight, DEFAULT_MENU_MAX_HEIGHT);
    const placement: MenuPosition['placement'] = belowSpace >= Math.min(naturalHeight, 180) || belowSpace >= aboveSpace ? 'below' : 'above';
    const maxHeight = Math.max(0, Math.min(DEFAULT_MENU_MAX_HEIGHT, placement === 'below' ? belowSpace : aboveSpace));
    const top = placement === 'below' ? triggerRect.bottom + MENU_GAP : triggerRect.top - MENU_GAP - Math.min(naturalHeight, maxHeight);
    setPosition({ left, top, width, maxHeight, placement });
  }, [open, popupHost]);

  useLayoutEffect(() => {
    if (!open) return undefined;
    reposition();
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reposition);
    if (triggerRef.current) resizeObserver?.observe(triggerRef.current);
    if (popupHost) resizeObserver?.observe(popupHost);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, popupHost, reposition, optionsSignature]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    const popup = popupRef.current;
    const option = document.getElementById(`${listboxId}-option-${activeIndex}`);
    if (!popup || !option || !popup.contains(option)) return;
    const popupRect = popup.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < popupRect.top) popup.scrollTop -= popupRect.top - optionRect.top;
    else if (optionRect.bottom > popupRect.bottom) popup.scrollTop += optionRect.bottom - popupRect.bottom;
  }, [activeIndex, listboxId, open]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || popupRef.current?.contains(target)) return;
      closeMenu();
    };
    document.addEventListener('mousedown', closeOutside, true);
    return () => document.removeEventListener('mousedown', closeOutside, true);
  }, [closeMenu, open]);

  useEffect(() => () => {
    if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
  }, []);

  const setActive = (index: number) => {
    if (index < 0 || options[index]?.disabled) return;
    setActiveIndex(index);
  };

  const moveActive = (direction: 1 | -1) => {
    const next = nextEnabledIndex(options, activeIndex + direction, direction);
    if (next >= 0) setActive(next);
  };

  const findTypeaheadMatch = (search: string): number => {
    const normalized = search.toLocaleLowerCase();
    for (let offset = 1; offset <= options.length; offset++) {
      const index = (Math.max(selectedIndex, activeIndex, -1) + offset) % options.length;
      if (!options[index].disabled && options[index].label.toLocaleLowerCase().startsWith(normalized)) return index;
    }
    return -1;
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        moveActive(event.key === 'ArrowDown' ? 1 : -1);
      } else if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault(); event.stopPropagation();
        setActive(nextEnabledIndex(options, event.key === 'Home' ? 0 : options.length - 1, event.key === 'Home' ? 1 : -1));
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation();
        choose(activeIndex);
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        closeMenu(true);
      } else if (event.key === 'Tab') {
        closeMenu();
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopPropagation();
        typeaheadRef.current += event.key;
        if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
        typeaheadTimerRef.current = window.setTimeout(() => { typeaheadRef.current = ''; typeaheadTimerRef.current = null; }, 700);
        const match = findTypeaheadMatch(typeaheadRef.current);
        if (match >= 0) setActive(match);
      }
      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); event.stopPropagation();
      openMenu(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); event.stopPropagation();
      openMenu(event.key === 'Home' ? 1 : -1);
      setActive(nextEnabledIndex(options, event.key === 'Home' ? 0 : options.length - 1, event.key === 'Home' ? 1 : -1));
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation();
      openMenu();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopPropagation();
      typeaheadRef.current += event.key;
      if (typeaheadTimerRef.current !== null) window.clearTimeout(typeaheadTimerRef.current);
      typeaheadTimerRef.current = window.setTimeout(() => { typeaheadRef.current = ''; typeaheadTimerRef.current = null; }, 700);
      const match = findTypeaheadMatch(typeaheadRef.current);
      if (match >= 0) choose(match);
    }
  };

  const activeOptionId = open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined;

  return (
    <span className="writing-select writing-select-control">
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className="writing-select-trigger"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={activeOptionId}
        disabled={disabled}
        onClick={() => open ? closeMenu() : openMenu()}
        onKeyDown={handleKeyDown}
      >
        <span className="writing-select-value">{selectedOption?.label ?? value}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && popupHost && createPortal(
        <div
          ref={popupRef}
          className="writing-select-popup"
          data-writing-select-popup="true"
          style={position ? {
            left: position.left,
            top: position.top,
            width: position.width,
            maxHeight: position.maxHeight,
          } : { visibility: 'hidden', left: -10000, top: -10000 }}
        >
          <div id={listboxId} role="listbox" aria-label={label} className="writing-select-listbox">
            {options.map((option, index) => (
              <div
                id={`${listboxId}-option-${index}`}
                key={option.value}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                title={option.label}
                className={`writing-select-option${index === activeIndex ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}`}
                onMouseDown={event => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(index)}
              >
                <span>{option.label}</span>
                {option.value === value && <Check size={14} aria-hidden="true" />}
              </div>
            ))}
          </div>
        </div>,
        popupHost,
      )}
    </span>
  );
};

export default WritingSelect;
