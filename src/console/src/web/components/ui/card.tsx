import type { HTMLAttributes } from 'react';

export function Card(props: HTMLAttributes<HTMLDivElement>) {
  const { className = '', ...rest } = props;
  return <section className={`ui-card rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-shadow ${className}`} {...rest} />;
}

export function CardTitle(props: HTMLAttributes<HTMLHeadingElement>) {
  const { className = '', ...rest } = props;
  return <h2 className={`ui-card-title mb-3 text-lg font-semibold text-slate-950 ${className}`} {...rest} />;
}

export function CardDescription(props: HTMLAttributes<HTMLParagraphElement>) {
  const { className = '', ...rest } = props;
  return <p className={`ui-card-description mb-4 text-sm text-slate-600 ${className}`} {...rest} />;
}
