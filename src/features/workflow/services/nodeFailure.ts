/**
 * What went wrong in a node, and whether trying again could help.
 *
 * Three separate defects motivated this module.
 *
 * 1. A failed AI node returned `{ summary: 'Error: ...', title: 'Error: ...' }` —
 *    the error text written under each declared output key. The engine merged
 *    that into graph state and logged the node as COMPLETED, so a run that did
 *    nothing looked successful and downstream nodes consumed the words
 *    "Error: provider unavailable" as if they were a summary.
 *
 * 2. Tool failures were detected by sniffing two connector-specific keys for
 *    three substrings: `email_status` or `status` containing 'error', 'failed'
 *    or 'validation failed'. Gmail reports an expired token as "Authentication
 *    expired. Please reconnect Gmail and retry.", a throttle as "Gmail rate
 *    limit exceeded after 3 retries." and a bad address as "Recipient ... was
 *    rejected by Gmail." None of those contain any of the three substrings, so
 *    all three were reported to the user as a successful send. Meanwhile
 *    `web.fetch_page` returning `{ error: '...' }` and `files.download_file`
 *    returning `{ downloaded: false }` were not checked at all.
 *
 * 3. Every failure was retried twice, immediately, with no backoff — including
 *    ones no amount of retrying can fix, like an unauthenticated tool or a
 *    missing spreadsheet id.
 *
 * The convention is now declared rather than guessed: an action reports failure
 * by returning a non-empty `error` string. Every registered action declares that
 * field in its output schema, and a registry test enforces it.
 */

/**
 * Why a node failed. This decides whether a retry is worth attempting and what
 * the user should be told to do about it.
 */
export type FailureKind =
  /** Credentials are missing, expired or rejected. A human must reconnect. */
  | 'auth'
  /** Throttled upstream. Waiting helps. */
  | 'rate_limit'
  /** The inputs are wrong. Retrying sends the same wrong inputs. */
  | 'invalid_input'
  /** No tool provides this. The graph has to change. */
  | 'unsupported'
  /** A network or upstream hiccup. Waiting plausibly helps. */
  | 'transient'
  /** Anything else. Reported, not retried. */
  | 'permanent';

/** Failure kinds where trying again could plausibly succeed. */
const RETRYABLE: ReadonlySet<FailureKind> = new Set<FailureKind>(['rate_limit', 'transient']);

export function isRetryable(kind: FailureKind): boolean {
  return RETRYABLE.has(kind);
}

/**
 * Failure kinds a DIFFERENT user-supplied input value could fix — a URL that is
 * blocked or 404s, a recipient a provider rejects, an id that does not exist.
 * A rate_limit or transient failure is not the input's fault, so re-asking for
 * the value would be wrong; those are retried automatically instead.
 */
const INPUT_FAULT: ReadonlySet<FailureKind> = new Set<FailureKind>([
  'invalid_input',
  'auth',
  'permanent',
  'unsupported',
]);

export function isInputFault(kind?: FailureKind): boolean {
  // An unclassified failure is treated as possibly input-related: offering a
  // retry-with-new-value is a cheap, safe suggestion.
  return kind === undefined || INPUT_FAULT.has(kind);
}

/** A node failure, carrying enough to decide what happens next. */
export class NodeExecutionError extends Error {
  readonly kind: FailureKind;
  readonly nodeId?: string;
  readonly toolId?: string;
  readonly toolAction?: string;

