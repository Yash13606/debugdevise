// Hooks and helpers shared by the screens.
import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

// ---- money and dates ----
/** A price: zero reads as "Free". */
export const rupees = (paise: number): string => (paise === 0 ? 'Free' : money(paise));
/** An amount of money, including zero. */
export const money = (paise: number): string => '₹' + (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 });

export const dateTime = (iso: string): string => new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
export const timeOnly = (iso: string): string => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', second: '2-digit' });

/** The pieces a poster shows: a big day number, the month, and the weekday and time. */
export function dateParts(iso: string) {
  const d = new Date(iso);
  return {
    day: String(d.getDate()).padStart(2, '0'),
    month: d.toLocaleString('en-IN', { month: 'long' }),
    weekday: d.toLocaleString('en-IN', { weekday: 'short' }),
    time: d.toLocaleString('en-IN', { hour: 'numeric', minute: '2-digit' }).toLowerCase(),
  };
}

/** Posters are flat colour (DESIGN.md allows no gradients): the first of an event's two banner colours, with text that stays readable on it. */
export function posterVars(banner: string): React.CSSProperties {
  const bg = (banner.split(',')[0] ?? '#111111').trim();
  const n = parseInt(bg.slice(1), 16);
  const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return { ['--poster-bg' as string]: bg, ['--poster-fg' as string]: lum > 0.35 ? '#111111' : '#ffffff' };
}

// ---- data loading ----
/** Load something, then reload it on demand or every `everyMs` (paused while the tab is hidden). */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], everyMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    void reload();
    if (!everyMs) return;
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, everyMs);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, reload, setData };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Seconds left, ticking. Restarts whenever `totalSeconds` changes. */
export function useCountdown(totalSeconds: number | null) {
  const [left, setLeft] = useState(totalSeconds ?? 0);
  const endRef = useRef(0);
  useEffect(() => {
    if (totalSeconds === null) return;
    endRef.current = Date.now() + totalSeconds * 1000;
    setLeft(totalSeconds);
    const t = setInterval(() => setLeft(Math.max(0, Math.ceil((endRef.current - Date.now()) / 1000))), 500);
    return () => clearInterval(t);
  }, [totalSeconds]);
  return left;
}
export const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

// ---- page behaviour ----
/** Name the page for the tab and for screen readers. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} | AtomicPass` : 'AtomicPass';
  }, [title]);
}

/** On a route change, put focus on the page itself so keyboard and screen-reader users start at the top. */
export function useRouteFocus(ref: React.RefObject<HTMLElement | null>) {
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    ref.current?.focus({ preventScroll: true });
  }, [pathname, ref]);
}

/** True the first time it is asked for in this browser session, false afterwards (for one-off intro motion). */
export function useOncePerSession(key: string): boolean {
  const [first] = useState(() => {
    try {
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, '1');
      return true;
    } catch {
      return false;
    }
  });
  return first;
}

export const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A short tick on a phone, where it has a vibration motor. */
export const buzz = (pattern: number | number[]) => {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // not supported
  }
};

// ---- the ticket QR ----
export function QrImage({ text, size = 176 }: { text: string; size?: number }) {
  const [src, setSrc] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { width: size * 2, margin: 1, errorCorrectionLevel: 'M' }).then((u) => live && setSrc(u), () => {});
    return () => {
      live = false;
    };
  }, [text, size]);
  return src ? <img className="stub__qr" src={src} width={size} height={size} alt="Ticket QR code. Show it at the gate." /> : <div className="skeleton" style={{ width: size, height: size }} aria-hidden />;
}

// ---- the waiting-room challenge ----
/** Leading zero bits of a digest (the waiting-room challenge asks for a few). */
export const leadingZeroBits = (d: Uint8Array): number => {
  let bits = 0;
  for (const byte of d) {
    if (byte === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(byte) - 24;
  }
  return bits;
};

// A small pure-JS SHA-256, used only where the browser has no crypto.subtle (plain http on a LAN address).
function sha256Js(msg: Uint8Array): Uint8Array {
  const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const len = msg.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(msg);
  padded[len] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, len * 8, false);
  const w = new Uint32Array(64);
  const rr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < padded.length; o += 64) {
    const dv = new DataView(padded.buffer, o, 64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rr(w[i - 15]!, 7) ^ rr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rr(w[i - 2]!, 17) ^ rr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rr(e!, 6) ^ rr(e!, 11) ^ rr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rr(a!, 2) ^ rr(a!, 13) ^ rr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      hh = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i]! + v!) >>> 0));
  }
  const out = new Uint8Array(32);
  h.forEach((v, i) => new DataView(out.buffer).setUint32(i * 4, v, false));
  return out;
}

/** Find a nonce so that sha256(challenge:nonce) has `bits` leading zero bits. Yields to the page now and then. */
export async function solveChallenge(challenge: string, bits: number): Promise<string> {
  const enc = new TextEncoder();
  const digest = async (s: string) => (crypto.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))) : sha256Js(enc.encode(s)));
  for (let n = 0; ; n++) {
    if (leadingZeroBits(await digest(`${challenge}:${n}`)) >= bits) return String(n);
    if (n % 1000 === 999) await sleep(0);
  }
}
