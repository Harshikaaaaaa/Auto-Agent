import { z } from 'zod';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { OAuthError, getAccessToken } from '../oauth/google.js';
import { GOOGLE_OPERATION_NAMES, GOOGLE_OPERATIONS } from './operations.js';

/**
 * The one route through which the browser reaches Google.
 *
 * The browser names an operation from the allowlist and supplies parameters; the
 * server looks up the credential, attaches the bearer token, calls Google, and
 * returns a normalised result. No access token crosses the boundary in either
 * direction.
 */

const requestSchema = z.object({
  operation: z.enum(GOOGLE_OPERATION_NAMES),
  // Validated per operation by its own schema; unknown keys are dropped there.
  params: z.record(z.string(), z.unknown()).optional().default({}),
});

/** Upstream failure carrying the classification the client's error mapper wants. */
function upstreamFailure(status, body) {
  const detail = typeof body === 'string' ? body.slice(0, 300) : '';

  // 401 means the token is bad or expired: reconnecting genuinely helps.
  if (status === 401) {
    return {
      status: 401,
      error: 'google_auth_failed',
      message: 'Google rejected the stored authorization. Reconnect the tool.',
    };
  }
  // 403 is NOT an auth problem — the token was accepted, the request was
  // forbidden. The usual cause is the API not being enabled on the Google
  // Cloud project, or the account lacking access; reconnecting the tool does
  // nothing for either. Surface Google's own reason (its 4xx body describes
  // the caller's mistake and carries no credentials) instead of sending the
  // user into a reconnect loop that cannot fix it.
  if (status === 403) {
    return {
      status: 403,
      error: 'google_forbidden',
      message:
        'Google accepted the sign-in but forbade the request (HTTP 403). This is usually the ' +
        'Gmail/Sheets/Drive API not being enabled on your Google Cloud project, not a bad ' +
        `connection — reconnecting will not help.${detail ? ` Google said: ${detail}` : ''}`,
    };
  }
  if (status === 429) {
    return {
      status: 429,
      error: 'google_rate_limited',
      message: 'Google is rate limiting this account. Try again shortly.',
    };
  }
  if (status === 404) {
    return {
      status: 404,
      error: 'google_not_found',
      message: 'Google could not find that resource. Check the id or range.',
    };
  }
  if (status === 413) {
    return {
      status: 413,
      error: 'google_too_large',
      message: 'That request exceeds the size Google accepts.',
    };
  }
  if (status >= 400 && status < 500) {
    // Google's 4xx messages describe the caller's mistake and contain no
    // credentials, so the first part is useful to surface.
    return {
      status: 400,
      error: 'google_rejected',
      message: `Google rejected the request${detail ? `: ${detail}` : '.'}`,
    };
  }
  return {
    status: 502,
    error: 'google_unavailable',
    message: 'Google returned an error. This is usually temporary.',
  };
}

export function setupGoogleRoutes(app, { fetchImpl = fetch } = {}) {
  app.post('/api/google/call', async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_request',
        message: `operation must be one of: ${GOOGLE_OPERATION_NAMES.join(', ')}.`,
      });
    }

    const operation = GOOGLE_OPERATIONS[parsed.data.operation];
    const params = operation.params.safeParse(parsed.data.params);
    if (!params.success) {
      return res.status(400).json({
        error: 'invalid_params',
        message: `Parameters for ${parsed.data.operation} are not valid.`,
        issues: params.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }

    let accessToken;
    try {
      accessToken = await getAccessToken(req.session.sub, operation.toolId, { fetchImpl });
    } catch (err) {
      if (err instanceof OAuthError) {
        return res.status(err.status).json({ error: err.reason, message: err.message });
      }
      logger.error({ err, toolId: operation.toolId }, 'could not obtain a google access token');
      return res.status(500).json({
        error: 'internal_error',
        message: 'The stored authorization could not be read.',
      });
    }

    const spec = operation.request(params.data);

    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.GOOGLE_API_TIMEOUT_MS);

    let response;
    try {
      response = await fetchImpl(spec.url, {
        method: spec.method,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(spec.rawBody || spec.body ? { 'Content-Type': 'application/json' } : {}),
          ...(spec.headers ?? {}),
        },
        body: spec.rawBody ?? (spec.body ? JSON.stringify(spec.body) : undefined),
      });
    } catch (err) {
      clearTimeout(timer);
      const aborted = err?.name === 'AbortError';
      logger.warn(
        {
          reqId: req.id,
          operation: parsed.data.operation,
          durationMs: Date.now() - startedAt,
          outcome: aborted ? 'timeout' : 'unreachable',
        },
        'google api call failed',
      );
      return res.status(aborted ? 504 : 502).json({
        error: aborted ? 'google_timeout' : 'google_unreachable',
        message: aborted
          ? `Google did not respond within ${env.GOOGLE_API_TIMEOUT_MS}ms.`
          : 'Could not reach Google.',
      });
    } finally {
      clearTimeout(timer);
    }

    const isText = spec.expects === 'text';
    const bodyText = await response.text();

    if (!response.ok) {
      const failure = upstreamFailure(response.status, bodyText);
      logger.warn(
        {
          reqId: req.id,
          operation: parsed.data.operation,
          status: response.status,
          durationMs: Date.now() - startedAt,
          outcome: 'upstream_error',
          // Google's 4xx body is a caller-error description (e.g. "Gmail API
          // has not been used in project N before or it is disabled") and
          // holds no token material, so it is safe and necessary to log for
          // diagnosis. Bounded so a large body cannot flood the log.
          googleDetail: response.status < 500 ? bodyText.slice(0, 300) : undefined,
        },
        'google api returned an error',
      );
      return res.status(failure.status).json({ error: failure.error, message: failure.message });
    }

    // A successful proxied call spends the operator's Google quota and can send
    // mail, so it gets an info-level trace (no response body — that is user data).
    logger.info(
      {
        reqId: req.id,
        operation: parsed.data.operation,
        status: response.status,
        durationMs: Date.now() - startedAt,
        outcome: 'ok',
      },
      'google api call',
    );

    if (isText) {
      return res.json({ result: operation.parse(bodyText) });
    }

    let payload;
    try {
      payload = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return res.status(502).json({
        error: 'google_unexpected_response',
        message: 'Google returned a response that could not be read.',
      });
    }

    return res.json({ result: operation.parse(payload) });
  });
}
