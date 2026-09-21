import type { HTMLAttributes } from 'react';

type BadgeTone = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'muted';

export function Badge(props: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  const { className = '', tone = 'default', ...rest } = props;
  const tones: Record<BadgeTone, string> = {
    default: 'border-slate-200 bg-slate-100 text-slate-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    warning: 'border-amber-200 bg-amber-50 text-amber-700',
    danger: 'border-red-200 bg-red-50 text-red-700',
    info: 'border-blue-200 bg-blue-50 text-blue-700',
    muted: 'border-slate-200 bg-white text-slate-500',
  };
  return <span className={`ui-badge ui-badge--${tone} inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${tones[tone]} ${className}`} {...rest} />;
}