  constructor(
    message: string,
    options: {
      kind: FailureKind;
      nodeId?: string;
      toolId?: string;
      toolAction?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'NodeExecutionError';
    this.kind = options.kind;
    this.nodeId = options.nodeId;
    this.toolId = options.toolId;
    this.toolAction = options.toolAction;
  }

  get retryable(): boolean {
    return isRetryable(this.kind);
  }
}

/**
 * Marks a step the planner could not bind to any tool.
 *
 * Shared with the engine so an unsupported step is classified without matching
 * on prose. Exported because the engine both raises and recognises it.
 */
export const UNSUPPORTED_STEP_PREFIX = 'Unsupported step:';

/**
 * Guess a failure kind from a message.
 *
 * Used for errors that arrive as prose: a connector's `error` string, or an
 * exception from a fetch. Patterns are matched in order of how specific they
 * are, and the DEFAULT IS 'permanent' — an unrecognised failure is reported
 * rather than retried. Retrying an unknown error three times triples the
 * latency and fills the log with the same line, and for an action that changes
 * something the retry can duplicate the change. The transient patterns below
 * are deliberately generous so genuine network flakiness is still caught.
 */
export function classifyFailureMessage(raw: string): FailureKind {
  const message = String(raw ?? '');

  if (message.startsWith(UNSUPPORTED_STEP_PREFIX)) return 'unsupported';

  const text = message.toLowerCase();

  // Auth first: an expired token often also reads like a generic failure.
  if (
    /not authenticated|authentication expired|authentication|unauthori[sz]ed|reconnect|invalid_grant|invalid credentials|access denied|forbidden|connect it first|\b401\b|\b403\b/.test(
      text,
    )
  ) {
    return 'auth';
  }

  if (/rate limit|ratelimit|too many requests|quota|throttl|\b429\b/.test(text)) {
    return 'rate_limit';
  }

  if (
    /missing|not provided|no source_url|no content|invalid |validation failed|was rejected|malformed|required|exceeds|too large|not found|\b400\b|\b404\b|\b422\b/.test(
      text,
    )
  ) {
    return 'invalid_input';
  }

  if (
    /timed out|timeout|network|econnrefused|econnreset|enotfound|socket hang up|fetch failed|could not reach|unavailable|temporarily|\b408\b|\b425\b|\b500\b|\b502\b|\b503\b|\b504\b/.test(
      text,
    )
  ) {
    return 'transient';
  }

  return 'permanent';
}

/**
 * Did this action result report a failure?
 *
 * Reads the declared convention only — a non-empty `error` string — plus the two
 * explicit boolean success flags connectors use (`downloaded`, `success`), which
 * are declared fields rather than sniffed prose. Returns null when the action
 * succeeded.
 */
export function detectActionFailure(
  result: Record<string, unknown> | null | undefined,
): { message: string; kind: FailureKind } | null {
  if (!result || typeof result !== 'object') return null;

  const declared = result.error;
  if (typeof declared === 'string' && declared.trim().length > 0) {
    return { message: declared.trim(), kind: classifyFailureMessage(declared) };
  }
  // A non-string truthy error still means failure; do not let a shape mismatch
  // turn a failure into a success.
  if (declared !== undefined && declared !== null && typeof declared !== 'string') {
    const message = String(declared);
    return { message, kind: classifyFailureMessage(message) };
  }

  for (const flag of ['downloaded', 'success', 'sent'] as const) {
    if (result[flag] === false) {
      const message = `The action reported ${flag} = false.`;
      return { message, kind: 'permanent' };
    }
  }

  return null;
}

// ------------------------------------------------------------------ backoff

/** First retry waits this long. */
export const RETRY_BASE_DELAY_MS = 500;
/** No retry waits longer than this. */
export const RETRY_MAX_DELAY_MS = 8_000;
/** Attempts after the first. */
export const MAX_RETRY_ATTEMPTS = 2;

/**
 * How long to wait before retry number `attempt` (1-based).
 *
 * Exponential with +/-25% jitter. Without jitter, a graph whose nodes all hit
 * the same rate-limited API retry in lockstep and get throttled together again.
 * `random` is injectable so the tests are not probabilistic.
 */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, RETRY_MAX_DELAY_MS);
  const jitter = capped * 0.25 * (random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

/** What the user should do about a failure of this kind. */
export function remedyFor(kind: FailureKind): string {
  switch (kind) {
    case 'auth':
      return 'Reconnect the tool and run it again.';
    case 'rate_limit':
      return 'The service is throttling us. Wait a little and run it again.';
    case 'invalid_input':
      return 'Fix the step configuration — one of its inputs is missing or wrong.';
    case 'unsupported':
      return 'Connect a tool that can do this, or remove the step.';
    case 'transient':
      return 'This looks temporary. Running it again may work.';
    case 'permanent':
      return 'This will not fix itself by retrying. Check the step and the logs.';
  }
}
