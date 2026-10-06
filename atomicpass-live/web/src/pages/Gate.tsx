import { ArrowsClockwise, Camera, CheckCircle, WarningCircle, WifiHigh, WifiSlash, XCircle } from '@phosphor-icons/react';
import jsQR from 'jsqr';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ApiError, friendly, get, post } from '../api';
import { useAuth } from '../auth';
import { buzz, dateTime, timeOnly, useLoad, usePageTitle } from '../lib';
import { EmptyState, Notice, PageSkeleton, Tag } from '../ui';

// The verdict panel is used hundreds of times in an evening, so it has no animation at all: it simply changes.
type Verdict = { tone: 'go' | 'stop' | 'warn'; title: string; detail: string };
interface Summary { admitted: number; waiting: number; refunded: number; recent: { at: string; result: string; gate: string | null; seat: string | null }[] }
interface Pending { qr: string; at: number; gate: string }

const store = {
  read<T>(k: string, d: T): T {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null') ?? d;
    } catch {
      return d;
    }
  },
  write(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      // storage blocked: offline scans last until the page closes
    }
  },
};

const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

/** Check a signed ticket with only the public key: no network. Null when it is forged or not a signed ticket. */
async function verifyOffline(key: CryptoKey, qr: string): Promise<{ t: string; e: string; n: string; s: string | null } | null> {
  if (!qr.startsWith('AP2:')) return null;
  const rest = qr.slice(4);
  const dot = rest.indexOf('.');
  if (dot < 1) return null;
  try {
    const ok = await crypto.subtle.verify('Ed25519', key, b64u(rest.slice(dot + 1)) as BufferSource, new TextEncoder().encode(rest.slice(0, dot)));
    return ok ? JSON.parse(new TextDecoder().decode(b64u(rest.slice(0, dot)))) : null;
  } catch {
    return null;
  }
}

const REASONS: Record<string, [Verdict['tone'], string, string]> = {
  ALREADY_CHECKED_IN: ['stop', 'ALREADY USED', 'This ticket was scanned before.'],
  TICKET_VOID: ['stop', 'REFUNDED', 'This ticket was refunded. Do not admit.'],
  INVALID_QR: ['stop', 'NOT VALID', 'This is not a genuine ticket.'],
  WRONG_EVENT: ['warn', 'WRONG EVENT', 'A real ticket, but for another event.'],
  FORBIDDEN: ['stop', 'NOT ON THE TEAM', 'You are not on this event’s gate team.'],
};

