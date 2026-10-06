import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { friendly, post } from '../api';
import { useAuth } from '../auth';
import { usePageTitle } from '../lib';
import { Notice } from '../ui';

export default function Login() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  usePageTitle('Sign in');
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [name, setName] = useState('');
  const [demo, setDemo] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [wait, setWait] = useState(0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  useEffect(() => {
    if (sent) codeRef.current?.focus();
  }, [sent]);

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await post('/auth/otp', { phone });
      setSent(true);
      setOtp('');
      setDemo(r.demo_otp ?? null);
      setWait(30);
    } catch (x) {
      setErr(friendly(x));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (code = otp) => {
    if (code.length !== 6 || busy) return;
    setBusy(true);
    setErr('');
    try {
      const r = await post('/auth/verify', { phone, otp: code, name: name || undefined });
      signIn(r.token, r.user);
      nav(from === '/login' ? '/' : from, { replace: true });
    } catch (x) {
      setErr(friendly(x));
      setOtp('');
      codeRef.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split" style={{ marginTop: 16 }}>
      <div>
        <h1>Your number is your account.</h1>
        <p className="lede" style={{ marginTop: 24 }}>We text you a one-time code. There is no password to forget, and your tickets stay tied to your phone.</p>
      </div>

      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          if (sent) void verify();
          else void send(e);
        }}
        noValidate
      >
        <div className="field">
          <label className="field__label" htmlFor="phone">Mobile number</label>
          <input id="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="98765 43210" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={sent} aria-describedby="phone-hint" required />
          <p className="field__hint" id="phone-hint">Indian mobile numbers only.</p>
        </div>

        {sent && (
          <>
            {demo && (
              <Notice kind="info">
                <span>Demo mode: no SMS is sent. Your code is <b className="mono" style={{ letterSpacing: 2, color: 'inherit' }}>{demo}</b>.</span>{' '}
                <button type="button" className="linkbtn" onClick={() => { setOtp(demo); void verify(demo); }}>Use this code</button>
              </Notice>
            )}
            <div className="field">
              <label className="field__label" htmlFor="otp">6-digit code</label>
              <input
                id="otp" ref={codeRef} className="input input--code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={otp}
                aria-invalid={!!err} aria-describedby={err ? 'otp-error' : undefined}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                  setOtp(v);
                  if (v.length === 6) void verify(v);
                }}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="name">Your name</label>
              <input id="name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} aria-describedby="name-hint" />
              <p className="field__hint" id="name-hint">Optional, and only used the first time.</p>
            </div>
          </>
        )}

        {err && <p className="field__error" id="otp-error" role="alert" style={{ marginTop: 12 }}>{err}</p>}

        <div className="stack" style={{ marginTop: 24 }}>
          <button className="btn btn--lg btn--block" disabled={busy || (sent ? otp.length !== 6 : phone.trim().length < 10)} aria-busy={busy}>
            {busy ? 'Please wait' : sent ? 'Verify and continue' : 'Send code'}
          </button>
          {sent && (
            <div className="row between">
              <button type="button" className="linkbtn" onClick={() => { setSent(false); setOtp(''); setErr(''); setDemo(null); }}>Change number</button>
              <button type="button" className="linkbtn" disabled={wait > 0 || busy} onClick={() => void send()}>{wait > 0 ? `Send a new code in ${wait}s` : 'Send a new code'}</button>
            </div>
          )}
        </div>
        <p className="small muted" style={{ margin: '20px 0 0' }}>Trying the organiser side? The demo organiser is 9000000001.</p>
      </form>
    </div>
  );
}
