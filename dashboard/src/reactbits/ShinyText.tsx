import type { ReactNode } from 'react';

export function ShinyText({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={`shiny-text ${className}`}>{children}</span>;
}
