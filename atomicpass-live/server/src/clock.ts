let override: (() => number) | null = null;

/** Current time in epoch milliseconds. */
export const now = (): number => (override ? override() : Date.now());

/** Epoch milliseconds as the ISO-8601 UTC string the API returns. */
export const iso = (ms: number): string => new Date(ms).toISOString();

/** Tests may replace the clock; pass null to restore the real one. */
export function setClock(fn: (() => number) | null): void {
  override = fn;
}
