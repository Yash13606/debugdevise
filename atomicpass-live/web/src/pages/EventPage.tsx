import { CalendarBlank, MapPin, User } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError, friendly, get, getToken, post } from '../api';
import { useAuth, type User as Account } from '../auth';
import { money, mmss, prefersReducedMotion, rupees, solveChallenge, useCountdown, useLoad, usePageTitle } from '../lib';
import { EmptyState, Meter, Notice, PageSkeleton, Poster, Tag } from '../ui';

interface Tier { id: string; name: string; price_paise: number; available: number; max_per_order: number; seated: boolean }
interface View { event: { id: string; name: string; description: string; category: string; city: string; venue: string; address: string; banner: string; status: string; starts_at: string; available: number; queue_enabled: boolean; organiser: string | null }; tiers: Tier[] }
interface Seat { id: string; row: string; no: number; status: string }
interface QueueState { status: 'WAITING' | 'ADMITTED' | 'USED' | 'EXPIRED'; position: number; ahead: number; eta_seconds: number; admit_expires_at: string | null; pass: string | null }

export default function EventPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const nav = useNavigate();
  const here = useLocation().pathname;
  const view = useLoad(() => get<View>(`/events/${id}`), [id], 3000);
  const meta = useLoad(() => get<{ hold_seconds?: number }>('/meta'), []);
  const anySeated = !!view.data?.tiers.some((t) => t.seated);
  const seats = useLoad(() => (anySeated ? get<{ tiers: Record<string, Seat[]> }>(`/events/${id}/seats`) : Promise.resolve(null)), [id, anySeated], 3000);

  const [qty, setQty] = useState<Record<string, number>>({});
  const [chosen, setChosen] = useState<Record<string, string[]>>({});
  const [promo, setPromo] = useState('');
  const [promoOpen, setPromoOpen] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [queue, setQueue] = useState<QueueState | null>(null);
  const [startPos, setStartPos] = useState(0);
  const [joining, setJoining] = useState(false);
  const stream = useRef<EventSource | null>(null);

  const ev = view.data?.event;
  const tiers = view.data?.tiers ?? [];
  usePageTitle(ev?.name ?? 'Event');
  const holdMinutes = Math.max(1, Math.round((meta.data?.hold_seconds ?? 600) / 60));
  const needsQueue = !!ev?.queue_enabled;
  const admitted = queue?.status === 'ADMITTED' && !!queue.pass;
  const admitSeconds = queue?.admit_expires_at ? Math.max(0, Math.round((new Date(queue.admit_expires_at).getTime() - Date.now()) / 1000)) : null;
  const admitLeft = useCountdown(admitSeconds);
  const admitTotal = useRef(0);
  if (admitted && admitSeconds !== null) admitTotal.current = Math.max(admitTotal.current, admitSeconds);

  // Open (or restore) the live view of the waiting room.
  const watch = useCallback(() => {
    stream.current?.close();
    const token = getToken();
    if (!token) return;
    const es = new EventSource(`/api/events/${id}/queue/stream?access_token=${encodeURIComponent(token)}`);
    es.onmessage = (m) => {
      const s = JSON.parse(m.data) as QueueState;
      setQueue(s);
      if (s.status === 'WAITING') setStartPos((p) => Math.max(p, s.position));
      if (s.status === 'USED' || s.status === 'EXPIRED') es.close();
    };
    es.addEventListener('problem', () => {
      setQueue(null);
      es.close();
    });
    stream.current = es;
  }, [id]);
  useEffect(() => {
    if (!user || !needsQueue) return;
    get<QueueState>(`/events/${id}/queue`).then(
      (s) => {
        if (s.status === 'WAITING' || s.status === 'ADMITTED') {
          setQueue(s);
          setStartPos(s.position);
          watch();
        }
      },
      () => {},
    );
    return () => stream.current?.close();
  }, [user, needsQueue, id, watch]);

  const join = async () => {
    setErr('');
    setJoining(true);
    try {
      const c = await get<{ bits: number; challenge: string | null }>(`/events/${id}/queue/challenge`);
      const pow = c.challenge ? { challenge: c.challenge, nonce: await solveChallenge(c.challenge, c.bits) } : undefined;
      const s = await post<QueueState>(`/events/${id}/queue`, pow ? { pow } : {});
      setQueue(s);
      setStartPos(s.position);
      watch();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setJoining(false);
    }
  };

  const lines = useMemo(
    () =>
      tiers.flatMap((t) => {
        const n = t.seated ? (chosen[t.id]?.length ?? 0) : (qty[t.id] ?? 0);
        return n > 0 ? [{ tier: t, n }] : [];
      }),
    [tiers, qty, chosen],
  );
  const total = lines.reduce((s, l) => s + l.n * l.tier.price_paise, 0);
  const count = lines.reduce((s, l) => s + l.n, 0);

  const book = async () => {
    if (!user) return nav('/login', { state: { from: here } });
    setErr('');
    setNote('');
    setBusy(true);
    try {
      const r = await post(`/events/${id}/holds`, {
        items: lines.map((l) => (l.tier.seated ? { tier_id: l.tier.id, seat_ids: chosen[l.tier.id] } : { tier_id: l.tier.id, quantity: l.n })),
        promo_code: promo.trim() || null,
        queue_pass: admitted ? queue!.pass : undefined,
      });
      nav(`/checkout/${r.hold.id}`);
    } catch (e) {
      setErr(friendly(e));
      if (e instanceof ApiError && (e.code === 'SEAT_TAKEN' || e.code === 'SOLD_OUT')) {
        setChosen({});
        void view.reload();
        void seats.reload();
      }
      if (e instanceof ApiError && e.code === 'NOT_ADMITTED') setQueue(null);
    } finally {
      setBusy(false);
    }
  };

  const waitlist = async () => {
    if (!user) return nav('/login', { state: { from: here } });
    setErr('');
    try {
      const r = await post<{ position: number }>(`/events/${id}/waitlist`);
      setNote(`You are number ${r.position} on the waitlist. We will message you when a seat frees up.`);
    } catch (e) {
      setErr(friendly(e));
    }
  };

  if (view.error instanceof ApiError && view.error.status === 404) {
    return <EmptyState title="That event does not exist" action={<Link className="btn" to="/">Back to events</Link>}>It may have been removed, or the link is mistyped.</EmptyState>;
  }
  if (!ev) return <PageSkeleton />;

  const soldOut = ev.available === 0;
  const onSale = ev.status === 'PUBLISHED';
  const blockedByQueue = needsQueue && !admitted;
  const cta = busy ? 'Holding' : !user ? 'Sign in to book' : blockedByQueue ? 'Join the waiting room first' : count === 0 ? 'Choose tickets' : `Hold ${count} ticket${count > 1 ? 's' : ''} · ${rupees(total)}`;
  const ctaDisabled = busy || (!!user && (count === 0 || blockedByQueue));
  const when = new Date(ev.starts_at).toLocaleString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
  const where = [ev.venue, ev.address && !ev.address.includes(ev.city) ? `${ev.address}, ${ev.city}` : ev.address || ev.city].filter(Boolean).join(', ');

  const toggleSeat = (t: Tier, seatId: string) =>
    setChosen((c) => {
      const cur = c[t.id] ?? [];
      return { ...c, [t.id]: cur.includes(seatId) ? cur.filter((x) => x !== seatId) : cur.length < t.max_per_order ? [...cur, seatId] : cur };
    });
  const jumpToSeats = (tierId: string) => document.getElementById(`seats-${tierId}`)?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });

  return (
    <>
      <div className="event-page event-page--buy">
        <div className="event-page__main">
          <Poster banner={ev.banner} category={ev.category} startsAt={ev.starts_at} size="hero" flag={!onSale ? <Tag tone="ink">{ev.status === 'CANCELLED' ? 'Sales stopped' : 'Not on sale'}</Tag> : soldOut ? <Tag tone="ink">Sold out</Tag> : undefined} />
          <h1 style={{ fontSize: 'clamp(40px, 6.4vw, 72px)' }}>{ev.name}</h1>
          <ul className="facts">
            <li><CalendarBlank size={20} weight="light" aria-hidden /><span>{when}</span></li>
            <li><MapPin size={20} weight="light" aria-hidden /><span>{where}</span></li>
            {ev.organiser && <li><User size={20} weight="light" aria-hidden /><span>Hosted by {ev.organiser}</span></li>}
          </ul>
          {ev.description && <p className="lede">{ev.description}</p>}
        </div>

        <aside className="card booking" aria-labelledby="tickets-title">
          <div className="row between" style={{ marginBottom: 8 }}>
            <h2 id="tickets-title" style={{ fontSize: 28 }}>Tickets</h2>
            <span className="small muted">{soldOut ? 'Sold out' : `${ev.available.toLocaleString('en-IN')} left`}</span>
          </div>

          {needsQueue && onSale && !soldOut && <QueuePanel user={user} here={here} queue={queue} startPos={startPos} joining={joining} admitLeft={admitLeft} admitTotal={admitTotal.current} onJoin={join} />}

          {tiers.map((t) => {
            const cap = Math.min(t.max_per_order, t.available);
            const n = t.seated ? (chosen[t.id]?.length ?? 0) : (qty[t.id] ?? 0);
            return (
              <div className="tier-row" key={t.id}>
                <div>
                  <p className="tier-row__name">{t.name}</p>
                  <p className="tier-row__meta">{rupees(t.price_paise)}{t.available === 0 ? ', none left' : `, ${t.available} left`}{t.seated ? ', reserved seats' : ''}</p>
                </div>
                {t.seated ? (
                  <button className="btn btn--outline btn--sm" disabled={t.available === 0} onClick={() => jumpToSeats(t.id)}>{n ? `${n} chosen` : 'Choose seats'}</button>
                ) : (
                  <div className="stepper" role="group" aria-label={`${t.name} quantity`}>
                    <button aria-label={`Fewer ${t.name}`} disabled={!n} onClick={() => setQty({ ...qty, [t.id]: n - 1 })}>−</button>
                    <output aria-live="polite">{n}</output>
                    <button aria-label={`More ${t.name}`} disabled={n >= cap || !onSale} onClick={() => setQty({ ...qty, [t.id]: n + 1 })}>+</button>
                  </div>
                )}
              </div>
            );
          })}

          {!soldOut && onSale && (
            <div style={{ marginTop: 8 }}>
              {promoOpen ? (
                <div className="field">
                  <label className="field__label" htmlFor="promo">Promo code</label>
                  <input id="promo" className="input" value={promo} onChange={(e) => setPromo(e.target.value)} autoCapitalize="characters" autoComplete="off" spellCheck={false} />
                </div>
              ) : (
                <button className="linkbtn" onClick={() => setPromoOpen(true)}>Have a promo code?</button>
              )}
            </div>
          )}

          {err && <Notice>{err}</Notice>}
          {note && <Notice kind="ok">{note}</Notice>}

          {!onSale ? (
            <Notice kind="info">Sales are not open for this event.</Notice>
          ) : soldOut ? (
            <div style={{ marginTop: 16 }}>
              <p className="small">Everything is taken right now. Holds that are not paid return to sale, so seats often reappear.</p>
              <button className="btn btn--outline btn--block" onClick={waitlist}>Tell me if a seat frees up</button>
            </div>
          ) : (
            <button className="btn btn--lg btn--block booking__cta" style={{ marginTop: 16 }} disabled={ctaDisabled} aria-busy={busy} onClick={book}>{cta}</button>
          )}

          <ol className="how">
            <li>Choose your tickets.</li>
            <li>We hold them for {holdMinutes} minutes while you pay.</li>
            <li>Show the QR code at the gate.</li>
          </ol>
        </aside>
      </div>

      {tiers.filter((t) => t.seated).map((t) => {
        const picked = chosen[t.id] ?? [];
        const list = seats.data?.tiers[t.id] ?? [];
        const labels = picked.map((sid) => list.find((s) => s.id === sid)).filter(Boolean).map((s) => `${s!.row}${s!.no}`);
        return (
          <section className="sect" id={`seats-${t.id}`} key={t.id} aria-labelledby={`seats-title-${t.id}`}>
            <div className="band">
              <div className="row between" style={{ marginBottom: 20 }}>
                <h2 id={`seats-title-${t.id}`} style={{ fontSize: 'clamp(28px, 3.4vw, 40px)' }}>{t.name}</h2>
                <span className="muted">{rupees(t.price_paise)} each. Choose up to {t.max_per_order}.</span>
              </div>
              <SeatMap seats={list} picked={picked} onToggle={(sid) => toggleSeat(t, sid)} />
              <p className="small" style={{ margin: '16px 0 0' }} aria-live="polite">{labels.length ? `Your seats: ${labels.join(', ')}` : 'Tap a seat to choose it.'}</p>
            </div>
          </section>
        );
      })}

      {onSale && !soldOut && (
        <div className="buybar">
          <div>
            <span className="mono">{count ? `${count} selected` : 'Nothing selected'}</span>
            <div className="num" style={{ fontSize: 24, lineHeight: 1.1 }}>{money(total)}</div>
          </div>
          <button className="btn btn--lg" disabled={ctaDisabled} aria-busy={busy} onClick={book}>{cta}</button>
        </div>
      )}
    </>
  );
}

