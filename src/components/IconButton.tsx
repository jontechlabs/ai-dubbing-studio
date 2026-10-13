import type { ReactNode } from 'react';

export function IconButton({
  label,
  children,
  active,
  ...props
}: {
  label: string;
  children: ReactNode;
  active?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? 'active' : ''}`}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}
