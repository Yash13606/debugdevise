import { Storefront } from '@phosphor-icons/react';
import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { friendly, get, post } from '../api';
import { useAuth } from '../auth';
import { dateTime, money, useLoad, usePageTitle } from '../lib';
import { EmptyState, Notice, PageSkeleton, Poster, Tag } from '../ui';

interface Row { id: string; name: string; city: string; status: string; starts_at: string; capacity: number; sold: number; held: number; available: number; revenue_paise: number }

// Flat poster colours that sit with the cream canvas. No gradients (DESIGN.md).
const COLOURS = [
  { hex: '#17382f', name: 'Forest' },
  { hex: '#1c2a52', name: 'Navy' },
  { hex: '#4a2340', name: 'Plum' },
  { hex: '#e8b13a', name: 'Saffron' },
  { hex: '#d3cec6', name: 'Stone' },
  { hex: '#111111', name: 'Ink' },
];
interface TierForm { name: string; price: string; seated: boolean; capacity: string; rows: string; perRow: string; max: string }
const blankTier = (): TierForm => ({ name: '', price: '', seated: false, capacity: '100', rows: '5', perRow: '10', max: '6' });
const num = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? NaN : Number(s));

export default function Organiser() {
  const { user, ready, setUser } = useAuth();
  const nav = useNavigate();
  usePageTitle('Organiser');
  const events = useLoad(() => (user?.role === 'ORGANISER' ? get<{ events: Row[] }>('/organiser/events') : Promise.resolve(null)), [user?.id, user?.role], 8000);
  const meta = useLoad(() => get<{ cities: string[]; categories: string[] }>('/meta'), []);
  const [org, setOrg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [making, setMaking] = useState(false);
  const [tried, setTried] = useState(false);
  const [f, setF] = useState({ name: '', description: '', category: 'Music', city: 'Bengaluru', venue: '', address: '', starts_at: '', colour: COLOURS[0]!.hex, queue: false, publish: true });
  const [tiers, setTiers] = useState<TierForm[]>([{ ...blankTier(), name: 'General', price: '499' }]);

  const previewDate = useMemo(() => {
    const d = f.starts_at ? new Date(f.starts_at) : new Date(Date.now() + 14 * 86_400_000);
    return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString();
  }, [f.starts_at]);

  if (ready && !user) return <Navigate to="/login" state={{ from: '/organiser' }} replace />;
  if (!user) return <PageSkeleton />;

  if (user.role !== 'ORGANISER') {
    return (
      <div className="split" style={{ marginTop: 16 }}>
        <div>
          <h1>Run your own sale.</h1>
          <p className="lede" style={{ marginTop: 24 }}>Create an event, choose general entry or reserved seats, open a fair waiting room for the big rush, and watch every count audited live.</p>
        </div>
        <form
          className="card"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr('');
            try {
              setUser((await post<{ user: typeof user }>('/me/organiser', { org_name: org })).user);
            } catch (x) {
              setErr(friendly(x));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="field">
            <label className="field__label" htmlFor="org">Organisation name</label>
            <input id="org" className="input" value={org} onChange={(e) => setOrg(e.target.value)} required />
            <p className="field__hint">Buyers see this as the host of your events.</p>
          </div>
          {err && <Notice>{err}</Notice>}
          <button className="btn btn--lg btn--block" style={{ marginTop: 20 }} disabled={busy || !org.trim()}>Become an organiser</button>
          <p className="small muted" style={{ margin: '16px 0 0' }}>This demo has no vetting step.</p>
        </form>
      </div>
    );
  }

  const setTier = (i: number, patch: Partial<TierForm>) => setTiers(tiers.map((t, k) => (k === i ? { ...t, ...patch } : t)));
  const tierProblem = (t: TierForm) => {
    if (!t.name.trim()) return 'Give this ticket type a name.';
    if (!(num(t.price) >= 0)) return 'Enter a price in rupees. Use 0 for free.';
    if (t.seated ? !(num(t.rows) >= 1 && num(t.perRow) >= 1) : !(num(t.capacity) >= 1)) return t.seated ? 'Enter rows and seats per row.' : 'Enter how many tickets.';
    return '';
  };
  const problems = [!f.name.trim() && 'Name your event.', !f.starts_at && 'Choose when it starts.', ...tiers.map(tierProblem)].filter(Boolean) as string[];

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.length) return;
    setErr('');
    setBusy(true);
    try {
      const r = await post<{ event: { id: string } }>('/organiser/events', {
        name: f.name.trim(), description: f.description, category: f.category, city: f.city, venue: f.venue, address: f.address,
        banner: `${f.colour},#111111`, starts_at: new Date(f.starts_at).toISOString(), queue_enabled: f.queue, publish: f.publish,
        tiers: tiers.map((t) => ({
          name: t.name.trim(), price_paise: Math.round(Number(t.price) * 100), max_per_order: num(t.max) >= 1 ? Number(t.max) : 6,
          ...(t.seated ? { seated: { rows: Number(t.rows), seats_per_row: Number(t.perRow) } } : { capacity: Number(t.capacity) }),
        })),
      });
      nav(`/organiser/${r.event.id}`);
    } catch (x) {
      setErr(friendly(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="row between">
        <div>
          <p className="mono" style={{ margin: '0 0 8px' }}>{user.org_name}</p>
          <h1>Your events.</h1>
        </div>
        <button className="btn" onClick={() => setMaking(!making)} aria-expanded={making}>{making ? 'Close the form' : 'Create an event'}</button>
      </div>

      {making && (
        <div className="split sect--tight" style={{ marginTop: 40 }}>
          <form className="stack stack--loose" onSubmit={create} noValidate aria-label="New event">
            <div className="form-grid">
              <div className="field">
                <label className="field__label" htmlFor="n">Event name</label>
                <input id="n" className="input" value={f.name} aria-invalid={tried && !f.name.trim()} onChange={(e) => setF({ ...f, name: e.target.value })} required />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="d">Starts</label>
                <input id="d" className="input" type="datetime-local" value={f.starts_at} aria-invalid={tried && !f.starts_at} onChange={(e) => setF({ ...f, starts_at: e.target.value })} required />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="c">Category</label>
                <select id="c" className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{meta.data?.categories.map((c) => <option key={c}>{c}</option>)}</select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="ci">City</label>
                <select id="ci" className="select" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })}>{meta.data?.cities.map((c) => <option key={c}>{c}</option>)}</select>
              </div>
              <div className="field">
                <label className="field__label" htmlFor="v">Venue</label>
                <input id="v" className="input" value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="a">Address</label>
                <input id="a" className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
              </div>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="ds">Description</label>
              <textarea id="ds" className="textarea input" rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
              <p className="field__hint">One or two sentences. Buyers read this under the poster.</p>
            </div>
            <fieldset className="fieldset">
              <legend>Poster colour</legend>
              <div className="swatches">
                {COLOURS.map((c) => (
                  <button type="button" key={c.hex} className="swatch" aria-label={c.name} aria-pressed={f.colour === c.hex} style={{ background: c.hex }} onClick={() => setF({ ...f, colour: c.hex })} />
                ))}
              </div>
            </fieldset>

            <fieldset className="fieldset stack">
              <legend>Ticket types</legend>
              {tiers.map((t, i) => {
                const problem = tried ? tierProblem(t) : '';
                return (
                  <div className="tier-form" key={i} role="group" aria-label={`Ticket type ${i + 1}`}>
                    <div className="form-grid">
                      <div className="field">
                        <label className="field__label" htmlFor={`tn${i}`}>Name</label>
                        <input id={`tn${i}`} className="input" value={t.name} onChange={(e) => setTier(i, { name: e.target.value })} />
                      </div>
                      <div className="field">
                        <label className="field__label" htmlFor={`tp${i}`}>Price in rupees</label>
                        <input id={`tp${i}`} className="input" inputMode="decimal" value={t.price} onChange={(e) => setTier(i, { price: e.target.value })} />
                      </div>
                      <div className="field">
                        <label className="field__label" htmlFor={`te${i}`}>Entry</label>
                        <select id={`te${i}`} className="select" value={t.seated ? 'seats' : 'general'} onChange={(e) => setTier(i, { seated: e.target.value === 'seats' })}>
                          <option value="general">General entry</option>
                          <option value="seats">Reserved seats</option>
                        </select>
                      </div>
                      <div className="field">
                        <label className="field__label" htmlFor={`tm${i}`}>Most per order</label>
                        <input id={`tm${i}`} className="input" inputMode="numeric" value={t.max} onChange={(e) => setTier(i, { max: e.target.value })} />
                      </div>
                      {t.seated ? (
                        <>
                          <div className="field">
                            <label className="field__label" htmlFor={`tr${i}`}>Rows</label>
                            <input id={`tr${i}`} className="input" inputMode="numeric" value={t.rows} onChange={(e) => setTier(i, { rows: e.target.value })} />
                          </div>
                          <div className="field">
                            <label className="field__label" htmlFor={`ts${i}`}>Seats per row</label>
                            <input id={`ts${i}`} className="input" inputMode="numeric" value={t.perRow} onChange={(e) => setTier(i, { perRow: e.target.value })} />
                            <p className="field__hint">{(num(t.rows) || 0) * (num(t.perRow) || 0)} seats in total.</p>
                          </div>
                        </>
                      ) : (
                        <div className="field">
                          <label className="field__label" htmlFor={`tc${i}`}>Number of tickets</label>
                          <input id={`tc${i}`} className="input" inputMode="numeric" value={t.capacity} onChange={(e) => setTier(i, { capacity: e.target.value })} />
                        </div>
                      )}
                    </div>
                    {problem && <p className="field__error" role="alert">{problem}</p>}
                    {tiers.length > 1 && <button type="button" className="btn btn--ghost btn--sm" style={{ marginTop: 12 }} onClick={() => setTiers(tiers.filter((_, k) => k !== i))}>Remove this type</button>}
                  </div>
                );
              })}
              <button type="button" className="btn btn--outline btn--sm" onClick={() => setTiers([...tiers, blankTier()])}>Add another ticket type</button>
            </fieldset>

            <div>
              <label className="check"><input type="checkbox" checked={f.queue} onChange={(e) => setF({ ...f, queue: e.target.checked })} />Use a waiting room for the first rush</label>
              <label className="check"><input type="checkbox" checked={f.publish} onChange={(e) => setF({ ...f, publish: e.target.checked })} />Publish as soon as it is created</label>
            </div>
            {tried && problems.length > 0 && <Notice>{problems.length === 1 ? problems[0] : `${problems.length} things need fixing: ${problems.slice(0, 2).join(' ')}`}</Notice>}
            {err && <Notice>{err}</Notice>}
            <button className="btn btn--lg" disabled={busy} aria-busy={busy}>{busy ? 'Creating' : 'Create event'}</button>
          </form>

          <aside className="preview" aria-label="Preview">
            <span className="label">How buyers will see it</span>
            <div className="event" aria-hidden>
              <Poster banner={`${f.colour},#111111`} category={f.category} startsAt={previewDate} size="lead" />
              <div className="event__body">
                <h3 className="event__title">{f.name.trim() || 'Your event name'}</h3>
                <p className="event__meta">{[f.venue, f.city].filter(Boolean).join(', ')}</p>
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className="sect">
        {!events.data ? (
          <PageSkeleton />
        ) : events.data.events.length === 0 ? (
          <EmptyState icon={<Storefront size={32} weight="light" aria-hidden />} title="No events yet" action={!making ? <button className="btn" onClick={() => setMaking(true)}>Create your first event</button> : undefined}>
            Create one and it appears here, with live sales, an audit of every count, and a gate scanner for the night.
          </EmptyState>
        ) : (
          <div className="card table-wrap" style={{ padding: '8px 24px' }}>
            <table className="table">
              <caption className="sr-only">Your events</caption>
              <thead><tr><th scope="col">Event</th><th scope="col">Starts</th><th scope="col">Status</th><th scope="col">Sold</th><th scope="col">Net sales</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
              <tbody>
                {events.data.events.map((e) => (
                  <tr key={e.id}>
                    <td><Link to={`/organiser/${e.id}`}>{e.name}</Link><div className="small muted">{e.city}</div></td>
                    <td className="nowrap">{dateTime(e.starts_at)}</td>
                    <td><Tag tone={e.status === 'PUBLISHED' ? 'ok' : e.status === 'CANCELLED' ? 'bad' : undefined}>{e.status === 'PUBLISHED' ? 'On sale' : e.status === 'CANCELLED' ? 'Stopped' : 'Draft'}</Tag></td>
                    <td className="nowrap">{e.sold} of {e.capacity}{e.held ? <span className="muted">, {e.held} held</span> : null}</td>
                    <td className="nowrap">{money(e.revenue_paise)}</td>
                    <td><Link className="btn btn--outline btn--sm" to={`/organiser/${e.id}`}>Open</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
