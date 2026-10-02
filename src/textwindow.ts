/**
 * Token-aware text windowing + extraction cache.
 *
 * Long bodies (PDFs, OCR scans, whole books) are the main driver of token use:
 * every character returned lands in the model's context and is re-sent on every
 * later turn. These helpers let the fetch tools page through a body in fixed
 * windows — returning only the slice the caller asked for and telling it the
 * exact `offset` to continue from — while caching the fully-extracted text so
 * paging never re-downloads or re-parses the source.
 */

const MAX_WINDOW = 200_000;
const MIN_WINDOW = 500;

export interface TextWindow {
  /** The returned slice of the body. */
  slice: string;
  /** Total length of the full body, in characters. */
  total: number;
  /** Character index this slice starts at. */
  start: number;
  /** Character index this slice ends at (exclusive). */
  end: number;
  /** Whether more text remains after `end`. */
  truncated: boolean;
  /** Offset to pass next to continue, or null when the body is exhausted. */
  nextOffset: number | null;
}

/** Slice `text` to a single window starting at `offset`, clamped to sane bounds. */
export function windowText(text: string, maxChars: number, offset = 0): TextWindow {
  const total = text.length;
  const max = Math.max(MIN_WINDOW, Math.min(maxChars, MAX_WINDOW));
  const off = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const start = Math.min(off, total);
  const end = Math.min(start + max, total);
  return {
    slice: text.slice(start, end),
    total,
    start,
    end,
    truncated: end < total,
    nextOffset: end < total ? end : null,
  };
}

/** One-line position/continuation note appended after a windowed slice. */
export function windowNote(w: TextWindow): string {
  const span = `chars ${w.start.toLocaleString()}–${w.end.toLocaleString()} of ${w.total.toLocaleString()}`;
  if (w.truncated) {
    return `\n\n[${span}. More text remains — call again with offset=${w.nextOffset} to read the next part.]`;
  }
  return `\n\n[${span} — end of text.]`;
}

/** Note for an offset that lands at or past the end of the body. */
export function pastEndNote(total: number, offset: number): string {
  return (
    `Offset ${offset.toLocaleString()} is at/past the end of the text ` +
    `(total ${total.toLocaleString()} chars). Nothing more to return.`
  );
}

/** Assemble a header + windowed body + continuation note in one shot. */
export function renderWindow(header: string, fullText: string, maxChars: number, offset = 0): string {
  const w = windowText(fullText, maxChars, offset);
  if (w.total === 0) return `${header}\n\n(no readable text.)`;
  if (w.slice === "") return `${header}\n\n${pastEndNote(w.total, w.start)}`;
  return `${header}\n\n${w.slice}${windowNote(w)}`;
}

/**
 * Tiny entry- and weight-bounded LRU cache for fully-extracted bodies, keyed
 * by source id/URL. Callers normally use encoded bytes as the weight.
 */
export class LruCache<V> {
  private map = new Map<string, { value: V; weight: number }>();
  private totalWeight = 0;

  constructor(
    private readonly maxEntries = 8,
    private readonly maxWeight = Number.POSITIVE_INFINITY,
    private readonly weigh: (value: V) => number = () => 1,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("LruCache maxEntries must be a positive integer.");
    }
    if (!(maxWeight > 0)) {
      throw new Error("LruCache maxWeight must be positive.");
    }
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (entry !== undefined) {
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry?.value;
  }

  set(key: string, val: V): void {
    const old = this.map.get(key);
    if (old) {
      this.totalWeight -= old.weight;
      this.map.delete(key);
    }

    const rawWeight = this.weigh(val);
    const weight = Number.isFinite(rawWeight) ? Math.max(0, rawWeight) : this.maxWeight + 1;
    if (weight > this.maxWeight) return;

    this.map.set(key, { value: val, weight });
    this.totalWeight += weight;
    while (this.map.size > this.maxEntries || this.totalWeight > this.maxWeight) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.totalWeight -= this.map.get(oldest)?.weight ?? 0;
      this.map.delete(oldest);
    }
  }

  delete(key: string): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;
    this.totalWeight -= entry.weight;
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }

  get weight(): number {
    return this.totalWeight;
  }
}
