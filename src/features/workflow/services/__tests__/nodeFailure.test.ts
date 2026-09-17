import { describe, expect, it } from 'vitest';
import '@features/tools/connectors';
import { ACTION_ERROR_KEY, getAllTools } from '@features/tools/toolRegistry';
import {
    MAX_RETRY_ATTEMPTS,
    NodeExecutionError,
    RETRY_BASE_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    UNSUPPORTED_STEP_PREFIX,
    classifyFailureMessage,
    detectActionFailure,
    isRetryable,
    remedyFor,
    retryDelayMs,
    type FailureKind
} from '../nodeFailure';

describe('classifyFailureMessage', () => {
    it.each([
        // The four Gmail messages the old substring sniff let through as sends.
        ['Authentication expired. Please reconnect Gmail and retry.', 'auth'],
        ['Gmail rate limit exceeded after 3 retries. Try again later.', 'rate_limit'],
        ['Recipient "x@y" was rejected by Gmail. Verify the address.', 'invalid_input'],
        ['Email exceeds Gmail 25 MB limit.', 'invalid_input'],
        // Auth in its various spellings.
        ['Gmail is not authenticated. Connect it first.', 'auth'],
        ['Request failed with 401', 'auth'],
        ['403 Forbidden', 'auth'],
        ['invalid_grant', 'auth'],
        // Throttling.
        ['Too many requests, slow down.', 'rate_limit'],
        ['429 from upstream', 'rate_limit'],
        ['Daily quota exhausted', 'rate_limit'],
        // Caller's fault.
        ['Missing spreadsheetId', 'invalid_input'],
        ['No source_url was provided', 'invalid_input'],
        ['Validation failed: Missing recipient email address (to)', 'invalid_input'],
        ['Spreadsheet not found', 'invalid_input'],
        // Worth another go.
        ['The request timed out.', 'transient'],
        ['fetch failed', 'transient'],
        ['ECONNREFUSED 127.0.0.1:3234', 'transient'],
        ['503 Service Unavailable', 'transient'],
        ['Could not reach the AutoAgent server. Is it running?', 'transient']
    ])('reads %j as %s', (message, expected) => {
        expect(classifyFailureMessage(message)).toBe(expected);
    });

    it('recognises an unsupported step by its marker, not by prose', () => {
        expect(classifyFailureMessage(`${UNSUPPORTED_STEP_PREFIX} Text the customer — no tool.`)).toBe(
            'unsupported'
        );
    });

    it('defaults to permanent for anything it does not recognise', () => {
        // Deliberate: an unrecognised failure is reported rather than retried
        // three times to produce the same message three times.
        expect(classifyFailureMessage('the flux capacitor is misaligned')).toBe('permanent');
        expect(classifyFailureMessage('')).toBe('permanent');
    });

    it('prefers auth over the generic reading of the same message', () => {
        // "failed" and "unauthorized" in one sentence must resolve to auth, since
        // that is the one the user can act on.
        expect(classifyFailureMessage('Send failed: unauthorized')).toBe('auth');
    });
});

describe('isRetryable', () => {
    const kinds: FailureKind[] = [
        'auth',
        'rate_limit',
        'invalid_input',
        'unsupported',
        'transient',
        'permanent'
    ];

    it('allows retries only where waiting could help', () => {
        const retryable = kinds.filter(isRetryable);
        expect(retryable).toEqual(['rate_limit', 'transient']);
    });

    it('gives every kind a remedy the user can act on', () => {
        for (const kind of kinds) {
            expect(remedyFor(kind).length).toBeGreaterThan(10);
        }
    });
});

