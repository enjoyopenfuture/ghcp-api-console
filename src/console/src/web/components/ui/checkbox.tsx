import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type InputHTMLAttributes } from 'react';

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { indeterminate?: boolean }>(
  function Checkbox({ className = '', indeterminate = false, ...rest }, ref) {
    const input = useRef<HTMLInputElement>(null);
    useImperativeHandle(ref, () => input.current!, []);
    useLayoutEffect(() => {
      if (input.current) input.current.indeterminate = indeterminate;
    }, [indeterminate, rest.checked]);
    return <input {...rest} ref={input} type="checkbox" aria-checked={indeterminate ? 'mixed' : rest['aria-checked']} className={`ui-checkbox size-4 accent-slate-900 ${className}`} />;
  },
);
