import { Parser, type Expression } from 'expr-eval';

/**
 * Safe evaluation of workflow edge conditions.
 *
 * WHY THIS EXISTS
 * Conditions used to be executed with `new Function(...stateKeys, "return (" + condition + ")")`.
 * Workflows are loaded from shared server storage, so any stored condition ran as
 * real JavaScript in the browser with full access to `fetch`, `localStorage`, and
 * the DOM — remote code execution through saved data. This module replaces that
 * with a restricted expression grammar that cannot reach any host capability.
 *
 * WHAT IS ALLOWED
 * Comparisons, boolean logic, arithmetic, and a tiny set of pure helpers over the
 * workflow's own state keys. Nothing else: no property access, no function
 * definitions, no assignment, no randomness, no host globals.
 *
 * A NOTE ON "TIMEOUTS"
 * The grammar has no loops, no recursion, and (with `fndef` disabled) no way to
 * define a function, so evaluation time is bounded by the size of the parsed
 * expression. Rather than pretend to preempt a runaway evaluation — which is not
 * possible synchronously in a browser — this module bounds the input: expression
 * length, nesting depth, operator count, and variable count are all capped, which
 * bounds the work. Elapsed time is still measured and reported so a pathological
 * case is visible instead of silent.
 */

// ---------------------------------------------------------------- limits

const LIMITS = {
  /** Longest raw condition accepted. */
  maxLength: 500,
  /** Deepest parenthesis nesting accepted. */
  maxDepth: 12,
  /** Most operator tokens accepted. */
  maxOperators: 60,
  /** Most distinct state keys a condition may reference. */
  maxVariables: 25,
  /** Compiled-expression cache size. */
  maxCacheEntries: 200,
  /** Evaluations slower than this are reported as a warning. */
  slowEvaluationMs: 50,
} as const;

// ---------------------------------------------------------------- parser

/**
 * A deliberately narrow parser.
 *
 * - `allowMemberAccess: false` blocks `a.b`, which is what makes
 *   `constructor.constructor(...)` style escapes unreachable at parse time.
 * - `assignment` off so an expression cannot mutate the scope.
 * - `fndef` off so an expression cannot define a callable.
 * - `random` off because a condition must be deterministic; the engine replays
 *   from checkpoints and a random branch would not be reproducible.
 * - `factorial` off so a stray `!` is a parse error rather than silently meaning
 *   factorial (in this grammar `!x` is NOT logical negation).
 * - `concatenate` off so a stray `||` is a parse error rather than silently
 *   meaning string concatenation.
 */
function buildParser(): Parser {
  const parser = new Parser({
    allowMemberAccess: false,
    operators: {
      // Needed for real conditions.
      comparison: true,
      logical: true,
      add: true,
      subtract: true,
      multiply: true,
      divide: true,
      remainder: true,
      conditional: true,
      length: true,
      in: true,
      // Deliberately disabled.
      assignment: false,
      fndef: false,
      random: false,
      factorial: false,
      concatenate: false,
      power: false,
    },
  });

  // Prune the callable surface to a small allowlist.
  //
  // Two separate registries have to be pruned, which is easy to get wrong:
  //   `parser.functions` holds multi-argument calls (min, max, and the
  //     higher-order map/fold/filter, which accept callables)
  //   `parser.unaryOps`  holds single-argument calls (abs, round, not, and the
  //     entire trigonometry and logarithm family)
  // Pruning only `functions` would leave `sin`, `sqrt`, `log` and friends
  // reachable. None of them is a security hole, but a branch condition has no
  // business calling them, and a narrow surface is easier to reason about.
  const allowedFunctions = new Set(['min', 'max']);
  for (const name of Object.keys(parser.functions)) {
    if (!allowedFunctions.has(name)) delete parser.functions[name];
  }

  const allowedUnaryOps = new Set([
    '-', // negation
    '+', // unary plus
    'not', // logical negation, the target of the `!` rewrite
    'abs',
    'ceil',
    'floor',
    'round',
    'trunc',
    'sign',
    'length',
  ]);
  for (const name of Object.keys(parser.unaryOps)) {
    if (!allowedUnaryOps.has(name)) delete parser.unaryOps[name];
  }

  return parser;
}

const parser = buildParser();

// ---------------------------------------------------------------- normalisation

