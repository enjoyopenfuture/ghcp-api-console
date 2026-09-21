import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './button.js';
import { focusableElements, registerDialog, restoreFocus, topmostDialog } from './focus.js';

export function Dialog(props: { title: string; description?: string; open: boolean; children: ReactNode; onClose: () => void; returnFocusTo?: HTMLElement; closeDisabled?: boolean }) {
  const panel = useRef<HTMLElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const onClose = useRef(props.onClose);
  const closeDisabled = useRef(props.closeDisabled);
  onClose.current = props.onClose;
  closeDisabled.current = props.closeDisabled;
  useEffect(() => {
    const node = panel.current;
    if (!props.open || !node) return;
    const previous = props.returnFocusTo ?? document.activeElement;
    const scope = node.closest<HTMLElement>('.console-admin');
    const unregister = registerDialog(node);
    const focusable = () => focusableElements(node);
    (focusable()[0] ?? node).focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topmostDialog() !== node) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!closeDisabled.current) onClose.current();
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!elements.length) { event.preventDefault(); node.focus(); }
      else if (!node.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    const focusin = (event: FocusEvent) => {
      if (topmostDialog() === node && !node.contains(event.target as Node)) (focusable()[0] ?? node).focus({ preventScroll: true });
    };
    document.addEventListener('keydown', keydown);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown);
      document.removeEventListener('focusin', focusin);
      unregister();
      restoreFocus(previous instanceof HTMLElement ? previous : null, scope);
    };
  }, [props.open]);
  useEffect(() => {
    if (props.open && props.closeDisabled && panel.current && topmostDialog() === panel.current && !focusableElements(panel.current).length) panel.current.focus({ preventScroll: true });
  }, [props.open, props.closeDisabled]);
  if (!props.open) return null;
  return (
    <div className="ui-dialog-overlay fixed inset-0 z-50 flex items-center justify-center bg-slate-950/40 p-4 backdrop-blur-[1px]">
      <section ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={props.description ? descriptionId : undefined} tabIndex={-1} className="ui-dialog max-h-[90vh] w-full max-w-2xl overflow-auto rounded-xl bg-white p-5 shadow-xl">
        <header className="ui-dialog-header mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id={titleId} className="ui-dialog-title text-lg font-semibold text-slate-950">{props.title}</h2>
            {props.description ? <p id={descriptionId} className="ui-dialog-description mt-1 text-sm text-slate-600">{props.description}</p> : null}
          </div>
          <Button type="button" variant="secondary" size="icon" className="px-2" onClick={props.onClose} disabled={props.closeDisabled} aria-label="Close dialog"><X size={16} /></Button>
        </header>
        {props.children}
      </section>
    </div>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  title: string;
  description: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string;
  danger?: boolean;
  returnFocusTo?: HTMLElement;
}) {
  const [pending, setPending] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const submitting = useRef(false);
  const busy = Boolean(props.busy || pending);
  useEffect(() => {
    if (props.open) setLocalError(undefined);
  }, [props.open]);
  const confirm = async () => {
    if (busy || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setLocalError(undefined);
    try {
      await props.onConfirm();
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'The action could not be completed. Please try again.');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <Dialog open={props.open} onClose={props.onClose} closeDisabled={busy} returnFocusTo={props.returnFocusTo} title={props.title} description={props.description}>
      <div className="ui-confirm-content" aria-busy={busy}>
        {props.error || localError ? <p role="alert" className="ui-confirm-error mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">{props.error || localError}</p> : null}
        <footer className="ui-dialog-actions flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={props.onClose}>Cancel</Button>
          <Button type="button" variant={props.danger ? 'danger' : 'primary'} disabled={busy} onClick={() => void confirm()}>
            {busy ? 'Working…' : props.confirmLabel ?? 'Confirm'}
          </Button>
        </footer>
      </div>
    </Dialog>
  );
}
