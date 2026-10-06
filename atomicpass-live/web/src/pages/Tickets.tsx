import { Ticket } from '@phosphor-icons/react';
import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { friendly, get, post } from '../api';
import { useAuth } from '../auth';
import { dateTime, money, QrImage, rupees, useLoad, usePageTitle } from '../lib';
import { ConfirmAction, EmptyState, Notice, PageSkeleton, Tag } from '../ui';

interface TicketRow { id: string; tier_name: string; seat: string | null; status: 'VALID' | 'CHECKED_IN' | 'VOID'; qr_payload: string }
interface Order {
  id: string; status: string; total_paise: number; refunded_paise: number; paid_at: string; can_cancel: boolean;
  event: { id: string; name: string; starts_at: string; venue: string; city: string; banner: string };
  tickets: TicketRow[];
}

const STATUS = { VALID: ['Valid', 'ok'], CHECKED_IN: ['Used', undefined], VOID: ['Refunded', 'bad'] } as const;

export default function Tickets() {
  const { user, ready } = useAuth();
  usePageTitle('My tickets');
  const fresh = useSearchParams()[0].get('new');
  const orders = useLoad(() => get<{ orders: Order[] }>('/orders'), [user?.id], 6000);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  if (ready && !user) return <Navigate to="/login" state={{ from: '/tickets' }} replace />;
  if (!orders.data) return <PageSkeleton />;

  const cancel = async (o: Order) => {
    setBusy(o.id);
    setErr('');
    try {
      await post(`/orders/${o.id}/cancel`);
      await orders.reload();
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <h1>Your tickets.</h1>
      {err && <Notice>{err}</Notice>}
      {orders.data.orders.length === 0 ? (
        <div className="sect--tight" style={{ marginTop: 32 }}>
          <EmptyState icon={<Ticket size={32} weight="light" aria-hidden />} title="No tickets yet" action={<Link className="btn" to="/">Find an event</Link>}>
            When you book, your tickets appear here with their QR codes, ready for the gate.
          </EmptyState>
        </div>
      ) : (
        <div style={{ marginTop: 40 }}>
          {orders.data.orders.map((o) => {
            const isNew = fresh === o.id;
            return (
              <section className="order" key={o.id} aria-labelledby={`o-${o.id}`}>
                {isNew && <Notice kind="ok">Booked. Show these codes at the gate. A confirmation is also in your messages.</Notice>}
                <div className="order__head">
                  <div>
                    <h2 id={`o-${o.id}`}><Link to={`/e/${o.event.id}`} style={{ textDecoration: 'none' }}>{o.event.name}</Link></h2>
                    <p className="mono" style={{ margin: '8px 0 0' }}>{dateTime(o.event.starts_at)}, {o.event.venue || o.event.city}</p>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <Tag tone={o.status === 'PAID' ? 'ok' : o.status === 'REFUNDED' ? 'bad' : 'warn'}>{o.status === 'PAID' ? 'Paid' : o.status === 'REFUNDED' ? 'Refunded' : 'Partly refunded'}</Tag>
                    <p className="small graphite" style={{ margin: '8px 0 0' }}>{rupees(o.total_paise)}{o.refunded_paise ? `, ${money(o.refunded_paise)} refunded` : ''}</p>
                  </div>
                </div>
                {o.tickets.map((t) => {
                  const [label, tone] = STATUS[t.status];
                  return (
                    <article className={`stub${isNew ? ' stub--fresh' : ''}${t.status === 'CHECKED_IN' ? ' stub--used' : ''}${t.status === 'VOID' ? ' stub--void' : ''}`} key={t.id} aria-label={`${t.tier_name}${t.seat ? `, seat ${t.seat}` : ''}, ${label.toLowerCase()}`}>
                      <div className="stub__main">
                        <div>
                          <Tag tone={tone}>{label}</Tag>
                          <h3 className="stub__type" style={{ marginTop: 14 }}>{t.tier_name}</h3>
                        </div>
                        <div>
                          {t.seat && <div className="stub__seat" aria-hidden>{t.seat}</div>}
                          <p className="mono" style={{ margin: t.seat ? '10px 0 0' : 0 }}>Ticket {t.id.slice(-6)}</p>
                        </div>
                      </div>
                      <div className="stub__tear" aria-hidden />
                      <div className="stub__side">
                        {t.status === 'VALID' ? (
                          <>
                            <QrImage text={t.qr_payload} size={176} />
                            <span className="small muted">Show this at the gate</span>
                          </>
                        ) : (
                          <div className="stub__gone">{t.status === 'CHECKED_IN' ? 'Already used to enter' : 'Refunded. No longer valid.'}</div>
                        )}
                      </div>
                    </article>
                  );
                })}
                {o.can_cancel && (
                  <ConfirmAction label="Cancel order and refund" question={`Cancel this order and refund ${money(o.total_paise)}? The seats go back on sale.`} confirmLabel="Cancel and refund" keepLabel="Keep my tickets" busy={busy === o.id} onConfirm={() => cancel(o)} />
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}