/**
 * Rewrite JavaScript-style operators into the ones this grammar understands.
 *
 * Existing saved workflows contain JS syntax such as `sentiment === 'positive'`
 * and `score > 50 && score < 90`, none of which parse here:
 *   `===` / `!==` are not tokens at all
 *   `&&`        is not a token at all
 *   `||`        would mean string concatenation
 *   `!x`        would mean factorial
 * Rewriting keeps those workflows working while still evaluating safely.
 *
 * The rewrite is quote-aware: operators inside a string literal are left alone,
 * so `status == "a && b"` keeps its literal intact.
 */
export function normalizeExpression(raw: string): string {
  const source = String(raw ?? '');
  let out = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];

    // ---- inside a string literal: copy verbatim ----
    if (quote) {
      out += char;
      // A backslash escape consumes the next character.
      if (char === '\\' && i + 1 < source.length) {
        out += source[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }

    // ---- outside a string literal: rewrite operators ----
    const rest = source.slice(i);

    if (rest.startsWith('===')) {
      out += '==';
      i += 2;
      continue;
    }
    if (rest.startsWith('!==')) {
      out += '!=';
      i += 2;
      continue;
    }
    if (rest.startsWith('&&')) {
      out += ' and ';
      i += 1;
      continue;
    }
    if (rest.startsWith('||')) {
      out += ' or ';
      i += 1;
      continue;
    }
    // Leave `!=`, `==`, `<=`, `>=` alone; only a lone `!` becomes negation.
    if (char === '!' && source[i + 1] !== '=') {
      out += ' not ';
      continue;
    }

    out += char;
  }

  return collapseWhitespace(out).trim();
}

/**
 * Collapse runs of spaces introduced by the operator rewrites, without touching
 * whitespace inside string literals (where it is meaningful).
 */
function collapseWhitespace(expression: string): string {
  let out = '';
  let quote: string | null = null;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];

    if (quote) {
      out += char;
      if (char === '\\' && i + 1 < expression.length) {
        out += expression[i + 1];
        i += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      out += char;
      continue;
    }

    if (char === ' ' && out.endsWith(' ')) continue;
    out += char;
  }

  return out;
}

// ---------------------------------------------------------------- validation

/** Deepest parenthesis nesting, or -1 when parentheses are unbalanced. */
function measureDepth(expression: string): number {
  let depth = 0;
  let max = 0;
  let quote: string | null = null;

  for (let i = 0; i < expression.length; i += 1) {
    const char = expression[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') {
      depth += 1;
      max = Math.max(max, depth);
    } else if (char === ')') {
      depth -= 1;
      if (depth < 0) return -1;
    }
  }

  return depth === 0 ? max : -1;
}

/** Count operator tokens outside string literals. */
function countOperators(expression: string): number {
  const withoutStrings = expression.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const matches = withoutStrings.match(/(==|!=|<=|>=|<|>|\+|-|\*|\/|%|\band\b|\bor\b|\bnot\b|\bin\b)/g);
  return matches ? matches.length : 0;
}

// ---------------------------------------------------------------- compilation

export interface CompiledCondition {
  ok: true;
  /** State keys the condition reads. */
  variables: string[];
  /** The expression after operator normalisation, for display and debugging. */
  normalized: string;
  expression: Expression;
}

export interface ConditionError {
  ok: false;
  /** Message suitable for showing in the editor. */
  error: string;
}

export type CompileResult = CompiledCondition | ConditionError;

const cache = new Map<string, CompileResult>();

/**
 * Parse and validate a condition without evaluating it.
 *
 * Call this at authoring time so a bad condition surfaces in the editor rather
 * than halfway through a run.
 */
export function compileCondition(raw: string): CompileResult {
  const key = String(raw ?? '');

  const cached = cache.get(key);
  if (cached) return cached;

  const result = compileUncached(key);

  // Simple bounded cache: drop the oldest entry when full.
  if (cache.size >= LIMITS.maxCacheEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, result);

  return result;
}

function compileUncached(raw: string): CompileResult {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, error: 'The condition is empty.' };
  }
  if (trimmed.length > LIMITS.maxLength) {
    return {
      ok: false,
      error: `The condition is too long (${trimmed.length} characters, limit ${LIMITS.maxLength}).`,
    };
  }

  const normalized = normalizeExpression(trimmed);

  const depth = measureDepth(normalized);
  if (depth === -1) {
    return { ok: false, error: 'The parentheses in this condition are unbalanced.' };
  }
  if (depth > LIMITS.maxDepth) {
    return { ok: false, error: `The condition nests too deeply (limit ${LIMITS.maxDepth}).` };
  }

  const operatorCount = countOperators(normalized);
  if (operatorCount > LIMITS.maxOperators) {
    return {
      ok: false,
      error: `The condition has too many operators (${operatorCount}, limit ${LIMITS.maxOperators}).`,
    };
  }

  let expression: Expression;
  try {
    expression = parser.parse(normalized);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `This condition could not be parsed: ${detail}` };
  }

  let variables: string[];
  try {
    variables = expression.variables({ withMembers: false });
  } catch {
    variables = [];
  }

  if (variables.length > LIMITS.maxVariables) {
    return {
      ok: false,
      error: `The condition references too many state keys (${variables.length}, limit ${LIMITS.maxVariables}).`,
    };
  }

  return { ok: true, variables, normalized, expression };
}

