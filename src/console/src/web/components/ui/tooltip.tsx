import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';

interface TooltipChildProps {
  'aria-describedby'?: string;
}

export function Tooltip(props: { content: ReactNode; children: ReactElement<TooltipChildProps> }) {
  const id = useId();
  const describedBy = [props.children.props['aria-describedby'], id].filter(Boolean).join(' ');

  return (
    <span className="group relative inline-flex">
      {cloneElement(props.children, { 'aria-describedby': describedBy })}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-50 mt-2 w-max max-w-72 -translate-x-1/2 rounded-md bg-slate-950 px-3 py-2 text-xs font-normal leading-relaxed text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {props.content}
      </span>
    </span>
  );
}
