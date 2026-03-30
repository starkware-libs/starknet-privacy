export type Span = {
  label: string;
  startMs: number;
  endMs: number | null;
  children: Span[];
};

export class Timeline {
  readonly spans: Span[] = [];
  private stack: Span[] = [];

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
}

export function spanDuration(span: Span): number {
  return (span.endMs ?? performance.now()) - span.startMs;
}
