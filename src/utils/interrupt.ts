/**
 * Conventional exit codes for an interrupted CLI (128 + signal number).
 * SIGBREAK is Windows Ctrl-Break / CTRL_BREAK_EVENT — the only graceful
 * signal a parent can target at a detached child there — so it maps to
 * the same code as Ctrl-C.
 */
const INTERRUPT_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGBREAK: 130,
} as const;

type InterruptSignal = keyof typeof INTERRUPT_EXIT_CODES;

export interface InterruptOptions {
  /** Signal source. Tests pass an EventEmitter; production uses `process`. */
  target?: Pick<NodeJS.EventEmitter, 'once' | 'off'>;
  exit?: (code: number) => void;
}

/**
 * Run `cleanup` before exiting when the user interrupts (Ctrl-C, SIGTERM,
 * Ctrl-Break). Without it Node exits immediately on SIGINT and skips every
 * `finally`, leaving a headless browser running and a temp profile copy —
 * cookies included — on disk.
 *
 * The first signal starts the cleanup; a different signal arriving meanwhile
 * waits for that same cleanup instead of starting a competing one, and the
 * process exits with the first signal's code. Repeating the same signal falls
 * through to Node's default handler, so an impatient user can still force
 * the exit.
 *
 * Returns a disposer that removes the handlers once the guarded work is done.
 */
export const onInterrupt = (
  cleanup: () => Promise<void>,
  {
    target = process,
    exit = (code) => process.exit(code),
  }: InterruptOptions = {},
): (() => void) => {
  let cleaning: Promise<void> | undefined;
  const handlers = (
    Object.entries(INTERRUPT_EXIT_CODES) as [InterruptSignal, number][]
  ).map(([signal, code]) => {
    const handler = () => {
      cleaning ??= cleanup().catch(() => undefined);
      void cleaning.finally(() => exit(code));
    };
    target.once(signal, handler);
    return [signal, handler] as const;
  });
  return () =>
    handlers.forEach(([signal, handler]) => target.off(signal, handler));
};
