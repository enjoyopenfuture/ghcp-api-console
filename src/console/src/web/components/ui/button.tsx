import type { AnchorHTMLAttributes, ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'warning' | 'dangerOutline' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'icon';

const variants: Record<ButtonVariant, string> = {
  primary: 'bg-slate-900 text-white shadow-sm hover:bg-slate-700',
  secondary: 'border border-slate-300 bg-white text-slate-900 shadow-sm hover:border-slate-400 hover:bg-slate-50',
  warning: 'border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100',
  dangerOutline: 'border border-red-300 bg-white text-red-700 hover:bg-red-50',
  danger: 'bg-red-600 text-white shadow-sm hover:bg-red-500',
  ghost: 'bg-transparent text-slate-700 hover:bg-slate-100',
};

function buttonClassName(variant: ButtonVariant, size: ButtonSize, className: string) {
  return `ui-button ui-button--${variant} ui-button--${size} inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 ${variants[variant]} ${className}`;
}

export function Button(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const { className = '', variant = 'primary', size = 'md', ...rest } = props;
  return (
    <button
      className={buttonClassName(variant, size, className)}
      {...rest}
    />
  );
}

export function ButtonLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const { className = '', variant = 'primary', size = 'md', ...rest } = props;
  return <a className={buttonClassName(variant, size, className)} {...rest} />;
}
