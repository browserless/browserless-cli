import type { Readable, Writable } from 'node:stream';

/**
 * Error text once the browser's end of the pipe is gone. `isTransportDeadError`
 * in `cdp.ts` matches it, so a browser that dies mid-capture still trips the
 * fail-fast instead of timing out origin by origin.
 */
export const CDP_PIPE_CLOSED = 'CDP pipe closed';

type Params = any;
type Handler = (params: Params) => void;

export interface CdpSession {
  send<T = Params>(method: string, params?: object): Promise<T>;
  /** Subscribe to an event; returns the unsubscribe function. */
  on(event: string, handler: Handler): () => void;
  /**
   * The params of the next `event`; rejects if the pipe closes first. A wait
   * abandoned before its event fires stays registered until the pipe closes —
   * fine for one capture's bounded set of tabs, not for a long-lived connection.
   */
  once(event: string): Promise<Params>;
}

export interface CdpPipe extends CdpSession {
  /** A target session from `Target.attachToTarget({ flatten: true })`. */
  session(sessionId: string): CdpSession;
  /** Stop talking to the browser and fail everything still pending. */
  close(): void;
}

interface Pending {
  method: string;
  resolve: (result: Params) => void;
  reject: (err: Error) => void;
}

/**
 * Minimal Chrome DevTools Protocol client over `--remote-debugging-pipe`.
 * Chrome reads commands from its fd 3 (`input`) and writes replies and events
 * to fd 4 (`output`), each message JSON terminated by a NUL byte. Unlike
 * `--remote-debugging-port`, nothing else on the machine can reach it: the
 * pipe exists only as file descriptors this process holds.
 *
 * Every target shares the one connection: tabs are flattened sessions, and a
 * session's commands and events carry its `sessionId`.
 */
export const connectCdpPipe = (input: Writable, output: Readable): CdpPipe => {
  let nextId = 1;
  let closedError: Error | null = null;
  const pending = new Map<number, Pending>();
  const listeners = new Map<string, Set<Handler>>();
  const closeWaiters = new Set<(err: Error) => void>();
  let partial: Buffer[] = [];

  const key = (sessionId: string | undefined, event: string) =>
    `${sessionId ?? ''}\0${event}`;

  const fail = (err: Error) => {
    if (closedError) return;
    closedError = err;
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
    for (const reject of closeWaiters) reject(err);
    closeWaiters.clear();
    listeners.clear();
  };

  const dispatch = (frame: string) => {
    let message: Params;
    try {
      message = JSON.parse(frame);
    } catch {
      return;
    }
    if (typeof message?.id === 'number') {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.error) {
        entry.reject(
          new Error(
            `${entry.method}: ${message.error.message ?? 'protocol error'}`,
          ),
        );
      } else {
        entry.resolve(message.result ?? {});
      }
      return;
    }
    if (typeof message?.method === 'string') {
      const handlers = listeners.get(key(message.sessionId, message.method));
      for (const handler of [...(handlers ?? [])]) handler(message.params);
    }
  };

  // Frames are split on NUL bytes before decoding, so a multi-byte character
  // cut across two chunks is reassembled intact.
  output.on('data', (chunk: Buffer) => {
    let start = 0;
    let end = chunk.indexOf(0);
    while (end !== -1) {
      partial.push(chunk.subarray(start, end));
      const frame = Buffer.concat(partial).toString('utf8');
      partial = [];
      dispatch(frame);
      start = end + 1;
      end = chunk.indexOf(0, start);
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  });
  output.on('end', () => fail(new Error(CDP_PIPE_CLOSED)));
  output.on('close', () => fail(new Error(CDP_PIPE_CLOSED)));
  output.on('error', (err) =>
    fail(new Error(`${CDP_PIPE_CLOSED}: ${err.message}`)),
  );
  input.on('error', (err) =>
    fail(new Error(`${CDP_PIPE_CLOSED}: ${err.message}`)),
  );

  const send = (
    method: string,
    params: object = {},
    sessionId?: string,
  ): Promise<Params> => {
    if (closedError) return Promise.reject(closedError);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { method, resolve, reject });
      const message = sessionId
        ? { id, method, params, sessionId }
        : { id, method, params };
      input.write(`${JSON.stringify(message)}\0`, (err) => {
        if (!err || !pending.has(id)) return;
        pending.delete(id);
        reject(new Error(`${CDP_PIPE_CLOSED}: ${err.message}`));
      });
    });
  };

  const on = (
    sessionId: string | undefined,
    event: string,
    handler: Handler,
  ) => {
    if (closedError) return () => undefined;
    const k = key(sessionId, event);
    const set = listeners.get(k) ?? new Set<Handler>();
    set.add(handler);
    listeners.set(k, set);
    return () => {
      set.delete(handler);
      if (set.size === 0 && listeners.get(k) === set) listeners.delete(k);
    };
  };

  const once = (sessionId: string | undefined, event: string) =>
    new Promise<Params>((resolve, reject) => {
      if (closedError) {
        reject(closedError);
        return;
      }
      closeWaiters.add(reject);
      const off = on(sessionId, event, (params) => {
        off();
        closeWaiters.delete(reject);
        resolve(params);
      });
    });

  const sessionFor = (sessionId?: string): CdpSession => ({
    send: (method, params) => send(method, params, sessionId),
    on: (event, handler) => on(sessionId, event, handler),
    once: (event) => once(sessionId, event),
  });

  return {
    ...sessionFor(undefined),
    session: (sessionId) => sessionFor(sessionId),
    close: () => {
      fail(new Error(CDP_PIPE_CLOSED));
      input.destroy();
      output.destroy();
    },
  };
};
