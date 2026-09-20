import { z } from 'zod';
import crypto from 'crypto';
import { publicAiConfig } from '../config/env.js';
import { logger } from '../lib/logger.js';
import {
  ProviderError,
  callProviderForJson,
  probeConfiguredModel,
  resolveProvider,
  defaultModelFor,
} from './providers.js';
import {
  ModelAccessError,
  reserveForRequest,
  reconcile,
  releaseForRequest,
} from '../billing/billingService.js';
import { InsufficientCreditsError } from '../db/walletRepository.js';
import {
  buildConnectorPrompt,
  buildNodeExecutionPrompt,
  buildPatchPrompt,
  buildPlanPrompt,
} from './prompts.js';

/**
 * AI backend-for-frontend routes.
 *
 * The browser never holds a provider key. It posts structured data here and the
 * server owns the prompt, the credential, and the provider call.
 */

// ---------------------------------------------------------------- schemas

/** One declared input or output field of an action. */
const catalogFieldSchema = z.object({
  name: z.string().min(1).max(120),
  type: z.string().max(40).optional().default('string'),
  description: z.string().max(500).optional().default(''),
  required: z.boolean().optional().default(false),
  /** Must be supplied by the user; cannot come from an earlier step. */
  external: z.boolean().optional().default(false),
  format: z.string().max(40).optional(),
  enum: z.array(z.string().max(120)).max(40).optional(),
});

const catalogActionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional().default(''),
  capabilities: z.array(z.string().max(120)).max(20).optional().default([]),
  sideEffect: z.enum(['read', 'write', 'irreversible']).optional(),
  requiresAuth: z.boolean().optional(),
  requiresApproval: z.boolean().optional(),
  inputs: z.array(catalogFieldSchema).max(60).optional().default([]),
  outputs: z.array(catalogFieldSchema).max(60).optional().default([]),
  // Flat key lists, still accepted for callers that only send those.
  inputKeys: z.array(z.string().max(120)).max(60).optional().default([]),
  outputKeys: z.array(z.string().max(120)).max(60).optional().default([]),
});

const catalogToolSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(''),
  category: z.string().max(80).optional(),
  capabilities: z.array(z.string().max(120)).max(50).optional().default([]),
  authenticated: z.boolean().optional(),
  actions: z.array(catalogActionSchema).max(60).optional().default([]),
});

const catalogSchema = z.array(catalogToolSchema).max(100).optional().default([]);

const providerHintSchema = z.enum(['auto', 'openrouter', 'gemini', 'ollama']).optional();

// A pinned model is accepted but constrained: it is echoed into an upstream URL
// path for Gemini, so it must not contain path or protocol characters.
const modelSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:\-/]+$/, 'model contains unsupported characters')
  .optional();

const planRequestSchema = z.object({
  prompt: z.string().min(1).max(8_000),
  catalog: catalogSchema,
  hints: z
    .array(
      z.object({
        toolId: z.string().max(120),
        actionName: z.string().max(120),
        score: z.number().finite(),
      }),
    )
    .max(20)
    .optional()
    .default([]),
  provider: providerHintSchema,
  model: modelSchema,
  /**
   * Why the previous attempt was rejected. Sent on a retry so the model is told
   * what to fix rather than being asked the same question twice.
   */
  repairFeedback: z.string().max(2000).optional(),
});

const patchRequestSchema = z.object({
  message: z.string().min(1).max(4_000),
  graph: z.object({
    nodes: z
      .array(
        z.object({
          id: z.string().min(1).max(200),
          label: z.string().max(300).optional().default(''),
          type: z.string().max(60).optional().default(''),
          toolId: z.string().max(120).nullish(),
          toolAction: z.string().max(120).nullish(),
        }),
      )
      .max(200),
    edges: z
      .array(
        z.object({
          source: z.string().min(1).max(200),
          target: z.string().min(1).max(200),
          condition: z.string().max(500).nullish(),
        }),
      )
      .max(400)
      .optional()
      .default([]),
  }),
  catalog: catalogSchema,
  provider: providerHintSchema,
  model: modelSchema,
  /** Why the previous attempt was rejected. See `planRequestSchema`. */
  repairFeedback: z.string().max(2000).optional(),
});

// Node execution carries live workflow state, which can be large.
const jsonValue = z.any();

