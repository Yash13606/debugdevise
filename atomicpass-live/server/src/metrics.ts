// Tiny Prometheus-format metrics: counters with labels and one request-duration histogram. No dependency.
const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];

export class Metrics {
  private counters = new Map<string, number>();
  private hist = { buckets: BUCKETS.map(() => 0), count: 0, sum: 0 };

  inc(name: string, labels: Record<string, string | number> = {}, by = 1): void {
    const l = Object.entries(labels)
      .map(([k, v]) => `${k}="${String(v).replace(/["\\\n]/g, '')}"`)
      .join(',');
    const key = l ? `${name}{${l}}` : name;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observeRequest(ms: number): void {
    this.hist.count++;
    this.hist.sum += ms;
    BUCKETS.forEach((b, i) => {
      if (ms <= b) this.hist.buckets[i]!++;
    });
  }

  get(name: string, labels: Record<string, string | number> = {}): number {
    const l = Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(',');
    return this.counters.get(l ? `${name}{${l}}` : name) ?? 0;
  }

  render(): string {
    const lines = [...this.counters].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k} ${v}`);
    BUCKETS.forEach((b, i) => lines.push(`http_request_duration_ms_bucket{le="${b}"} ${this.hist.buckets[i]}`));
    lines.push(`http_request_duration_ms_bucket{le="+Inf"} ${this.hist.count}`);
    lines.push(`http_request_duration_ms_sum ${this.hist.sum}`, `http_request_duration_ms_count ${this.hist.count}`);
    return lines.join('\n') + '\n';
  }
}
