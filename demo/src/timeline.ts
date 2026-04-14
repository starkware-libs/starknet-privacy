export type Span = {
  label: string;
  startMs: number;
  endMs: number | null;
  children: Span[];
  /** True for auto-generated Resource Timing phase spans. */
  phase?: boolean;
};

export class Timeline {
  readonly spans: Span[] = [];
  private stack: Span[] = [];
  private enriched = false;

  begin(label: string): void {
    const span: Span = { label, startMs: performance.now(), endMs: null, children: [] };
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      parent.children.push(span);
    } else {
      this.spans.push(span);
    }
    this.stack.push(span);
  }

  end(): void {
    const span = this.stack.pop();
    if (span) span.endMs = performance.now();
  }

  async step<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.begin(label);
    try {
      return await fn();
    } finally {
      this.end();
    }
  }

  /** Total duration from first span start to last span end. */
  get totalMs(): number {
    if (this.spans.length === 0) return 0;
    const start = this.spans[0].startMs;
    const end = this.spans[this.spans.length - 1].endMs ?? performance.now();
    return end - start;
  }

  /** Attach Resource Timing phase breakdowns to leaf spans. Idempotent. */
  enrich(): void {
    if (this.enriched) return;
    this.enriched = true;
    if (typeof performance.getEntriesByType !== "function") return;
    const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
    enrichSpans(this.spans, entries);
    performance.clearResourceTimings();
  }
}

export function spanDuration(span: Span): number {
  return (span.endMs ?? performance.now()) - span.startMs;
}

function enrichSpans(spans: Span[], entries: PerformanceResourceTiming[]): void {
  for (const span of spans) {
    if (span.children.length === 0 && span.endMs !== null) {
      enrichLeafSpan(span, entries);
    } else {
      enrichSpans(span.children, entries);
    }
  }
}

function enrichLeafSpan(span: Span, entries: PerformanceResourceTiming[]): void {
  const matching = entries.filter(
    (entry) =>
      entry.startTime >= span.startMs &&
      entry.startTime <= span.endMs! &&
      entry.initiatorType === "fetch",
  );

  if (matching.length === 0) return;

  const usePrefix = matching.length > 1;

  for (const entry of matching) {
    const prefix = usePrefix ? `${shortenUrl(entry.name)}: ` : "";

    if (entry.requestStart === 0) {
      span.children.push({
        label: `${prefix}Request`,
        startMs: entry.startTime,
        endMs: entry.responseEnd,
        children: [],
        phase: true,
      });
      continue;
    }

    span.children.push({
      label: `${prefix}Stalled`,
      startMs: entry.startTime,
      endMs: entry.requestStart,
      children: [],
      phase: true,
    });

    span.children.push({
      label: `${prefix}Server`,
      startMs: entry.requestStart,
      endMs: entry.responseStart,
      children: [],
      phase: true,
    });

    span.children.push({
      label: `${prefix}Download`,
      startMs: entry.responseStart,
      endMs: entry.responseEnd,
      children: [],
      phase: true,
    });
  }
}

function shortenUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