// Node execution carries live workflow state — a whole scraped page, its
// extracted text, prior node outputs — which is legitimately large. The string
// fields below are therefore NOT length-capped: an AI node must accept any input
// the workflow produces (matching n8n), with the only real ceiling being the AI
// provider's own token limit and the overall JSON_BODY_LIMIT. A cap here surfaced
// as a confusing "request body did not match the expected shape" node failure.
const nodeRequestSchema = z.object({
  nodeLabel: z.string().min(1).max(300),
  nodeDescription: z.string().optional().default(''),
  inputState: z.record(z.string(), jsonValue).optional().default({}),
  outputKeys: z.array(z.string().min(1).max(120)).min(1).max(50),
  context: z
    .object({
      originalPrompt: z.string().optional().default(''),
      fullGraphState: z.record(z.string(), jsonValue).optional().default({}),
      executionHistory: z
        .array(
          z.object({
            nodeLabel: z.string().max(300),
            outputKeys: z.array(z.string().max(120)).max(50).optional().default([]),
            outputSummary: z.string().optional().default(''),
          }),
        )
        .max(500)
        .optional()
        .default([]),
    })
    .optional(),
  provider: providerHintSchema,
  model: modelSchema,
});

const connectorRequestSchema = z.object({
  toolName: z.string().min(1).max(200),
  toolDescription: z.string().max(2_000).optional().default(''),
  requiredActions: z.array(z.string().max(200)).max(50).optional().default([]),
  provider: providerHintSchema,
  model: modelSchema,
});

// ---------------------------------------------------------------- helpers

function validationFailure(res, error) {
  return res.status(400).json({
    error: 'invalid_request',
    message: 'The request body did not match the expected shape.',
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/**
 * Time and log a provider call.
 *
 * These are the app's most expensive and most failure-prone operations, so each
 * one gets a structured log line: which route, provider, and model; how long it
 * took; how many attempts; and whether it succeeded — correlated by the request
 * id. Deliberately logs NO prompt and NO completion text: those can carry user
 * data or model output, and the point is an operational trace, not a transcript.
 */
async function observeAiCall(req, kind, args) {
  const startedAt = Date.now();
  try {
    const result = await callProviderForJson(args);
    logger.info(
      {
        reqId: req.id,
        aiCall: kind,
        provider: result.provider,
        model: result.model,
        attempts: result.attempts,
        durationMs: Date.now() - startedAt,
        // Token counts only — never prompt or completion text. Safe to log and
        // needed to trace what the billing engine will charge for.
        inputTokens: result.usage?.inputTokens,
        cachedInputTokens: result.usage?.cachedInputTokens,
        outputTokens: result.usage?.outputTokens,
        reasoningTokens: result.usage?.reasoningTokens,
        providerCostUsdMicros: result.usage?.providerCostUsdMicros,
        outcome: 'ok',
      },
      'ai provider call',
    );
    return result;
  } catch (err) {
    logger.warn(
      {
        reqId: req.id,
        aiCall: kind,
        provider: err?.provider ?? args.provider ?? 'default',
        durationMs: Date.now() - startedAt,
        status: err?.status,
        retryable: err?.retryable,
        outcome: 'error',
      },
      'ai provider call failed',
    );
    throw err;
  }
}

/**
 * RESERVE -> EXECUTE -> RECONCILE around a billable AI call.
 *
 * Resolves the provider + model up front (both known before the HTTP call, so
 * the reserve can price against the right rate). If the model has no rate-card
 * row, billing is not configured for it and the call proceeds UNBILLED — this
 * keeps a fresh/dev setup working and never blocks on a missing rate. When a
 * rate exists: check access + balance, hold the worst-case cost, call, then
 * reconcile to the actual usage (releasing the remainder), or release the whole
 * hold if the call failed before producing billable usage.
 *
 * Billing is skipped entirely when there is no real owner (auth disabled /
 * dev session), so local development is unaffected.
 */
async function billedAiCall(req, kind, args) {
  const ownerId = req.session?.sub;
  const billable = ownerId && !req.session?.authDisabled;

  if (!billable) return observeAiCall(req, kind, args);

  const provider = resolveProvider(args.provider);
  const model = args.model || defaultModelFor(provider);
  const requestId = `${req.id ?? crypto.randomUUID()}:${kind}`;

  let rate;
  try {
    ({ rate } = await reserveForRequest({ ownerId, provider, model, requestId }));
  } catch (err) {
    if (err instanceof ModelAccessError || err instanceof InsufficientCreditsError) throw err;
    // No rate row (or a billing read failed): proceed UNBILLED rather than
    // block a call the operator has not priced yet.
    logger.warn({ err, provider, model }, 'billing reserve skipped; proceeding unbilled');
    return observeAiCall(req, kind, args);
  }

  try {
    const result = await observeAiCall(req, kind, args);
    // Reconcile against the ACTUAL usage the provider reported.
    const usage = result.usage ?? { provider, model, providerCostUsdMicros: 0 };
    const { creditsCharged } = await reconcile({ ownerId, requestId, usage, rate });
    // Surface the charge so the UI can show "used N credits".
    result.creditsCharged = creditsCharged;
    return result;
  } catch (err) {
    // The call failed before billable usage: free the hold, charge nothing.
    await releaseForRequest({
      ownerId,
      requestId,
      provider,
      model,
      errorCode: err?.code ?? (err instanceof ProviderError ? 'provider_error' : 'error'),
    }).catch((releaseErr) =>
      logger.warn({ err: releaseErr, requestId }, 'failed to release reservation'),
    );
    throw err;
  }
}

/**
 * Wrap an async route so provider errors become clean HTTP responses and
 * unexpected errors never leak internals (a stack could contain a key).
 */
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof InsufficientCreditsError) {
        return res.status(402).json({ error: 'insufficient_credits', message: err.message });
      }
      if (err instanceof ModelAccessError) {
        return res.status(403).json({ error: 'model_not_allowed', message: err.message });
      }
      if (err instanceof ProviderError) {
        return res.status(err.status).json({
          error: 'provider_error',
          provider: err.provider,
          retryable: err.retryable,
          message: err.message,
        });
      }
      logger.error({ err, path: req.originalUrl }, 'unexpected AI route error');
      return res.status(500).json({
        error: 'internal_error',
        message: 'The AI service failed to handle this request.',
      });
    }
  };
}

