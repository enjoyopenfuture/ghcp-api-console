import type { TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';

export function Table(props: TableHTMLAttributes<HTMLTableElement> & { compact?: boolean }) {
  const { className = '', compact = false, ...rest } = props;
  return <table className={`ui-table w-full text-left text-sm ${className}`} data-density={compact ? 'compact' : 'comfortable'} {...rest} />;
}

export function Th(props: ThHTMLAttributes<HTMLTableCellElement>) {
  const { className = '', scope = 'col', ...rest } = props;
  return <th className={`ui-table-head text-left ${className}`} scope={scope} {...rest} />;
}

export function Td(props: TdHTMLAttributes<HTMLTableCellElement>) {
  const { className = '', ...rest } = props;
  return <td className={`ui-table-cell ${className}`} {...rest} />;
}
