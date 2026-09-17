import { z } from 'zod';
import { publicAiConfig } from '../config/env.js';
import {
  ProviderError,
  callProviderForJson,
  probeConfiguredModel,
  resolveProvider,
  defaultModelFor,
} from './providers.js';
import {
  buildConnectorPrompt,
  buildNodeExecutionPrompt,
  buildPatchPrompt,
  buildPlanPrompt,
  buildWorkflowPrompt,
} from './prompts.js';

/**
 * AI backend-for-frontend routes.
 *
 * The browser never holds a provider key. It posts structured data here and the
 * server owns the prompt, the credential, and the provider call.
 */

// ---------------------------------------------------------------- schemas

const catalogActionSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().default(''),
  inputKeys: z.array(z.string().max(120)).max(50).optional().default([]),
  outputKeys: z.array(z.string().max(120)).max(50).optional().default([]),
  sideEffect: z.enum(['read', 'write', 'irreversible']).optional(),
});

const catalogToolSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().default(''),
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
});

// Node execution carries live workflow state, which can be large.
const jsonValue = z.any();

const nodeRequestSchema = z.object({
  nodeLabel: z.string().min(1).max(300),
  nodeDescription: z.string().max(4_000).optional().default(''),
  inputState: z.record(z.string(), jsonValue).optional().default({}),
  outputKeys: z.array(z.string().min(1).max(120)).min(1).max(50),
  context: z
    .object({
      originalPrompt: z.string().max(8_000).optional().default(''),
      fullGraphState: z.record(z.string(), jsonValue).optional().default({}),
      executionHistory: z
        .array(
          z.object({
            nodeLabel: z.string().max(300),
            outputKeys: z.array(z.string().max(120)).max(50).optional().default([]),
            outputSummary: z.string().max(20_000).optional().default(''),
          }),
        )
        .max(200)
        .optional()
        .default([]),
    })
    .optional(),
  provider: providerHintSchema,
  model: modelSchema,
});

const workflowRequestSchema = z.object({
  prompt: z.string().min(1).max(8_000),
  catalog: catalogSchema,
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
 * Wrap an async route so provider errors become clean HTTP responses and
 * unexpected errors never leak internals (a stack could contain a key).
 */
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ProviderError) {
        return res.status(err.status).json({
          error: 'provider_error',
          provider: err.provider,
          retryable: err.retryable,
          message: err.message,
        });
      }
      // eslint-disable-next-line no-console
      console.error('[ai] Unexpected route error:', err);
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

      const { prompt, catalog, hints, provider, model } = parsed.data;
      const result = await callProviderForJson({
        prompt: buildPlanPrompt({ prompt, catalog, hints }),
        provider,
        model,
      });

      res.json({
        plan: result.json,
        meta: { provider: result.provider, model: result.model, attempts: result.attempts },
      });
    }),
  );

  app.post(
    '/api/ai/patch',
    handle(async (req, res) => {
      const parsed = patchRequestSchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { message, graph, catalog, provider, model } = parsed.data;
      const result = await callProviderForJson({
        prompt: buildPatchPrompt({ message, graph, catalog }),
        provider,
        model,
      });

      res.json({
        patch: result.json,
        meta: { provider: result.provider, model: result.model, attempts: result.attempts },
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
      const result = await callProviderForJson({
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
        meta: { provider: result.provider, model: result.model, attempts: result.attempts },
      });
    }),
  );

  /** LEGACY: whole-graph generation. Superseded by /api/ai/plan (Task 8). */
  app.post(
    '/api/ai/workflow',
    handle(async (req, res) => {
      const parsed = workflowRequestSchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { prompt, catalog, provider, model } = parsed.data;
      const result = await callProviderForJson({
        prompt: buildWorkflowPrompt({ prompt, catalog }),
        provider,
        model,
      });

      res.json({
        workflow: result.json,
        meta: { provider: result.provider, model: result.model, attempts: result.attempts },
      });
    }),
  );

  app.post(
    '/api/ai/connector',
    handle(async (req, res) => {
      const parsed = connectorRequestSchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { toolName, toolDescription, requiredActions, provider, model } = parsed.data;
      const result = await callProviderForJson({
        prompt: buildConnectorPrompt({ toolName, toolDescription, requiredActions }),
        provider,
        model,
      });

      res.json({
        connector: result.json,
        meta: { provider: result.provider, model: result.model, attempts: result.attempts },
      });
    }),
  );
}

export { resolveProvider, defaultModelFor };
