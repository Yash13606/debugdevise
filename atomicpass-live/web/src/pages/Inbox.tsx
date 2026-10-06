import { Bell, ChatText, Clock, Key, Ticket } from '@phosphor-icons/react';
import { Navigate } from 'react-router-dom';
import { get } from '../api';
import { useAuth } from '../auth';
import { useLoad, usePageTitle } from '../lib';
import { EmptyState, PageSkeleton } from '../ui';

const KIND: Record<string, { label: string; Icon: typeof Key }> = {
  OTP: { label: 'Login code', Icon: Key },
  TICKETS: { label: 'Booking confirmed', Icon: Ticket },
  HOLD_REMINDER: { label: 'Your hold is ending', Icon: Clock },
  WAITLIST: { label: 'A seat freed up', Icon: Bell },
};

export default function Inbox() {
  const { user, ready } = useAuth();
  usePageTitle('Messages');
  const m = useLoad(() => get<{ messages: { id: number; kind: string; body: string; created_at: number }[] }>('/me/messages'), [user?.id], 5000);
  if (ready && !user) return <Navigate to="/login" state={{ from: '/inbox' }} replace />;
  if (!m.data) return <PageSkeleton />;
  return (
    <>
      <h1>What we sent you.</h1>
      <p className="lede" style={{ marginTop: 20 }}>This demo sends no real texts. Everything we would have messaged you appears here.</p>
      <div className="sect--tight" style={{ marginTop: 40 }}>
        {m.data.messages.length === 0 ? (
          <EmptyState icon={<ChatText size={32} weight="light" aria-hidden />} title="No messages yet">Login codes, booking confirmations and hold reminders will appear here.</EmptyState>
        ) : (
          <ul className="msgs">
            {m.data.messages.map((x) => {
              const k = KIND[x.kind] ?? { label: x.kind, Icon: ChatText };
              return (
                <li className="msg" key={x.id}>
                  <k.Icon size={24} weight="light" aria-hidden />
                  <div>
                    <p className="msg__kind">{k.label}</p>
                    <p className="msg__body">{x.body}</p>
                  </div>
                  <time dateTime={new Date(x.created_at).toISOString()}>{new Date(x.created_at).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })}</time>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
