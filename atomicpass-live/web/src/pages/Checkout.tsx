import { Check } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, del, friendly, get, post } from '../api';
import { money, mmss, sleep, useCountdown, useLoad, usePageTitle } from '../lib';
import { EmptyState, Meter, Modal, Notice, PageSkeleton } from '../ui';

interface Hold {
  id: string; status: 'ACTIVE' | 'PAYING' | 'CONVERTED' | 'EXPIRED' | 'RELEASED'; event_id: string;
  items: { tier_id: string; quantity: number; unit_price_paise: number }[]; seats: string[];
  subtotal_paise: number; discount_paise: number; total_paise: number; seconds_left: number; order_id: string | null;
}

export default function Checkout() {
  const { holdId = '' } = useParams();
  const nav = useNavigate();
  usePageTitle('Checkout');
  const h = useLoad(() => get<{ hold: Hold }>(`/holds/${holdId}`), [holdId], 4000);
  const hold = h.data?.hold;
  const ev = useLoad(() => (hold ? get<{ event: { name: string }; tiers: { id: string; name: string }[] }>(`/events/${hold.event_id}`) : Promise.resolve(null)), [hold?.event_id]);
  const open = hold?.status === 'ACTIVE' || hold?.status === 'PAYING';
  const left = useCountdown(hold && open ? hold.seconds_left : null);
  const total = useRef(0);
  if (hold && open) total.current = Math.max(total.current, hold.seconds_left);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [gateway, setGateway] = useState<{ orderId: string; amount: number } | null>(null);
  const [settling, setSettling] = useState('');
  const [waiting, setWaiting] = useState('');
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);

  useEffect(() => {
    if (hold?.status === 'CONVERTED' && hold.order_id) nav('/tickets?new=' + hold.order_id, { replace: true });
  }, [hold?.status, hold?.order_id, nav]);

  const startPayment = async () => {
    setErr('');
    setBusy(true);
    try {
      const r = await post<{ order_id: string | null; payment: { provider_order_id: string; amount_paise: number } | null }>(`/holds/${holdId}/checkout`);
      if (r.order_id) return nav('/tickets?new=' + r.order_id, { replace: true });
      setGateway({ orderId: r.payment!.provider_order_id, amount: r.payment!.amount_paise });
    } catch (e) {
      setErr(friendly(e));
      void h.reload();
    } finally {
      setBusy(false);
    }
  };

  /** What the simulated bank's screen does: settle the payment, then wait for our own records to catch up. */
  const settle = async (outcome: 'success' | 'failure', extra: { delay_ms?: number; duplicate?: boolean } = {}) => {
    if (!gateway) return;
    setSettling('Contacting the bank');
    try {
      await post(`/sim-gateway/orders/${gateway.orderId}/pay`, { outcome, ...extra });
    } catch (e) {
      setErr(friendly(e));
    }
    setGateway(null);
    setSettling('');
    setWaiting(outcome === 'failure' ? 'The bank declined the payment.' : extra.delay_ms ? 'Paid. Waiting for the bank’s confirmation to reach us' : 'Confirming your payment');
    for (let i = 0; i < 60 && live.current; i++) {
      await sleep(extra.delay_ms ? 1000 : 500);
      try {
        const cur = (await get<{ hold: Hold }>(`/holds/${holdId}`)).hold;
        if (cur.order_id) return nav('/tickets?new=' + cur.order_id, { replace: true });
        if (outcome === 'failure' && cur.status === 'ACTIVE') break;
        if (cur.status === 'EXPIRED' || cur.status === 'RELEASED') break;
      } catch {
        // keep trying
      }
    }
    setWaiting('');
    void h.reload();
    if (outcome === 'failure') setErr('The payment was declined. Your seats are still held, so you can try again.');
  };

  const release = async () => {
    try {
      await del(`/holds/${holdId}`);
      nav(`/e/${hold?.event_id}`);
    } catch (e) {
      setErr(friendly(e));
    }
  };

  if (h.error instanceof ApiError && h.error.status === 404) {
    return <EmptyState title="That hold does not exist" action={<Link className="btn" to="/">Back to events</Link>}>It may belong to another account, or the link is old.</EmptyState>;
  }
  if (!hold) return <PageSkeleton />;

  const tierName = (id: string) => ev.data?.tiers.find((t) => t.id === id)?.name ?? 'Ticket';
  const paying = hold.status === 'PAYING' || !!waiting;

  return (
    <div className="checkout">
      <div>
        <ol className="steps" aria-label="Progress">
          <li className="steps__done"><Check size={14} weight="light" aria-hidden />Seats held</li>
          <li aria-current={open ? 'step' : undefined}>Pay</li>
          <li>Get your tickets</li>
        </ol>
        {open ? (
          <>
            <h1 className="sr-only">Pay for your tickets</h1>
            <div className={'timer' + (left < 60 ? ' timer--low' : '')} role="timer" aria-label={`${mmss(left)} left to pay`}>{mmss(left)}</div>
            <Meter fraction={total.current ? left / total.current : 1} linear />
            <p className="lede" style={{ marginTop: 24 }}>Your seats are yours until the timer ends. After that they go back on sale for the next person.</p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 'clamp(40px, 6vw, 64px)' }}>{hold.status === 'EXPIRED' ? 'Time ran out.' : 'This hold is closed.'}</h1>
            <p className="lede" style={{ margin: '16px 0 24px' }}>{hold.status === 'EXPIRED' ? 'The seats went back on sale. You can choose again if any are left.' : 'Those seats are no longer held for you.'}</p>
            <Link className="btn" to={`/e/${hold.event_id}`}>Choose again</Link>
          </>
        )}
      </div>

      <section className="card" aria-labelledby="summary-title">
        <h2 id="summary-title" style={{ fontSize: 24, fontWeight: 400 }}>{ev.data?.event.name ?? 'Your order'}</h2>
        <div style={{ marginTop: 12 }}>
          {hold.items.map((i) => (
            <div className="summary__row" key={i.tier_id}>
              <span>{i.quantity} × {tierName(i.tier_id)}</span>
              <span className="num">{money(i.quantity * i.unit_price_paise)}</span>
            </div>
          ))}
          {hold.seats.length > 0 && <p className="small muted" style={{ margin: '4px 0 0' }}>Seats {hold.seats.join(', ')}</p>}
          {hold.discount_paise > 0 && <div className="summary__row small"><span>Promo discount</span><span>−{money(hold.discount_paise)}</span></div>}
        </div>
        <div className="summary__total">
          <span className="mono">Total</span>
          <span className="num" style={{ fontSize: 36 }}>{money(hold.total_paise)}</span>
        </div>
        {err && <Notice>{err}</Notice>}
        {waiting && <Notice kind="info">{waiting}</Notice>}
        {open && (
          <div className="stack" style={{ marginTop: 24 }}>
            <button className="btn btn--lg btn--block" disabled={busy || paying || left === 0} aria-busy={busy} onClick={startPayment}>
              {busy ? 'Starting payment' : hold.total_paise === 0 ? 'Confirm free booking' : `Pay ${money(hold.total_paise)}`}
            </button>
            {hold.status === 'ACTIVE' && !waiting && <button className="btn btn--ghost btn--block" onClick={release}>Give the seats back</button>}
          </div>
        )}
      </section>

      <Modal open={!!gateway} onClose={() => !settling && setGateway(null)} title={`Pay ${money(gateway?.amount ?? 0)}`} dismissible={!settling}>
        <p className="muted small">This is a simulated bank. No real money moves. Pick what the pretend bank does to see how AtomicPass copes.</p>
        <div className="stack" aria-busy={!!settling}>
          <button className="choice" disabled={!!settling} onClick={() => settle('success')}><strong>Approve the payment</strong><span>The normal path.</span></button>
          <button className="choice" disabled={!!settling} onClick={() => settle('failure')}><strong>Decline the payment</strong><span>Your seats stay held, so you can try again.</span></button>
          <button className="choice" disabled={!!settling} onClick={() => settle('success', { delay_ms: 8000 })}><strong>Approve, but confirm 8 seconds late</strong><span>The bank’s message is slow. The order still arrives.</span></button>
          <button className="choice" disabled={!!settling} onClick={() => settle('success', { duplicate: true })}><strong>Approve, and send the message twice</strong><span>AtomicPass counts it once.</span></button>
        </div>
        {settling && <p className="small" role="status" style={{ margin: 0 }}>{settling}</p>}
        <button className="btn btn--ghost btn--block" disabled={!!settling} onClick={() => setGateway(null)}>Close</button>
      </Modal>
    </div>
  );
}
