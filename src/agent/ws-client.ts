import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ApiError, PreconditionError } from '../errors.js';
import { terminalSafe } from '../utils/terminal.js';

import type { AgentControlFrame } from './types.js';

export type { AgentFrameType } from './types.js';

// Graceful close codes (normal, going-away, no-status); anything else is a fault.
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005]);

/**
 * Build the `/chromium/cli` WS URL: `http(s)`→`ws(s)`, trim trailing slashes,
 * append `token`. The browser session (proxy/profile) is chosen server-side.
 */
export const buildCliWsUrl = (server: string, token: string): string => {
  const base = server.replace(/^http/i, 'ws').replace(/\/+$/, '');
  const url = new URL(`${base}/chromium/cli`);
  url.searchParams.set('token', token);
  return url.toString();
};

export interface AgentClientOptions {
  server: string;
  token: string;
  /** Override the WebSocket constructor (tests). */
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Thin client for the `/chromium/cli` hosted-agent WS: connects, sends control
 * frames (`start`/`send`/`stop`), and re-emits inbound frames by `type`. Connect
 * errors map to typed `UserFacingError`s (401/403 → Precondition, else → Api).
 */
export class AgentClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly server: string;
  private readonly token: string;
  private readonly WebSocketImpl: typeof WebSocket;

  constructor(opts: AgentClientOptions) {
    super();
    this.server = opts.server;
    this.token = opts.token;
    this.WebSocketImpl = opts.WebSocketImpl ?? WebSocket;
  }

  connect(): Promise<void> {
    const url = buildCliWsUrl(this.server, this.token);
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url);
      let settled = false;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          reject(err);
        } else {
          this.ws = ws;
          resolve();
        }
      };

      ws.once('open', () => settle());

      ws.once('unexpected-response', (_req, res) => {
        const status = res.statusCode ?? 0;
        settle(this.mapUpgradeError(status, res.statusMessage ?? ''));
      });

      ws.on('error', (err: Error) => {
        // Connect-phase transport failures (DNS, refused, TLS) — surface as
        // ApiError with status 0 so the CLI exits with the network code.
        if (!settled) {
          settle(
            new ApiError(
              `WebSocket connection failed: ${err.message}`,
              0,
              undefined,
              'websocket-failed',
            ),
          );
          return;
        }
        this.emit('agent_error', {
          code: 'ws-error',
          message: err.message,
          retryable: false,
        });
      });

      ws.on('message', (data: WebSocket.RawData) => this.handleMessage(data));
      ws.on('close', (code, reason) => {
        const reasonText = reason?.toString('utf8') ?? '';
        // Surface abnormal closes (1006/1011/…) as agent_error so the REPL doesn't read them as a clean exit.
        if (!NORMAL_CLOSE_CODES.has(code)) {
          this.emit('agent_error', {
            code: `ws-closed-${code}`,
            message: `WebSocket closed abnormally (code ${code}${reasonText ? `: ${reasonText}` : ''})`,
            retryable: false,
          });
          return;
        }
        this.emit('close', { code, reason: reasonText });
      });
    });
  }

  /** Send the first user turn. */
  start(prompt: string): void {
    this.sendFrame({ type: 'start', prompt });
  }

  /** Send a follow-up turn (multi-turn, MFA reply). */
  send(prompt: string): void {
    this.sendFrame({ type: 'send', prompt });
  }

  /** Abort the in-flight server-side turn. The session stays open for resume. */
  stop(): void {
    this.sendFrame({ type: 'stop' });
  }

  /** Close the WS. The server tears down its Agent on the close event. */
  close(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
  }

  private sendFrame(frame: AgentControlFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new ApiError(
        'Cannot send a frame: WebSocket is not open.',
        0,
        undefined,
        'websocket-not-open',
      );
    }
    this.ws.send(JSON.stringify(frame));
  }

  private handleMessage(data: WebSocket.RawData): void {
    let frame: { type?: string } & Record<string, unknown>;
    try {
      frame = JSON.parse(data.toString('utf8'));
    } catch {
      // Drop unparseable frames; the wire format is newline-JSON and any
      // non-JSON traffic is a server bug, not something the CLI can act on.
      return;
    }
    if (typeof frame.type !== 'string') return;
    this.emit(frame.type === 'error' ? 'agent_error' : frame.type, frame);
  }

  private mapUpgradeError(status: number, statusMessage: string): Error {
    const detail = statusMessage ? ` — ${terminalSafe(statusMessage)}` : '';
    if (status === 401 || status === 403) {
      return new PreconditionError(
        `Authentication failed (HTTP ${status}${detail}). Check your token and server.`,
        'invalid-token',
      );
    }
    return new ApiError(
      `Server rejected the agent connection (HTTP ${status}${detail}).`,
      status,
    );
  }
}
