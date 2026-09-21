import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';
import { Button } from './button.js';
import { focusableElements, restoreFocus } from './focus.js';

export function Dropdown(props: {
  label: ReactNode;
  children: ReactNode;
  align?: 'start' | 'end';
  disabled?: boolean;
  variant?: 'secondary' | 'ghost';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { align = 'end', variant = 'secondary', size = 'md' } = props;
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, maxHeight: 480 });
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((restore = true) => {
    const button = root.current?.querySelector<HTMLButtonElement>('.ui-dropdown-trigger') ?? null;
    const scope = button?.closest<HTMLElement>('.console-admin') ?? null;
    const active = document.activeElement;
    setOpen(false);
    if (restore && (active === document.body || active === button || panel.current?.contains(active))) restoreFocus(button, scope);
  }, []);

  useEffect(() => {
    if (props.disabled && open) close();
  }, [props.disabled, open, close]);

  useLayoutEffect(() => {
    if (!open) return;
    const button = root.current?.querySelector<HTMLButtonElement>('.ui-dropdown-trigger');
    const content = panel.current;
    if (!button || !content) return;
    const updatePosition = () => {
      const anchor = button.getBoundingClientRect();
      const width = window.innerWidth;
      const height = window.innerHeight;
      if (anchor.bottom < 0 || anchor.top > height || anchor.right < 0 || anchor.left > width) {
        close(false);
        return;
      }
      const gap = 4;
      const edge = 8;
      const panelWidth = content.getBoundingClientRect().width;
      const desiredHeight = Math.min(content.scrollHeight, 480);
      const below = Math.max(0, height - anchor.bottom - gap - edge);
      const above = Math.max(0, anchor.top - gap - edge);
      const upwards = desiredHeight > below && above > below;
      const maxHeight = Math.min(480, upwards ? above : below);
      const left = align === 'start' ? anchor.left : anchor.right - panelWidth;
      setPosition({
        left: Math.max(edge, Math.min(left, width - panelWidth - edge)),
        top: Math.max(edge, upwards ? anchor.top - gap - Math.min(desiredHeight, maxHeight) : anchor.bottom + gap),
        maxHeight,
      });
    };
    updatePosition();
    (focusableElements(content)[0] ?? content).focus({ preventScroll: true });
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    const observer = new ResizeObserver(updatePosition);
    observer.observe(button);
    observer.observe(content);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      observer.disconnect();
    };
  }, [open, host, align, close]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== 'Tab' || !panel.current?.contains(document.activeElement)) return;
      const elements = focusableElements(panel.current);
      if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === panel.current)) {
        event.preventDefault();
        close();
      } else if (!event.shiftKey && (!elements.length || document.activeElement === elements.at(-1))) {
        event.preventDefault();
        const button = root.current?.querySelector<HTMLButtonElement>('.ui-dropdown-trigger');
        const scope = button?.closest<HTMLElement>('[role="dialog"], .console-admin') ?? document.body;
        const outsideElements = focusableElements(scope).filter((element) => !panel.current?.contains(element));
        const next = button ? outsideElements[outsideElements.indexOf(button) + 1] : undefined;
        (next ?? button)?.focus({ preventScroll: true });
        close(false);
      }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', keydown, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', keydown, true);
    };
  }, [open, close]);

  const content = open ? (
    <div
      ref={panel}
      id={panelId}
      tabIndex={-1}
      className="ui-dropdown-panel fixed z-[70] grid gap-1 rounded-md border border-slate-200 bg-white p-2 shadow-lg"
      style={position}
      onClick={(event) => {
        const action = (event.target as Element).closest('button, a[href]');
        if (action && panel.current?.contains(action) && !action.matches(':disabled, [aria-disabled="true"]')) close();
      }}
    >
      {props.children}
    </div>
  ) : null;

  return (
    <div ref={root} className={`ui-dropdown relative inline-flex ${props.className ?? ''}`}>
      <Button
        type="button"
        variant={variant}
        size={size}
        disabled={props.disabled}
        className="ui-dropdown-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => {
          if (open) close();
          else {
            const button = root.current?.querySelector<HTMLButtonElement>('.ui-dropdown-trigger');
            setHost(button?.closest<HTMLElement>('[role="dialog"], .console-admin') ?? null);
            setOpen(true);
          }
        }}
      >
        {props.label}<ChevronDown size={14} aria-hidden="true" />
      </Button>
      {host && content ? createPortal(content, host) : content}
    </div>
  );
}
