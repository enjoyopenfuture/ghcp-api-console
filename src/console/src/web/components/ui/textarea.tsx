import type { TextareaHTMLAttributes } from 'react';

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea className={`ui-textarea rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 ${className}`} {...rest} />;
}
