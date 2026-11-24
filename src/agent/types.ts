/** Control frames the CLI sends to drive a session (serialized as JSON). */
export type AgentControlFrame =
  | { type: 'start'; prompt: string } // open the session with the first turn
  | { type: 'send'; prompt: string } // a follow-up turn or an awaited reply (MFA)
  | { type: 'stop' }; // abort the in-flight turn; the session stays open

/** Inbound frame `type` discriminants the CLI handles. */
export type AgentFrameType =
  | 'data'
  | 'tool_call'
  | 'tool_result'
  | 'usage'
  | 'awaiting_input'
  | 'error'
  | 'end';

/** A streamed assistant-text delta. */
export interface AgentDataFrame {
  type: 'data';
  text?: string;
}

/** A tool invocation starting — `params` is the MCP envelope (see `unwrapToolCall`). */
export interface AgentToolCallFrame {
  type: 'tool_call';
  id?: string;
  method?: string;
  params?: unknown;
  rationale?: string;
}

/** A tool invocation finishing. Carries only the id + ok flag. */
export interface AgentToolResultFrame {
  type: 'tool_result';
  id?: string;
  ok?: boolean;
}

/** The agent paused for user input (e.g. an MFA code). Replied to with `send`. */
export interface AgentAwaitingInputFrame {
  type: 'awaiting_input';
  reason?: string;
}

/**
 * A server-side error. Re-emitted by `AgentClient` as `agent_error` (not the
 * EventEmitter `error` event, which would throw with no listener). `retryable`
 * gates whether the REPL keeps the session alive — missing is treated as
 * terminal (see `chat.ts`).
 */
export interface AgentErrorFrame {
  type: 'error';
  code?: string;
  message?: string;
  retryable?: boolean;
}

/**
 * The structured outcome carried by the terminal `end` frame's `result`. This
 * is the task result the renderer pretty-prints in `formatEndResult` and
 * emits verbatim under `--json`. `result` is `null` when the turn produced no
 * structured outcome (plain chat reply — `text` carries it instead).
 */
export interface AgentEndResult {
  success: boolean;
  reason_code?: string;
  final_url?: string;
  evidence?: string;
}

export interface AgentEndFrame {
  type: 'end';
  result?: AgentEndResult | null;
  text?: string;
}

/**
 * Runtime guard for `end.result`. The wire is untyped JSON, so a structural
 * check defends the renderer / `--json` consumers against a shape change
 * upstream rather than trusting the static type.
 */
export const isAgentEndResult = (value: unknown): value is AgentEndResult =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as { success?: unknown }).success === 'boolean';