export default function Gate() {
  const { user, ready } = useAuth();
  usePageTitle('Gate scanner');
  const events = useLoad(() => get<{ events: { id: string; name: string; starts_at: string; venue: string; city: string }[] }>('/gate/events'), [user?.id]);
  const [eventId, setEventId] = useState(() => store.read<string>('ap_gate_event', ''));
  if (ready && !user) return <Navigate to="/login" state={{ from: '/gate' }} replace />;
  if (!events.data) return <PageSkeleton />;
  const ev = events.data.events.find((e) => e.id === eventId);

  if (!ev) {
    return (
      <>
        <h1>Which event are you scanning?</h1>
        {events.data.events.length === 0 ? (
          <div style={{ marginTop: 32 }}>
            <EmptyState title="You are not on a gate team yet" action={<Link className="btn" to="/organiser">Create an event</Link>}>Ask the organiser to add your phone number, or create your own event.</EmptyState>
          </div>
        ) : (
          <ul className="stack" style={{ marginTop: 32, padding: 0, listStyle: 'none' }}>
            {events.data.events.map((e) => (
              <li key={e.id}>
                <button className="card" style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }} onClick={() => { store.write('ap_gate_event', e.id); setEventId(e.id); }}>
                  <h2 style={{ fontSize: 24, fontWeight: 400 }}>{e.name}</h2>
                  <span className="mono">{dateTime(e.starts_at)}, {e.venue || e.city}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </>
    );
  }
  return <Scanner key={ev.id} event={ev} onChange={() => { store.write('ap_gate_event', ''); setEventId(''); }} />;
}

function Scanner({ event, onChange }: { event: { id: string; name: string }; onChange: () => void }) {
  const { user } = useAuth();
  const keyName = `ap_gatekey_${event.id}`, pendName = `ap_pending_${event.id}`, seenName = `ap_seen_${event.id}`;
  const gate = useRef(store.read('ap_gate_name', '') || `${(user?.name || 'Gate').split(' ')[0]}-${Math.random().toString(36).slice(2, 5)}`).current;
  useEffect(() => store.write('ap_gate_name', gate), [gate]);

  const [offlineMode, setOfflineMode] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [pending, setPending] = useState<Pending[]>(() => store.read(pendName, []));
  const [syncMsg, setSyncMsg] = useState('');
  const [manual, setManual] = useState('');
  const [camera, setCamera] = useState(false);
  const [camErr, setCamErr] = useState('');
  const [keyReady, setKeyReady] = useState(!!store.read<string | null>(keyName, null));
  const summary = useLoad(() => (online && !offlineMode ? get<Summary>(`/gate/events/${event.id}/summary`) : Promise.resolve(null)), [event.id, online, offlineMode], 4000);
  const lastSummary = useRef<Summary | null>(null);
  if (summary.data) lastSummary.current = summary.data;

  const video = useRef<HTMLVideoElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const lastCode = useRef({ code: '', at: 0 });
  const cryptoKey = useRef<CryptoKey | null>(null);
  const offlineActive = offlineMode || !online;

  // Fetch (and remember) the public key while there is a network, so offline scanning works later.
  useEffect(() => {
    if (!online) return;
    get<{ public_key: string }>(`/gate/events/${event.id}/verify-key`).then((r) => { store.write(keyName, r.public_key); setKeyReady(true); }, () => {});
  }, [event.id, online, keyName]);
  const loadKey = useCallback(async () => {
    if (cryptoKey.current) return cryptoKey.current;
    const raw = store.read<string | null>(keyName, null);
    if (!raw) return null;
    try {
      cryptoKey.current = await crypto.subtle.importKey('raw', b64u(raw) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    } catch {
      cryptoKey.current = null; // this browser cannot check Ed25519 offline
    }
    return cryptoKey.current;
  }, [keyName]);

  useEffect(() => {
    const up = () => setOnline(true), down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  const show = (v: Verdict) => { setVerdict(v); buzz(v.tone === 'go' ? 60 : [120, 60, 120]); };

  const checkOffline = async (qr: string) => {
    const key = await loadKey();
    if (!key) return show({ tone: 'warn', title: 'CANNOT CHECK OFFLINE', detail: 'This device has no key yet. Open the scanner once with a network, then go offline.' });
    const facts = await verifyOffline(key, qr);
    if (!facts) return show({ tone: 'stop', title: 'NOT VALID', detail: 'The signature does not match. Forged or damaged.' });
    if (facts.e !== event.id) return show({ tone: 'warn', title: 'WRONG EVENT', detail: 'A real ticket, but for another event.' });
    const seen = store.read<string[]>(seenName, []);
    if (seen.includes(facts.t)) return show({ tone: 'stop', title: 'ALREADY SCANNED HERE', detail: 'This device admitted this ticket a moment ago.' });
    store.write(seenName, [...seen, facts.t]);
    const next = [...pending, { qr, at: Date.now(), gate }];
    store.write(pendName, next);
    setPending(next);
    show({ tone: 'go', title: 'ADMIT (OFFLINE)', detail: `${facts.n}${facts.s ? `, seat ${facts.s}` : ''}. Genuine. Not yet checked against other gates.` });
  };

  const check = useCallback(async (raw: string) => {
    const qr = raw.trim();
    if (!qr) return;
    if (offlineActive) return checkOffline(qr);
    try {
      const r = await post<{ result: string; ticket: { tier_name: string; seat: string | null } }>('/gate/checkin', { qr, event_id: event.id, gate });
      show({ tone: 'go', title: 'ADMIT', detail: `${r.ticket.tier_name}${r.ticket.seat ? `, seat ${r.ticket.seat}` : ''}` });
      void summary.reload();
    } catch (e) {
      if (e instanceof ApiError) {
        const [tone, title, detail] = REASONS[e.code] ?? ['stop', 'REFUSED', friendly(e)];
        const when = e.code === 'ALREADY_CHECKED_IN' && e.details?.checked_in_at ? ` First scanned at ${timeOnly(e.details.checked_in_at)}${e.details.gate ? ` at gate ${e.details.gate}` : ''}.` : '';
        show({ tone, title, detail: detail + when });
        void summary.reload();
      } else {
        await checkOffline(qr); // the network failed mid-scan: fall back to the signed check
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [offlineActive, event.id, gate, pending]);

  const sync = useCallback(async () => {
    if (!pending.length || !navigator.onLine) return;
    try {
      const r = await post<{ results: { code: string }[]; admitted: number; refused: number }>('/gate/checkin/batch', { event_id: event.id, scans: pending });
      const dup = r.results.filter((x) => x.code === 'ALREADY_CHECKED_IN').length;
      setSyncMsg(`Synced ${pending.length} offline scan(s): ${r.admitted} confirmed${dup ? `, ${dup} had already been admitted at another gate (double entry found)` : ''}${r.refused - dup ? `, ${r.refused - dup} refused` : ''}.`);
      store.write(pendName, []);
      store.write(seenName, []);
      setPending([]);
      void summary.reload();
    } catch (e) {
      setSyncMsg('Could not sync yet: ' + friendly(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, event.id]);
  useEffect(() => { if (online && !offlineMode && pending.length) void sync(); }, [online, offlineMode, pending.length, sync]);

  // The camera: BarcodeDetector where the browser has it, jsQR everywhere else.
  useEffect(() => {
    if (!camera) return;
    let stop = false;
    let stream: MediaStream | null = null;
    const canvas = document.createElement('canvas');
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        if (stop || !video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const Detector = (window as any).BarcodeDetector;
        const det = Detector ? new Detector({ formats: ['qr_code'] }) : null;
        const tick = async () => {
          if (stop) return;
          const v = video.current!;
          if (v.readyState >= 2 && v.videoWidth) {
            let code = '';
            try {
              if (det) code = (await det.detect(v))[0]?.rawValue ?? '';
              else {
                canvas.width = v.videoWidth; canvas.height = v.videoHeight;
                const c = canvas.getContext('2d', { willReadFrequently: true })!;
                c.drawImage(v, 0, 0);
                code = jsQR(c.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height)?.data ?? '';
              }
            } catch { /* a bad frame: try the next one */ }
            const now = Date.now();
            if (code && (code !== lastCode.current.code || now - lastCode.current.at > 3000)) {
              lastCode.current = { code, at: now };
              void check(code);
            }
          }
          setTimeout(tick, 180);
        };
        void tick();
      } catch {
        setCamErr(window.isSecureContext ? 'The camera could not be opened. Allow camera access in your browser, or type the code below.' : 'Browsers only allow the camera on https or localhost. Open this page over https, or type the code below.');
        setCamera(false);
      }
    })();
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [camera, check]);

  const sum = lastSummary.current;
  const VerdictIcon = verdict?.tone === 'go' ? CheckCircle : verdict?.tone === 'warn' ? WarningCircle : XCircle;
  return (
    <>
      <div className="row between" style={{ alignItems: 'flex-start' }}>
        <div>
          <p className="mono" style={{ margin: '0 0 8px' }}>This device is {gate}</p>
          <h1 style={{ fontSize: 'clamp(32px, 5vw, 56px)' }}>{event.name}</h1>
        </div>
        <button className="btn btn--ghost" onClick={onChange}>Change event</button>
      </div>

      <div className="row" style={{ margin: '20px 0 24px', gap: 16 }}>
        <Tag tone={offlineActive ? 'bad' : 'ok'}>{offlineActive ? <WifiSlash size={14} weight="light" aria-hidden /> : <WifiHigh size={14} weight="light" aria-hidden />}{offlineActive ? (online ? 'Offline mode' : 'No network') : 'Online'}</Tag>
        <label className="check" style={{ minHeight: 44 }}><input type="checkbox" checked={offlineMode} onChange={(e) => setOfflineMode(e.target.checked)} />Work offline</label>
        <span className="small muted">{keyReady ? 'Offline checking is ready on this device.' : online ? 'Getting the offline key.' : 'No offline key on this device yet.'}</span>
      </div>

      <div className="gate">
        <div className="stack">
          <div className={'verdict verdict--' + (verdict?.tone ?? 'idle')} role="status" aria-live="assertive">
            {verdict ? (
              <>
                <VerdictIcon size={64} weight="light" aria-hidden />
                <div>
                  <div className="verdict__title">{verdict.title}</div>
                  <p className="verdict__detail">{verdict.detail}</p>
                </div>
              </>
            ) : (
              <p style={{ margin: 0, gridColumn: '1 / -1' }}>Scan a ticket. The result appears here.</p>
            )}
          </div>

          {camera ? (
            <>
              <div className="scan"><video ref={video} muted playsInline aria-label="Camera view" /><div className="scan__frame" aria-hidden /></div>
              <button className="btn btn--outline btn--block" onClick={() => setCamera(false)}>Stop the camera</button>
            </>
          ) : (
            <button className="btn btn--lg btn--block" onClick={() => { setCamErr(''); setCamera(true); }}><Camera size={22} weight="light" aria-hidden />Start the camera</button>
          )}
          {camErr && <Notice kind="info">{camErr}</Notice>}

          <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void check(manual); setManual(''); input.current?.focus(); }}>
            <div className="grow">
              <label className="field__label" htmlFor="code">Ticket code, typed or from a hardware scanner</label>
              <input id="code" ref={input} className="input" style={{ fontFamily: 'var(--mono)' }} autoComplete="off" spellCheck={false} value={manual} onChange={(e) => setManual(e.target.value)} />
            </div>
            <button className="btn btn--outline">Check</button>
          </form>
        </div>

        <div className="stack">
          <div className="grid g2">
            <div className="kpi"><span className="mono">Admitted</span><span className="kpi__value">{sum?.admitted ?? '–'}</span></div>
            <div className="kpi"><span className="mono">Still to come</span><span className="kpi__value">{sum?.waiting ?? '–'}</span></div>
          </div>
          {(pending.length > 0 || syncMsg) && (
            <section className="card" aria-labelledby="off-title">
              <h2 id="off-title" style={{ fontSize: 20, fontWeight: 400 }}>Offline scans</h2>
              {pending.length > 0 && <p style={{ margin: '8px 0 0' }}><strong>{pending.length}</strong> waiting to be checked against the other gates.</p>}
              {syncMsg && <Notice kind="info">{syncMsg}</Notice>}
              <button className="btn btn--outline btn--sm" disabled={!online || !pending.length} onClick={sync}><ArrowsClockwise size={16} weight="light" aria-hidden />Sync now</button>
            </section>
          )}
          <section className="card" aria-labelledby="recent-title">
            <h2 id="recent-title" style={{ fontSize: 20, fontWeight: 400 }}>Recent scans</h2>
            {!sum || sum.recent.length === 0 ? <p className="small muted" style={{ margin: '8px 0 0' }}>None yet.</p> : (
              <ul className="recent">
                {sum.recent.map((r, i) => (
                  <li key={i}>
                    <span><Tag tone={r.result === 'ADMITTED' ? 'ok' : 'bad'}>{r.result.replace(/_/g, ' ').toLowerCase()}</Tag> {r.seat ?? ''}</span>
                    <span className="mono">{timeOnly(r.at)}{r.gate ? `, ${r.gate}` : ''}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
