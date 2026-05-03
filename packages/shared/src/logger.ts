// SPDX-License-Identifier: MPL-2.0

/**
 * P16 — structured logger. JSON-per-line to stderr; the host environment
 * (operator's log aggregator: Loki/Datadog/CloudWatch/etc.) ships from
 * there. Stable shape across every Caelo service so a single
 * `request_id` query reconstructs the full timeline.
 *
 * Redaction pass replaces values for keys matching common-secret regex
 * with `***` so a stray `{password: "..."}` extra never lands in logs.
 *
 * NOT a replacement for `audit_events` — audit captures intent (op,
 * actor, succeeded), structured logs capture trace (request_id,
 * service-to-service hops, latency, errors). Cross-correlate via the
 * shared `request_id` column.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type ServiceName = "admin" | "gateway" | "orchestrator" | "plugin-host" | "static-gen";

export interface LogContext {
  readonly requestId: string;
  readonly actorId?: string;
  readonly actorKind?: "human" | "ai" | "system" | "plugin";
  readonly opName?: string;
  readonly chatSessionId?: string;
  readonly pluginSlug?: string;
}

export interface StructuredLogEntry {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly service: ServiceName;
  readonly env: string;
  readonly ctx: LogContext;
  readonly extra?: Record<string, unknown>;
}

// Word-anchored — without the boundaries `key` would match `monkey`,
// `token` would match `tokenizer`, `secret` would match `secretary`.
// Whole-key match is the right semantic for log-field redaction.
const SECRET_KEY_RE =
  /^(password|passwd|secret|secrets|token|tokens|api[-_]?key|api[-_]?keys|cookie|cookies|authorization|bearer|x[-_]api[-_]?key|csrf[-_]?secret|cookie[-_]?secret)$/i;

export function redact(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = "***";
    } else if (v && typeof v === "object") {
      out[k] = redact(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface Logger {
  with(ctx: Partial<LogContext>): Logger;
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  readonly service: ServiceName;
  readonly env?: string;
  /** Defaults to console.error so structured logs flow to stderr. */
  readonly sink?: (entry: StructuredLogEntry) => void;
  /** Minimum level to emit; default 'info' (suppresses 'debug'). */
  readonly minLevel?: LogLevel;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function makeLogger(opts: LoggerOptions): Logger {
  const env = opts.env ?? process.env.CAELO_ENV ?? "dev";
  const minRank = LEVEL_RANK[opts.minLevel ?? "info"];
  const sink =
    opts.sink ??
    ((entry: StructuredLogEntry) => {
      // biome-ignore lint/suspicious/noConsole: structured logger sink
      process.stderr.write(`${JSON.stringify(entry)}\n`);
    });

  function emit(
    ctx: LogContext,
    level: LogLevel,
    msg: string,
    extra?: Record<string, unknown>,
  ): void {
    if (LEVEL_RANK[level] < minRank) return;
    const entry: StructuredLogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      service: opts.service,
      env,
      ctx,
      extra: extra ? (redact(extra) as Record<string, unknown>) : undefined,
    };
    sink(entry);
  }

  function buildLogger(ctx: LogContext): Logger {
    return {
      with(extraCtx) {
        return buildLogger({ ...ctx, ...extraCtx });
      },
      debug(msg, extra) {
        emit(ctx, "debug", msg, extra);
      },
      info(msg, extra) {
        emit(ctx, "info", msg, extra);
      },
      warn(msg, extra) {
        emit(ctx, "warn", msg, extra);
      },
      error(msg, extra) {
        emit(ctx, "error", msg, extra);
      },
    };
  }

  // Default ctx has a synthetic request_id so a logger created outside
  // of any request boundary still produces correlatable output (visible
  // in the log stream as `synthetic-…`).
  return buildLogger({ requestId: `synthetic-${crypto.randomUUID().slice(0, 8)}` });
}

/**
 * Mint a fresh request_id at a request boundary. Caller threads through
 * ExecutionContext + outbound HTTP headers (`X-Caelo-Request-Id`).
 */
export function mintRequestId(): string {
  return crypto.randomUUID();
}
