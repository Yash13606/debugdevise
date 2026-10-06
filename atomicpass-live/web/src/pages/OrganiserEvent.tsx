import { CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { del, friendly, get, patch, post } from '../api';
import { useAuth } from '../auth';
import { money, rupees, timeOnly, useLoad, usePageTitle } from '../lib';
import { ConfirmAction, EmptyState, Notice, PageSkeleton, Tabs, Tag } from '../ui';

interface Tier { id: string; name: string; price_paise: number; capacity: number; sold: number; held: number; available: number; seated: boolean }
interface Stats {
  event: { id: string; name: string; status: string; capacity: number; sold: number; held: number; available: number; queue_enabled: boolean };
  tiers: Tier[];
  tickets: { VALID: number; CHECKED_IN: number; VOID: number };
  holds: Record<string, number>;
  queue: { WAITING: number; ADMITTED: number; USED: number; EXPIRED: number };
  waitlist: { waiting: number };
  money: { gross_paise: number; refunded_paise: number; orders: number };
  invariants: { ok: boolean; mismatches: { rule: string; subject: string; expected: unknown; actual: unknown }[] };
  timeline: { t: string; holds: number; orders: number }[];
}
type TabName = 'Overview' | 'Tickets' | 'Gate team' | 'Money';
const TABS: { value: TabName; label: string }[] = [{ value: 'Overview', label: 'Overview' }, { value: 'Tickets', label: 'Tickets' }, { value: 'Gate team', label: 'Gate team' }, { value: 'Money', label: 'Money' }];

export default function OrganiserEvent() {
  const { id = '' } = useParams();
  const { user, ready } = useAuth();
  const [tab, setTab] = useState<TabName>('Overview');
  const s = useLoad(() => get<Stats>(`/organiser/events/${id}`), [id], 3000);
  const [updated, setUpdated] = useState('');
  useEffect(() => {
    if (s.data) setUpdated(new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' }));
  }, [s.data]);
  usePageTitle(s.data?.event.name ?? 'Event dashboard');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const run = async (f: () => Promise<unknown>, ok: string) => {
    try {
      await f();
      setMsg({ kind: 'ok', text: ok });
      await s.reload();
    } catch (e) {
      setMsg({ kind: 'error', text: friendly(e) });
    }
  };

  if (ready && !user) return <Navigate to="/login" state={{ from: `/organiser/${id}` }} replace />;
  if (s.error && !s.data) return <EmptyState title="That event is not yours" action={<Link className="btn" to="/organiser">Back to your events</Link>}>It does not exist, or it belongs to another organiser.</EmptyState>;
  if (!s.data) return <PageSkeleton />;
  const d = s.data;
  const statusTag = d.event.status === 'PUBLISHED' ? <Tag tone="ok">On sale</Tag> : d.event.status === 'CANCELLED' ? <Tag tone="bad">Sales stopped</Tag> : <Tag>Draft</Tag>;

  return (
    <>
      <p className="mono" style={{ margin: '0 0 12px' }}><Link to="/organiser">Your events</Link></p>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(36px, 5.4vw, 64px)' }}>{d.event.name}</h1>
          <div className="row" style={{ marginTop: 16 }}>{statusTag}<Tag>Live, updated {updated}</Tag></div>
        </div>
        <div className="row">
          <Link className="btn btn--outline" to="/gate">Open the gate scanner</Link>
          <Link className="btn btn--ghost" to={`/e/${id}`}>View public page</Link>
        </div>
      </div>

      <div className={'audit ' + (d.invariants.ok ? 'audit--ok' : 'audit--bad')} role="status" style={{ marginTop: 24 }}>
        {d.invariants.ok ? <CheckCircle size={20} weight="light" aria-hidden /> : <WarningCircle size={20} weight="light" aria-hidden />}
        <div>
          <strong>{d.invariants.ok ? 'Audit clean.' : `Audit found ${d.invariants.mismatches.length} problem${d.invariants.mismatches.length === 1 ? '' : 's'}.`}</strong>{' '}
          {d.invariants.ok ? 'Every count was recomputed from the records and matches.' : d.invariants.mismatches.slice(0, 3).map((m) => `${m.rule} ${m.subject}: expected ${String(m.expected)}, got ${String(m.actual)}`).join('. ')}
        </div>
      </div>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}

      <div style={{ marginTop: 24 }}><Tabs items={TABS} value={tab} onChange={setTab} label="Event sections" /></div>
      <div style={{ marginTop: 32 }}>
        {tab === 'Overview' && <Overview d={d} id={id} run={run} />}
        {tab === 'Tickets' && <TicketsTab id={id} tiers={d.tiers} run={run} />}
        {tab === 'Gate team' && <GateTeam id={id} run={run} />}
        {tab === 'Money' && <Money id={id} />}
      </div>
    </>
  );
}

function Overview({ d, id, run }: { d: Stats; id: string; run: (f: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const kpi = (label: string, value: React.ReactNode) => (
    <div className="kpi"><span className="mono">{label}</span><span className="kpi__value">{value}</span></div>
  );
  return (
    <>
      <div className="grid g4">
        {kpi('Sold', d.event.sold.toLocaleString('en-IN'))}
        {kpi('On hold', d.event.held.toLocaleString('en-IN'))}
        {kpi('Available', d.event.available.toLocaleString('en-IN'))}
        {kpi('Net sales', money(d.money.gross_paise - d.money.refunded_paise))}
        {kpi('In the waiting room', d.queue.WAITING)}
        {kpi('Let in, not booked', d.queue.ADMITTED)}
        {kpi('On the waitlist', d.waitlist.waiting)}
        {kpi('Through the gate', <>{d.tickets.CHECKED_IN}<small> of {d.tickets.VALID + d.tickets.CHECKED_IN}</small></>)}
      </div>
      <section className="card sect--tight" aria-labelledby="tl-title">
        <div className="row between"><h2 id="tl-title" style={{ fontSize: 24, fontWeight: 400 }}>The last 30 minutes</h2><span className="legend" aria-hidden><span><i style={{ background: '#111' }} />Orders paid</span><span><i style={{ background: 'var(--stone)', borderColor: 'var(--stone)' }} />Holds started</span></span></div>
        <Timeline data={d.timeline} />
      </section>
      <div className="row sect--tight">
        <button className="btn btn--outline" onClick={() => run(() => patch(`/organiser/events/${id}`, { queue_enabled: !d.event.queue_enabled }), d.event.queue_enabled ? 'Waiting room switched off.' : 'Waiting room switched on.')}>
          {d.event.queue_enabled ? 'Switch the waiting room off' : 'Switch the waiting room on'}
        </button>
        {d.event.status === 'DRAFT' && <button className="btn" onClick={() => run(() => patch(`/organiser/events/${id}`, { status: 'PUBLISHED' }), 'Published. It is on sale now.')}>Publish</button>}
        {d.event.status !== 'CANCELLED' && (
          <ConfirmAction label="Stop sales" question="Stop sales for good? Tickets already sold stay valid until you refund them." confirmLabel="Stop sales" keepLabel="Keep selling" onConfirm={() => run(() => patch(`/organiser/events/${id}`, { status: 'CANCELLED' }), 'Sales stopped.')} />
        )}
      </div>
    </>
  );
}

function Timeline({ data }: { data: Stats['timeline'] }) {
  const max = Math.max(1, ...data.map((m) => Math.max(m.holds, m.orders)));
  const orders = data.reduce((s, m) => s + m.orders, 0);
  const holds = data.reduce((s, m) => s + m.holds, 0);
  const w = 600, h = 120, bw = w / data.length;
  return (
    <>
      <p className="small muted" style={{ margin: '4px 0 12px' }}>{orders} order{orders === 1 ? '' : 's'} paid and {holds} hold{holds === 1 ? '' : 's'} started. Busiest minute: {max === 1 && !orders && !holds ? 'none yet' : `${max}`}.</p>
      <svg className="chart" viewBox={`0 0 ${w} ${h + 20}`} preserveAspectRatio="none" role="img" aria-label={`Holds and orders per minute over the last 30 minutes. ${orders} orders, ${holds} holds.`}>
        {data.map((m, i) => (
          <g key={m.t}>
            <title>{`${timeOnly(m.t).replace(/:\d\d /, ' ')}: ${m.holds} holds, ${m.orders} orders`}</title>
            <rect x={i * bw + 1} width={bw / 2 - 1} y={h - (m.holds / max) * h} height={(m.holds / max) * h} fill="#d3cec6" />
            <rect x={i * bw + bw / 2} width={bw / 2 - 1} y={h - (m.orders / max) * h} height={(m.orders / max) * h} fill="#111111" />
          </g>
        ))}
        <line x1="0" x2={w} y1={h} y2={h} stroke="#dedbd6" />
        <text x="0" y={h + 14}>{timeOnly(data[0]!.t).replace(/:\d\d /, ' ')}</text>
        <text x={w} y={h + 14} textAnchor="end">now</text>
      </svg>
    </>
  );
}

function TicketsTab({ id, tiers, run }: { id: string; tiers: Tier[]; run: (f: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [t, setT] = useState({ name: '', price: '', capacity: '50' });
  const [p, setP] = useState({ code: '', kind: 'PERCENT', value: '10', max: '' });
  return (
    <div className="stack">
      <div className="card table-wrap" style={{ padding: '8px 24px' }}>
        <table className="table">
          <caption className="sr-only">Ticket types</caption>
          <thead><tr><th scope="col">Type</th><th scope="col">Price</th><th scope="col">Sold</th><th scope="col">Held</th><th scope="col">Available</th><th scope="col">Filled</th></tr></thead>
          <tbody>{tiers.map((x) => (
            <tr key={x.id}>
              <td>{x.name} {x.seated && <Tag>Seats</Tag>}</td><td>{rupees(x.price_paise)}</td><td>{x.sold}</td><td>{x.held}</td><td>{x.available}</td>
              <td style={{ width: 160 }}><div className="bar" role="img" aria-label={`${Math.round(((x.sold + x.held) / Math.max(1, x.capacity)) * 100)} percent filled`}><i style={{ width: `${Math.round(((x.sold + x.held) / Math.max(1, x.capacity)) * 100)}%` }} /></div></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <div className="grid g2">
        <form className="card" onSubmit={(e) => { e.preventDefault(); void run(() => post(`/organiser/events/${id}/tiers`, { name: t.name, price_paise: Math.round(Number(t.price) * 100), capacity: Number(t.capacity) }), 'Ticket type added. It is on sale now.'); }}>
          <h3 style={{ fontSize: 24, fontWeight: 400, marginBottom: 16 }}>Release more tickets</h3>
          <div className="field"><label className="field__label" htmlFor="nt-name">Name</label><input id="nt-name" className="input" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} required /></div>
          <div className="form-grid field">
            <div className="field"><label className="field__label" htmlFor="nt-price">Price in rupees</label><input id="nt-price" className="input" inputMode="decimal" value={t.price} onChange={(e) => setT({ ...t, price: e.target.value })} required /></div>
            <div className="field"><label className="field__label" htmlFor="nt-cap">Tickets</label><input id="nt-cap" className="input" inputMode="numeric" value={t.capacity} onChange={(e) => setT({ ...t, capacity: e.target.value })} required /></div>
          </div>
          <button className="btn" style={{ marginTop: 20 }}>Add ticket type</button>
        </form>
        <form className="card" onSubmit={(e) => { e.preventDefault(); void run(() => post(`/organiser/events/${id}/promo-codes`, { code: p.code, kind: p.kind, value: p.kind === 'FIXED' ? Math.round(Number(p.value) * 100) : Number(p.value), max_uses: p.max ? Number(p.max) : null }), `Code ${p.code.toUpperCase()} created.`); }}>
          <h3 style={{ fontSize: 24, fontWeight: 400, marginBottom: 16 }}>Promo code</h3>
          <div className="field"><label className="field__label" htmlFor="pc-code">Code</label><input id="pc-code" className="input" value={p.code} onChange={(e) => setP({ ...p, code: e.target.value })} required pattern="[A-Za-z0-9_\-]{1,32}" /></div>
          <div className="form-grid field">
            <div className="field"><label className="field__label" htmlFor="pc-kind">Discount</label><select id="pc-kind" className="select" value={p.kind} onChange={(e) => setP({ ...p, kind: e.target.value })}><option value="PERCENT">Percent off</option><option value="FIXED">Rupees off</option></select></div>
            <div className="field"><label className="field__label" htmlFor="pc-val">{p.kind === 'PERCENT' ? 'Percent' : 'Rupees'}</label><input id="pc-val" className="input" inputMode="decimal" value={p.value} onChange={(e) => setP({ ...p, value: e.target.value })} required /></div>
          </div>
          <div className="field"><label className="field__label" htmlFor="pc-max">Most uses</label><input id="pc-max" className="input" inputMode="numeric" value={p.max} onChange={(e) => setP({ ...p, max: e.target.value })} placeholder="No limit" /></div>
          <button className="btn" style={{ marginTop: 20 }}>Create code</button>
        </form>
      </div>
    </div>
  );
}

function GateTeam({ id, run }: { id: string; run: (f: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const team = useLoad(() => get<{ staff: { phone: string; name: string }[] }>(`/organiser/events/${id}/staff`), [id], 6000);
  const report = useLoad(() => get<{ staff: { phone: string; name: string; admitted: number; refused: number; last_at: string }[] }>(`/organiser/events/${id}/scan-report`), [id], 4000);
  const [phone, setPhone] = useState('');
  return (
    <div className="grid g2">
      <section className="card" aria-labelledby="who-title">
        <h3 id="who-title" style={{ fontSize: 24, fontWeight: 400 }}>Who can scan</h3>
        <p className="small muted">Each person signs in with their own phone code on their own device. Remove someone and their very next scan is refused.</p>
        {team.data?.staff.length === 0 && <p className="small">Only you, for now.</p>}
        {team.data?.staff.map((m) => (
          <div className="row between" key={m.phone} style={{ padding: '10px 0', borderTop: '1px solid var(--hairline)' }}>
            <span>{m.name || 'Not signed in yet'} <span className="mono">{m.phone}</span></span>
            <ConfirmAction label="Remove" question={`Remove ${m.name || m.phone} from the gate team?`} confirmLabel="Remove" keepLabel="Keep" onConfirm={() => run(async () => { await del(`/organiser/events/${id}/staff/${encodeURIComponent(m.phone)}`); await team.reload(); }, 'Removed from the gate team.')} />
          </div>
        ))}
        <form className="row" style={{ marginTop: 16, alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`/organiser/events/${id}/staff`, { phone }); setPhone(''); await team.reload(); }, 'Added to the gate team.'); }}>
          <div className="grow"><label className="field__label" htmlFor="staff-phone">Add by phone number</label><input id="staff-phone" className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required /></div>
          <button className="btn">Add</button>
        </form>
      </section>
      <section className="card" aria-labelledby="scans-title">
        <h3 id="scans-title" style={{ fontSize: 24, fontWeight: 400 }}>Scans by person</h3>
        {!report.data || report.data.staff.length === 0 ? <p className="small muted">No scans yet.</p> : (
          <div className="table-wrap"><table className="table"><thead><tr><th scope="col">Person</th><th scope="col">Admitted</th><th scope="col">Refused</th></tr></thead>
            <tbody>{report.data.staff.map((r) => <tr key={r.phone}><td>{r.name || r.phone}<div className="small muted">last scan {timeOnly(r.last_at)}</div></td><td>{r.admitted}</td><td>{r.refused}</td></tr>)}</tbody></table></div>
        )}
      </section>
    </div>
  );
}

function Money({ id }: { id: string }) {
  const m = useLoad(() => get<any>(`/organiser/events/${id}/settlement`), [id], 6000);
  if (!m.data) return <PageSkeleton />;
  const s = m.data;
  const rows: [string, number, boolean?][] = [['Sales', s.gross_paise], ['Refunds', -s.refunds_paise], ['Net sales', s.net_sales_paise, true], [`Platform fee (${s.rates.platform_fee_bps / 100}%)`, -s.platform_fee_paise], [`GST on the fee (${s.rates.gst_bps / 100}%)`, -s.gst_on_fee_paise], ['You would be paid', s.payable_paise, true]];
  return (
    <div className="grid g2">
      <section className="card" aria-labelledby="settle-title">
        <h3 id="settle-title" style={{ fontSize: 24, fontWeight: 400 }}>Settlement preview</h3>
        {rows.map(([k, v, strong]) => (
          <div className="summary__row" key={k} style={{ borderTop: '1px solid var(--hairline)', fontWeight: strong ? 500 : 400 }}>
            <span>{k}</span><span className="num" style={{ fontSize: strong ? 24 : 18 }}>{v < 0 ? '−' : ''}{money(Math.abs(v))}</span>
          </div>
        ))}
        {s.refunds_pending_paise > 0 && <Notice kind="info">{money(s.refunds_pending_paise)} of refunds are still on their way to buyers’ banks.</Notice>}
        <Notice kind="info">Illustrative only. This demo pays nobody and issues no invoices; the rates are settings.</Notice>
      </section>
      <section className="card" aria-labelledby="by-tier-title">
        <h3 id="by-tier-title" style={{ fontSize: 24, fontWeight: 400 }}>Sold by ticket type</h3>
        <div className="table-wrap"><table className="table"><thead><tr><th scope="col">Type</th><th scope="col">Tickets</th><th scope="col">Revenue</th></tr></thead><tbody>{s.by_tier.map((t: any) => <tr key={t.tier}><td>{t.tier}</td><td>{t.sold}</td><td>{money(t.revenue)}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}
