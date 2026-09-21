import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { Button } from './button.js';

const NotificationTarget = createContext<HTMLDivElement | null | undefined>(undefined);

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return <NotificationTarget.Provider value={target}>
    {children}
    <div ref={setTarget} role="region" aria-label="Notifications" data-notification-region
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-h-[70vh] w-96 max-w-[calc(100vw-2rem)] flex-col gap-3 overflow-auto" />
  </NotificationTarget.Provider>;
}

export function Notification({ children, tone, onClose }: {
  children: ReactNode;
  tone: 'success' | 'warning' | 'error';
  onClose(): void;
}) {
  const target = useContext(NotificationTarget);
  if (target === undefined) throw new Error('Notifications must be rendered inside NotificationProvider.');
  if (!target) return null;
  return createPortal(<div role={tone === 'error' ? 'alert' : 'status'} data-notification
    className={`pointer-events-auto flex max-h-[70vh] shrink-0 items-start gap-3 overflow-auto rounded-lg border p-4 text-sm shadow-lg ${
      tone === 'error' ? 'border-red-200 bg-red-50 text-red-800' : tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-slate-200 bg-white text-slate-900'}`}>
    {tone === 'success' ? <CheckCircle2 aria-hidden="true" size={18} className="mt-1 shrink-0 text-emerald-700" /> : <AlertTriangle aria-hidden="true" size={18} className="mt-1 shrink-0" />}
    <div className="min-w-0 flex-1 space-y-2 break-words">{children}</div>
    <Button size="icon" variant="secondary" className="shrink-0" aria-label="Dismiss notification" onClick={onClose}><X aria-hidden="true" size={14} /></Button>
  </div>, target);
}
