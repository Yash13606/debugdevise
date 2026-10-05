let override: (() => number) | null = null;

/** Current time in epoch milliseconds. */
export const now = (): number => (override ? override() : Date.now());

/** Tests may replace the clock; pass null to restore the real one. */
export function setClock(fn: (() => number) | null): void {
  override = fn;
}
