/**
 * Live single-line status renderer that owns one terminal line: a braille
 * spinner while work is in flight, frozen at a ✓/✗ mark on completion. Non-TTY
 * falls back to plain scrolling lines so piped output stays grep-able.
 */

import stringWidth from 'string-width';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const FRAME_MS = 80;

/** Hard cap on the rendered line width so wraps don't break `\r\x1b[K` clears. */
const DEFAULT_MAX_WIDTH = 100;
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

const clipToWidth = (text: string, width: number): string => {
  let used = 0;
  let clipped = '';
  let withEllipsis = '';
  for (const { segment: raw } of segmenter.segment(text)) {
    // Match lone surrogates only; /u leaves valid supplementary pairs intact.
    const segment = raw.replace(/[\ud800-\udfff]/gu, '�');
    const cells = stringWidth(segment);
    if (used + cells > width) return `${withEllipsis}…`;
    clipped += segment;
    used += cells;
    if (used <= width - 1) withEllipsis = clipped;
  }
  return clipped;
};

export interface SpinnerPart {
  text: string;
  style?: (text: string) => string;
}

export interface SpinnerOptions {
  out?: NodeJS.WriteStream;
  /** Override TTY detection (tests). */
  isTTY?: boolean;
  /** Override the frame interval (tests). 0 disables the timer (frame stays at 0). */
  intervalMs?: number;
}

/**
 * A spinner owning one terminal line via `set` / `done` / `clear`. The internal
 * `\r\x1b[K` sequences move the cursor to column 0 and clear to end of line —
 * the cursor-overwrite trick that survives most terminals.
 */
export class Spinner {
  private readonly out: NodeJS.WriteStream;
  private readonly isTTY: boolean;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private idx = 0;
  private parts: SpinnerPart[] = [];
  private active = false;

  constructor(opts: SpinnerOptions = {}) {
    this.out = opts.out ?? process.stdout;
    this.isTTY = opts.isTTY ?? !!this.out.isTTY;
    this.intervalMs = opts.intervalMs ?? FRAME_MS;
  }

  /** Whether the spinner is currently rendering a live line. */
  isActive(): boolean {
    return this.active;
  }

  /** Start or update the live label. Idempotent. */
  set(text: string | SpinnerPart[]): void {
    this.parts = typeof text === 'string' ? [{ text }] : text;
    if (!this.isTTY) {
      // Non-TTY: suppress in-flight rendering so piped output gets a clean
      // log of *completed* tools (one line per `done()`), not duplicate
      // start/finish noise.
      return;
    }
    this.active = true;
    this.render();
    if (this.intervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.render(), this.intervalMs);
      // Don't keep the event loop alive just for the spinner.
      this.timer.unref?.();
    }
  }

  /** Freeze the line at a final label (✓/✗) and stop the timer. */
  done(text: string | SpinnerPart[]): void {
    this.stopTimer();
    this.parts = typeof text === 'string' ? [{ text }] : text;
    if (!this.isTTY) {
      this.out.write(`${this.parts.map(({ text }) => text).join('')}\n`);
      this.active = false;
      return;
    }
    this.writeLine(this.parts);
    // Commit the row: the next event lands on a fresh line below, so completed
    // tool lines accumulate as a permanent log rather than being overwritten.
    this.out.write('\n');
    this.active = false;
  }

  /** Wipe the line and stop the timer. */
  clear(): void {
    this.stopTimer();
    if (!this.isTTY) {
      this.active = false;
      return;
    }
    if (this.active) this.out.write('\r\x1b[K');
    this.active = false;
  }

  private render(): void {
    const frame = FRAMES[this.idx % FRAMES.length];
    this.idx += 1;
    this.writeLine([{ text: `${frame} ` }, ...this.parts]);
  }

  private writeLine(parts: SpinnerPart[]): void {
    const plain = clipToWidth(
      parts.map(({ text }) => text).join(''),
      this.maxWidth(),
    );
    let offset = 0;
    const content = parts
      .map(({ text, style }) => {
        const clipped = plain.slice(offset, offset + text.length);
        offset += text.length;
        return clipped && style ? style(clipped) : clipped;
      })
      .join('');
    this.out.write(`\r\x1b[K${content}`);
  }

  private maxWidth(): number {
    // `process.stdout.columns` is undefined when not a TTY; clamp + fall back.
    const cols = this.out.columns;
    if (typeof cols === 'number' && cols > 10) return cols - 1;
    return DEFAULT_MAX_WIDTH;
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