// ---------------------------------------------------------------- routes

export function setupAiRoutes(app) {
  /** Which providers are usable, and whether the configured model resolves. */
  app.get(
    '/api/ai/health',
    handle(async (_req, res) => {
      const probe = await probeConfiguredModel();
      res.json({ ...publicAiConfig(), modelProbe: probe });
    }),
  );

  /** Non-secret AI config so the UI can offer only usable providers. */
  app.get('/api/ai/config', (_req, res) => {
    res.json(publicAiConfig());
  });

  app.post(
    '/api/ai/plan',
    handle(async (req, res) => {
      const parsed = planRequestSchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { prompt, catalog, hints, provider, model, repairFeedback } = parsed.data;
      const result = await billedAiCall(req, 'plan', {
        prompt: buildPlanPrompt({ prompt, catalog, hints, repairFeedback }),
        provider,
        model,
      });

      res.json({
        plan: result.json,
        meta: {
          provider: result.provider,
          model: result.model,
          attempts: result.attempts,
          creditsCharged: result.creditsCharged,
        },
      });
    }),
  );

  app.post(
    '/api/ai/patch',
    handle(async (req, res) => {
      const parsed = patchRequestSchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { message, graph, catalog, provider, model, repairFeedback } = parsed.data;
      const result = await billedAiCall(req, 'patch', {
        prompt: buildPatchPrompt({ message, graph, catalog, repairFeedback }),
        provider,
        model,
      });

      res.json({
        patch: result.json,
        meta: {
          provider: result.provider,
          model: result.model,
          attempts: result.attempts,
          creditsCharged: result.creditsCharged,
        },
      });
    }),
  );

  app.post(
    '/api/ai/node',
    handle(async (req, res) => {
      const parsed = nodeRequestSchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { nodeLabel, nodeDescription, inputState, outputKeys, context, provider, model } =
        parsed.data;
      const result = await billedAiCall(req, 'node', {
        prompt: buildNodeExecutionPrompt({
          nodeLabel,
          nodeDescription,
          inputState,
          outputKeys,
          context,
        }),
        provider,
        model,
      });

      res.json({
        output: result.json,
        meta: {
          provider: result.provider,
          model: result.model,
          attempts: result.attempts,
          creditsCharged: result.creditsCharged,
        },
      });
    }),
  );

  app.post(
    '/api/ai/connector',
    handle(async (req, res) => {
      const parsed = connectorRequestSchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { toolName, toolDescription, requiredActions, provider, model } = parsed.data;
      const result = await billedAiCall(req, 'connector', {
        prompt: buildConnectorPrompt({ toolName, toolDescription, requiredActions }),
        provider,
        model,
      });

      res.json({
        connector: result.json,
        meta: {
          provider: result.provider,
          model: result.model,
          attempts: result.attempts,
          creditsCharged: result.creditsCharged,
        },
      });
    }),
  );
}

export { resolveProvider, defaultModelFor };