describe('detectActionFailure', () => {
    it('reads the declared error field', () => {
        expect(detectActionFailure({ error: 'It broke.' })).toEqual({
            message: 'It broke.',
            kind: 'permanent'
        });
    });

    it('classifies the error it found', () => {
        expect(detectActionFailure({ error: 'Request timed out' })?.kind).toBe('transient');
    });

    it('treats a missing, null, or blank error as success', () => {
        expect(detectActionFailure({ thing: 'ok' })).toBeNull();
        expect(detectActionFailure({ error: null })).toBeNull();
        expect(detectActionFailure({ error: '' })).toBeNull();
        expect(detectActionFailure({ error: '   ' })).toBeNull();
    });

    it('does not let a non-string error slip through as success', () => {
        // A connector returning `{ error: { code: 500 } }` is still a failure.
        expect(detectActionFailure({ error: { code: 500 } })).not.toBeNull();
    });

    it('honours explicit false success flags', () => {
        expect(detectActionFailure({ downloaded: false })?.message).toContain('downloaded = false');
        expect(detectActionFailure({ success: false })).not.toBeNull();
        expect(detectActionFailure({ sent: false })).not.toBeNull();
        // True flags are fine.
        expect(detectActionFailure({ downloaded: true })).toBeNull();
    });

    it('does not treat a prose status field as a failure signal', () => {
        // The old sniff failed a node whose `status` merely contained "error".
        // Only the declared channel counts now.
        expect(detectActionFailure({ status: 'no errors found' })).toBeNull();
    });

    it('survives a non-object result', () => {
        expect(detectActionFailure(null)).toBeNull();
        expect(detectActionFailure(undefined)).toBeNull();
    });
});

describe('retryDelayMs', () => {
    /** Jitter at its extremes and its midpoint. */
    const noJitter = () => 0.5;
    const minJitter = () => 0;
    const maxJitter = () => 1;

    it('grows exponentially from the base delay', () => {
        expect(retryDelayMs(1, noJitter)).toBe(RETRY_BASE_DELAY_MS);
        expect(retryDelayMs(2, noJitter)).toBe(RETRY_BASE_DELAY_MS * 2);
        expect(retryDelayMs(3, noJitter)).toBe(RETRY_BASE_DELAY_MS * 4);
    });

    it('caps the wait', () => {
        expect(retryDelayMs(50, noJitter)).toBe(RETRY_MAX_DELAY_MS);
    });

    it('spreads retries with +/-25% jitter', () => {
        // Without jitter, every node hitting one throttled API retries at the
        // same instant and gets throttled together again.
        expect(retryDelayMs(1, minJitter)).toBe(RETRY_BASE_DELAY_MS * 0.75);
        expect(retryDelayMs(1, maxJitter)).toBe(RETRY_BASE_DELAY_MS * 1.25);
    });

    it('never returns a negative delay', () => {
        expect(retryDelayMs(0, minJitter)).toBeGreaterThanOrEqual(0);
        expect(retryDelayMs(-5, minJitter)).toBeGreaterThanOrEqual(0);
    });

    it('keeps the retry budget small', () => {
        // Two retries at up to 8s is the whole budget; a workflow step should not
        // silently stall a run for minutes.
        expect(MAX_RETRY_ATTEMPTS).toBe(2);
    });
});

describe('NodeExecutionError', () => {
    it('carries the classification and the binding that failed', () => {
        const error = new NodeExecutionError('Slack is down.', {
            kind: 'transient',
            nodeId: 'notify',
            toolId: 'slack',
            toolAction: 'send_message'
        });

        expect(error.name).toBe('NodeExecutionError');
        expect(error.kind).toBe('transient');
        expect(error.retryable).toBe(true);
        expect(error.toolId).toBe('slack');
    });

    it('is not retryable when the kind is not', () => {
        expect(new NodeExecutionError('nope', { kind: 'auth' }).retryable).toBe(false);
    });
});

describe('the failure channel is part of every action contract', () => {
    it('declares an error output on every registered action', () => {
        const missing: string[] = [];
        for (const tool of getAllTools()) {
            for (const action of tool.actions) {
                if (!action.outputKeys.includes(ACTION_ERROR_KEY)) {
                    missing.push(`${tool.id}.${action.name}`);
                }
            }
        }

        // The registry injects it, so a new connector cannot forget to provide a
        // way to report failure.
        expect(missing).toEqual([]);
    });

    it('describes the error field to the planner', () => {
        const action = getAllTools()
            .flatMap(tool => tool.actions)
            .find(a => a.name === 'fetch_page');

        expect(action?.outputSchema[ACTION_ERROR_KEY]?.description).toMatch(/failed/i);
    });
});