function QueuePanel({ user, here, queue, startPos, joining, admitLeft, admitTotal, onJoin }: { user: Account | null; here: string; queue: QueueState | null; startPos: number; joining: boolean; admitLeft: number; admitTotal: number; onJoin: () => void }) {
  if (!user) {
    return (
      <div className="queue" style={{ margin: '16px 0' }}>
        <p className="small" style={{ margin: 0 }}>This sale uses a fair line. <Link to="/login" state={{ from: here }}>Sign in</Link> to join it.</p>
      </div>
    );
  }
  if (!queue || queue.status === 'USED' || queue.status === 'EXPIRED') {
    return (
      <div className="queue" style={{ margin: '16px 0' }}>
        <p className="small">{queue?.status === 'EXPIRED' ? 'Your turn ran out. Join again to get a new place. ' : ''}First come, first served. A few people are let in at a time, so the page never freezes.</p>
        <button className="btn btn--block" onClick={onJoin} disabled={joining} aria-busy={joining}>{joining ? 'Joining' : 'Join the waiting room'}</button>
      </div>
    );
  }
  if (queue.status === 'WAITING') {
    const progress = startPos > 0 ? 1 - queue.position / startPos : 0;
    return (
      <div className="queue" style={{ margin: '16px 0' }}>
        <span className="mono">Your place in line</span>
        <span className="queue__pos"><span className="roll" key={queue.position}>#{queue.position.toLocaleString('en-IN')}</span></span>
        <p className="small" style={{ margin: '8px 0 0' }}>{queue.ahead.toLocaleString('en-IN')} ahead of you, about {Math.max(1, Math.round(queue.eta_seconds / 60))} min. Keep this page open; it updates by itself.</p>
        <Meter fraction={progress} />
        <p className="sr-only" role="status">{queue.ahead < 10 ? `${queue.ahead} people ahead of you.` : `Waiting in line.`}</p>
      </div>
    );
  }
  return (
    <div className="queue" style={{ margin: '16px 0' }}>
      <span className="mono">Your turn</span>
      <p className="num" style={{ fontSize: 32, margin: '4px 0 0' }}>You are in.</p>
      <p className="small" style={{ margin: '4px 0 0' }} role="status">Choose your tickets and hold them within {mmss(admitLeft)}.</p>
      <Meter fraction={admitTotal ? admitLeft / admitTotal : 1} linear />
    </div>
  );
}

