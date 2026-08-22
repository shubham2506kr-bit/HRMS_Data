import type { ReactNode } from 'react';
import clsx from 'clsx';

// ------------------------------------------------------------------ Stat

export function Stat({ eyebrow, value, sub, tone, children }: {
  eyebrow: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'brand' | 'ok' | 'warn' | 'danger' | 'ink';
  children?: ReactNode;
}) {
  return (
    <div className="stat">
      <p className="eyebrow">{eyebrow}</p>
      <p className={clsx('stat-value', tone === 'brand' && 'text-branddeep', tone === 'ok' && 'text-ok', tone === 'warn' && 'text-warn', tone === 'danger' && 'text-danger', tone === 'ink' && 'text-ink')}>
        {value}
      </p>
      {sub && <p className="stat-sub">{sub}</p>}
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ Notice

export function Notice({ tone = 'info', icon, title, children, action }: {
  tone?: 'info' | 'warn' | 'ok' | 'danger';
  icon?: ReactNode;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={clsx('notice', tone === 'info' && 'notice-info', tone === 'warn' && 'notice-warn', tone === 'ok' && 'notice-ok', tone === 'danger' && 'notice-danger')}>
      {icon && <span className="mt-0.5 shrink-0 text-inkfaint">{icon}</span>}
      <div className="min-w-0 flex-1">
        {title && <p className="font-medium text-ink">{title}</p>}
        {children && <div className="mt-0.5 text-xs leading-relaxed text-inksoft">{children}</div>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Chip

export function Chip({ tone = 'default', active, className, children, ...rest }: {
  tone?: 'default' | 'brand' | 'accent' | 'neutral';
  active?: boolean;
  className?: string;
  children: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={clsx(
        'chip',
        tone === 'brand' && 'chip-brand',
        tone === 'accent' && 'chip-accent',
        tone === 'neutral' && 'chip-neutral',
        active && 'border-ink bg-ink text-surface hover:border-ink hover:bg-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ Segmented

export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className="inline-flex items-center gap-0.5 rounded-lg border border-line bg-soft/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={clsx(
            'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
            value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-inksoft hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Section header with rule

export function SectionTitle({ eyebrow, title, aside }: { eyebrow?: string; title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h2 className="h-section mt-0.5">{title}</h2>
      </div>
      {aside && <div>{aside}</div>}
    </div>
  );
}