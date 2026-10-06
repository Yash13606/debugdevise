// Shared interface pieces: notices, tags, the date poster, event cards, skeletons, tabs, the dialog and a confirm step.
import { CheckCircle, Info, WarningCircle } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { dateParts, posterVars, rupees } from './lib';

export function Notice({ kind = 'error', children, className = '' }: { kind?: 'error' | 'ok' | 'info'; children: React.ReactNode; className?: string }) {
  const Icon = kind === 'ok' ? CheckCircle : kind === 'info' ? Info : WarningCircle;
  return (
    <div className={`notice notice--${kind} ${className}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={20} weight="light" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

export const Tag = ({ tone, children }: { tone?: 'ok' | 'bad' | 'warn' | 'ink' | 'violet' | 'poster'; children: React.ReactNode }) => (
  <span className={'tag' + (tone ? ` tag--${tone}` : '')}>{children}</span>
);

export interface EventCardData {
  id: string;
  name: string;
  category: string;
  city: string;
  venue: string;
  banner: string;
  starts_at: string;
  available: number;
  capacity: number;
  min_price_paise: number | null;
  selling_fast: boolean;
  sold_out: boolean;
}

/** An event as a flat colour poster led by its date. Decorative: the same facts are written out beside it. */
export function Poster({ banner, category, startsAt, flag, size = 'card' }: { banner: string; category: string; startsAt: string; flag?: React.ReactNode; size?: 'card' | 'lead' | 'hero' }) {
  const d = dateParts(startsAt);
  return (
    <div className={`poster poster--${size}`} style={posterVars(banner)}>
      <div className="poster__top">
        <Tag tone="poster">{category}</Tag>
        {flag}
      </div>
      <div className="poster__date" aria-hidden>
        <span className="poster__day">{d.day}</span>
        <span className="poster__when">
          <span className="poster__month">{d.month}</span>
          <span className="poster__time">{d.weekday} {d.time}</span>
        </span>
      </div>
    </div>
  );
}

export function EventCard({ e, lead = false }: { e: EventCardData; lead?: boolean }) {
  const flag = e.sold_out ? <Tag tone="ink">Sold out</Tag> : e.selling_fast ? <Tag tone="violet">Selling fast</Tag> : null;
  return (
    <Link to={`/e/${e.id}`} className={'event' + (lead ? ' event--lead' : '')}>
      <Poster banner={e.banner} category={e.category} startsAt={e.starts_at} flag={flag} size={lead ? 'lead' : 'card'} />
      <div className="event__body">
        <h3 className="event__title">{e.name}</h3>
        <p className="event__meta">{[e.venue, e.city].filter((x, i, a) => x && a.indexOf(x) === i).join(', ')}</p>
        <p className="event__price">
          <span>{e.min_price_paise === null ? 'No tickets yet' : e.min_price_paise === 0 ? 'Free' : `From ${rupees(e.min_price_paise)}`}</span>
          <span className="muted">{e.sold_out ? 'None left' : `${e.available.toLocaleString('en-IN')} left`}</span>
        </p>
      </div>
    </Link>
  );
}

export function EventCardSkeleton({ lead = false }: { lead?: boolean }) {
  return (
    <div className={lead ? 'event--lead' : undefined} aria-hidden>
      <div className="skeleton" style={{ height: lead ? 380 : 240 }} />
      <div className="skeleton" style={{ height: 22, width: '65%', marginTop: 16 }} />
      <div className="skeleton" style={{ height: 14, width: '45%', marginTop: 10 }} />
    </div>
  );
}

export const Skeleton = ({ h = 16, w = '100%', mt = 0 }: { h?: number; w?: number | string; mt?: number }) => <div className="skeleton" style={{ height: h, width: w, marginTop: mt }} aria-hidden />;

/** A page-level loading state shaped like the content it stands in for. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton h={56} w="50%" />
      <Skeleton h={18} w="35%" mt={16} />
      <Skeleton h={220} mt={32} />
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Tab strip with a sliding underline. Arrow keys, Home and End move between tabs. */
export function Tabs<T extends string>({ items, value, onChange, label }: { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ink, setInk] = useState({ x: 0, w: 0 });
  const [ready, setReady] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el) setInk({ x: el.offsetLeft, w: el.offsetWidth });
  }, []);
  useLayoutEffect(measure, [value, items, measure]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setReady(true));
    window.addEventListener('resize', measure);
    void document.fonts?.ready.then(measure);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  const onKey = (e: React.KeyboardEvent) => {
    const i = items.findIndex((t) => t.value === value);
    const to = e.key === 'ArrowRight' ? (i + 1) % items.length : e.key === 'ArrowLeft' ? (i - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    onChange(items[to]!.value);
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[to]?.focus();
  };

  return (
    <div className="tabs" role="tablist" aria-label={label} ref={ref} onKeyDown={onKey} data-ready={ready || undefined}>
      {items.map((t) => (
        <button key={t.value} role="tab" type="button" className="tab" aria-selected={t.value === value} tabIndex={t.value === value ? 0 : -1} onClick={() => onChange(t.value)}>
          {t.label}
        </button>
      ))}
      <span className="tabs__ink" aria-hidden style={{ ['--x' as string]: `${ink.x}px`, ['--w' as string]: ink.w }} />
    </div>
  );
}

/** A native dialog: focus is trapped and returned, Escape closes it, the page behind is inert. Fades and scales in; leaves a little faster. */
export function Modal({ open, onClose, title, children, dismissible = true }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; dismissible?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
    }
  }, [open]);
  useEffect(() => {
    if (mounted && open && ref.current && !ref.current.open) ref.current.showModal();
  }, [mounted, open]);
  useEffect(() => {
    if (open || !mounted) return;
    setClosing(true);
    const t = setTimeout(() => {
      ref.current?.close();
      setMounted(false);
      setClosing(false);
    }, 160);
    return () => clearTimeout(t);
  }, [open, mounted]);

  if (!mounted) return null;
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={titleId}
      data-closing={closing || undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissible) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && dismissible) onClose();
      }}
    >
      <div className="modal__body">
        <h3 id={titleId}>{title}</h3>
        {children}
      </div>
    </dialog>
  );
}

/** A destructive action asks once, in place, before it happens. */
export function ConfirmAction({ label, question, confirmLabel, keepLabel = 'Keep it', busy, onConfirm }: { label: string; question: string; confirmLabel: string; keepLabel?: string; busy?: boolean; onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <button type="button" className="btn btn--danger btn--sm" onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <div className="confirm" role="group" aria-label="Confirm">
      <p>{question}</p>
      <div className="row">
        <button type="button" className="btn btn--danger btn--sm" onClick={onConfirm} disabled={busy} autoFocus>
          {busy ? 'Working' : confirmLabel}
        </button>
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAsking(false)}>
          {keepLabel}
        </button>
      </div>
    </div>
  );
}

/** A thin progress line. `linear` is for time passing; the default eases for jumps. */
export function Meter({ fraction, linear = false }: { fraction: number; linear?: boolean }) {
  return (
    <div className={'meter' + (linear ? ' meter--linear' : '')} aria-hidden>
      <div className="meter__fill" style={{ ['--p' as string]: Math.min(1, Math.max(0, fraction)) }} />
    </div>
  );
}
