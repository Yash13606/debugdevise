// A thin client for the AtomicPass Live API. Errors keep the server's stable code so screens can react to it.
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public details?: any,
  ) {
    super(message);
  }
}

const KEY = 'ap_token';
export const getToken = (): string | null => {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
};
export const setToken = (t: string | null) => {
  try {
    if (t) localStorage.setItem(KEY, t);
    else localStorage.removeItem(KEY);
  } catch {
    // storage blocked: the session lasts until the page closes
  }
};

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch('/api' + path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = json?.error ?? { code: 'HTTP_' + res.status, message: res.statusText };
    throw new ApiError(e.code, e.message, res.status, e.details);
  }
  return json as T;
}

export const get = <T = any>(path: string) => api<T>('GET', path);
export const post = <T = any>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const del = <T = any>(path: string) => api<T>('DELETE', path);
export const patch = <T = any>(path: string, body: unknown) => api<T>('PATCH', path, body);

/** What a person should read for each refusal the server can give. */
export function friendly(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong. Check your connection and try again.';
  const d = e.details ?? {};
  switch (e.code) {
    case 'SOLD_OUT':
      return 'Sold out. Not enough tickets left for that. You can join the waitlist.';
    case 'SEAT_TAKEN':
      return `Someone just took ${d.seats?.join(', ') ?? 'one of those seats'}. Pick again.`;
    case 'BUYER_LIMIT':
      return `Limit reached: you can hold or own ${d.limit} tickets for this event (you have ${d.used}).`;
    case 'MAX_PER_ORDER':
      return `You can book at most ${d.max_per_order} of that type at once.`;
    case 'NOT_ADMITTED':
      return d.reason === 'WAITING' ? 'Still waiting in the line. Hold on.' : d.reason === 'EXPIRED' || d.reason === 'USED' ? 'Your turn has passed. Join the waiting room again.' : 'Join the waiting room first.';
    case 'POW_REQUIRED':
      return 'Please try joining again.';
    case 'PROMO_INVALID':
      return { NOT_FOUND: 'That promo code does not exist.', EXHAUSTED: 'That promo code has been used up.', EXPIRED: 'That promo code has expired.', NOT_STARTED: 'That promo code is not active yet.', NOT_APPLICABLE: 'That promo code does not apply to these tickets.' }[d.reason as string] ?? 'That promo code cannot be used.';
    case 'HOLD_EXPIRED':
      return 'Time ran out and the seats went back on sale.';
    case 'EVENT_NOT_ON_SALE':
      return 'This event is not on sale.';
    case 'SALE_NOT_OPEN':
      return 'Sales for that ticket type are not open right now.';
    case 'RATE_LIMITED':
      return `Too many tries. Wait ${d.retry_after_seconds ?? 'a few'} seconds.`;
    case 'OTP_INVALID':
    case 'OTP_LOCKED':
      return e.message;
    case 'CANCEL_WINDOW_CLOSED':
      return e.message;
    case 'UNAUTHORIZED':
      return 'Please sign in first.';
    default:
      return e.message || 'Something went wrong.';
  }
}
