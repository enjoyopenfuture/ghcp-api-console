import type { SelectHTMLAttributes } from 'react';

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', ...rest } = props;
  return <select className={`ui-select rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none transition-colors focus:border-slate-500 focus:ring-2 focus:ring-slate-200 ${className}`} {...rest} />;
}