/**
 * Authoring-time check.
 * @returns an error message, or null when the condition is valid.
 */
export function validateCondition(raw: string): string | null {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    // An empty condition means "always follow this edge", which is valid.
    return null;
  }
  const result = compileCondition(String(raw));
  return result.ok ? null : result.error;
}

// ---------------------------------------------------------------- evaluation

/**
 * Build the evaluation scope.
 *
 * Only the keys the expression actually references are exposed, so a condition
 * cannot read unrelated state. The object has a null prototype, so names like
 * `__proto__` or `constructor` cannot resolve to anything inherited. Referenced
 * keys that are absent from state become `null`, because expr-eval throws on an
 * undefined variable and a missing key should make a condition false rather than
 * abort the run.
 */
function buildScope(variables: string[], state: Record<string, unknown>): Record<string, unknown> {
  const scope = Object.create(null) as Record<string, unknown>;

  for (const name of variables) {
    if (name === '__metadata') {
      // Run metadata is engine bookkeeping, not workflow data.
      scope[name] = null;
      continue;
    }
    const value = state?.[name];
    scope[name] = value === undefined ? null : (value as unknown);
  }

  return scope;
}

export interface EvaluationOutcome {
  /** The boolean the engine should act on. */
  value: boolean;
  /** Set when the condition could not be compiled or evaluated. */
  error?: string;
  elapsedMs: number;
}

/**
 * Evaluate a condition against workflow state, in detail.
 *
 * Fails CLOSED: if a condition cannot be compiled or evaluated, the result is
 * `false` and the reason is reported. A branch that cannot be decided must not
 * be taken.
 */
export function evaluateConditionDetailed(
  raw: string | undefined | null,
  state: Record<string, unknown>,
): EvaluationOutcome {
  // An absent condition means an unconditional edge.
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: true, elapsedMs: 0 };
  }

  const compiled = compileCondition(String(raw));
  if (!compiled.ok) {
    return { value: false, error: compiled.error, elapsedMs: 0 };
  }

  const startedAt = performance.now();
  try {
    // expr-eval types `Value` as number | string | function | nested record, but
    // workflow state legitimately holds arbitrary JSON (arrays, null, booleans).
    // The runtime handles those; only the published types are narrower, so the
    // scope is cast at this single boundary rather than distorting GraphState.
    const scope = buildScope(compiled.variables, state) as unknown as Parameters<
      Expression['evaluate']
    >[0];
    const result = compiled.expression.evaluate(scope);
    const elapsedMs = performance.now() - startedAt;

    if (elapsedMs > LIMITS.slowEvaluationMs) {
      console.warn(
        `[SafeExpression] Condition took ${Math.round(elapsedMs)}ms to evaluate: ${compiled.normalized}`,
      );
    }

    return { value: toBoolean(result), elapsedMs };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      value: false,
      error: `This condition could not be evaluated: ${detail}`,
      elapsedMs: performance.now() - startedAt,
    };
  }
}

/** Coerce a result to a boolean the way a branch decision needs. */
function toBoolean(result: unknown): boolean {
  if (typeof result === 'boolean') return result;
  if (typeof result === 'number') return result !== 0 && !Number.isNaN(result);
  if (typeof result === 'string') return result.length > 0;
  return Boolean(result);
}

/**
 * Evaluate a condition against workflow state.
 *
 * Drop-in replacement for the previous `new Function` based helper: an empty
 * condition is true, anything unparseable or failing is false.
 */
export function evaluateCondition(
  raw: string | undefined | null,
  state: Record<string, unknown>,
): boolean {
  const outcome = evaluateConditionDetailed(raw, state);
  if (outcome.error) {
    console.warn(`[SafeExpression] ${outcome.error}`);
  }
  return outcome.value;
}

/** Exposed for tests and for surfacing limits in the editor. */
export const EXPRESSION_LIMITS = LIMITS;

/** Clears the compiled-expression cache. Test helper. */
export function __clearExpressionCache(): void {
  cache.clear();
}
