import type { ButtonHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'warning' | 'dangerOutline' | 'danger' | 'ghost';

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const { className = '', variant = 'primary', ...rest } = props;
  const variants: Record<ButtonVariant, string> = {
    primary: 'bg-slate-900 text-white hover:bg-slate-700',
    secondary: 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-50',
    warning: 'border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
    dangerOutline: 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
    danger: 'bg-red-600 text-white hover:bg-red-500',
    ghost: 'bg-transparent text-slate-700 hover:bg-slate-100',
  };
  return (
    <button
      className={`inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`}
      {...rest}
    />
  );
}