function SeatMap({ seats, picked, onToggle }: { seats: Seat[]; picked: string[]; onToggle: (id: string) => void }) {
  const rows = useMemo(() => {
    const m = new Map<string, Seat[]>();
    for (const s of seats) m.set(s.row, [...(m.get(s.row) ?? []), s]);
    return [...m];
  }, [seats]);
  if (!seats.length) return <div className="skeleton" style={{ height: 160 }} role="status" aria-label="Loading seats" />;
  return (
    <div className="seatmap">
      <div className="seatmap__inner" role="group" aria-label="Seat map">
        <div className="stage" aria-hidden>STAGE</div>
        {rows.map(([row, list]) => (
          <div className="seatrow" key={row}>
            <span className="seatrow__label" aria-hidden>{row}</span>
            {list.map((s) => {
              const taken = s.status !== 'AVAILABLE';
              const sel = picked.includes(s.id);
              return (
                <button key={s.id} className="seat" disabled={taken} aria-pressed={sel} aria-label={`Seat ${row}${s.no}${taken ? ', taken' : ''}`} onClick={() => onToggle(s.id)}>
                  {s.no}
                </button>
              );
            })}
          </div>
        ))}
        <div className="legend" aria-hidden>
          <span><i style={{ background: '#fff' }} />Free</span>
          <span><i style={{ background: '#000' }} />Yours</span>
          <span><i style={{ background: 'var(--stone)', borderColor: 'var(--stone)' }} />Taken</span>
        </div>
      </div>
    </div>
  );
}
