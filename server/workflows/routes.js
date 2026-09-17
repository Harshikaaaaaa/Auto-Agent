import { z } from 'zod';
import { logger } from '../lib/logger.js';
import {
  WorkflowConflictError,
  WorkflowNameTakenError,
  createWorkflow,
  deleteWorkflowById,
  getWorkflowById,
  listWorkflows,
  updateWorkflow,
  upsertWorkflowByName,
} from '../db/workflowRepository.js';
import { listRuns, recordRun } from '../db/runRepository.js';

/**
 * Saved-workflow API, backed by MySQL.
 *
 * Every route is scoped to the caller's session subject, so one operator's ids
 * are never readable or deletable by another. The session guard itself is applied
 * in api.js via WORKFLOW_PATHS.
 */

// ---------------------------------------------------------------- schemas

/**
 * Nodes and edges are passed through as opaque JSON: their shape is the client's
 * concern and pinning it here would break every time the canvas evolves. What is
 * enforced is the envelope — sizes, types, and the fields the server owns.
 */
const nodeSchema = z.object({ id: z.string().min(1).max(200) }).loose();
const edgeSchema = z
  .object({ source: z.string().min(1).max(200), target: z.string().min(1).max(200) })
  .loose();

const workflowBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  nodes: z.array(nodeSchema).max(500),
  edges: z.array(edgeSchema).max(1000).optional().default([]),
  initialState: z.record(z.string(), z.any()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  /** Version the client read. Enables conflict detection on update. */
  version: z.number().int().positive().optional(),
});

const patchBodySchema = workflowBodySchema.partial().extend({
  version: z.number().int().positive().optional(),
});

const runBodySchema = z.object({
  name: z.string().trim().min(1).max(255),
  status: z.enum(['completed', 'failed', 'running', 'cancelled']),
  provider: z.string().max(120).optional(),
  model: z.string().max(120).optional(),
  // Observability fields, all optional so an older client still records a run.
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  nodeCount: z.number().int().nonnegative().max(100_000).optional(),
  failureCount: z.number().int().nonnegative().max(100_000).optional(),
  failureKind: z.string().max(40).optional(),
  error: z.string().max(500).optional(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
});

const idSchema = z.string().uuid();

// ---------------------------------------------------------------- helpers

function validationFailure(res, error) {
  return res.status(400).json({
    error: 'invalid_request',
    message: 'The workflow payload did not match the expected shape.',
    issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

/** The owner for the current request. Guaranteed by requireSession upstream. */
function ownerOf(req) {
  return req.session?.sub ?? 'unknown';
}

/**
 * Wrap a handler so repository errors become the right status codes and an
 * unexpected failure never leaks a stack trace or SQL to the client.
 */
function handle(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof WorkflowConflictError) {
        return res.status(409).json({
          error: 'version_conflict',
          message: err.message,
          currentVersion: err.currentVersion,
        });
      }
      if (err instanceof WorkflowNameTakenError) {
        return res.status(409).json({ error: 'name_taken', message: err.message });
      }
      // A dropped database connection should read as "try again", not "bad request".
      if (err?.code === 'ECONNREFUSED' || err?.code === 'PROTOCOL_CONNECTION_LOST') {
        logger.error({ err }, 'database unavailable');
        return res.status(503).json({
          error: 'database_unavailable',
          message: 'The database is not reachable right now.',
          retryable: true,
        });
      }
      logger.error({ err, path: req.originalUrl }, 'workflow route failed');
      return res.status(500).json({ error: 'internal_error', message: 'Something went wrong.' });
    }
  };
}

// ---------------------------------------------------------------- routes

export function setupWorkflowRoutes(app) {
  /** List the caller's workflows. */
  app.get(
    '/api/workflows',
    handle(async (req, res) => {
      const workflows = await listWorkflows(ownerOf(req));
      res.json(workflows);
    }),
  );

  // NOTE: the two /runs GET routes are registered BEFORE `/api/workflows/:id`
  // on purpose. Express matches in registration order, and `runs` would
  // otherwise be captured by `:id` and rejected as a malformed uuid.

  /** Recent runs across all of the caller's workflows, most recent first. */
  app.get(
    '/api/workflows/runs',
    handle(async (req, res) => {
      const limit = Number(req.query.limit);
      const runs = await listRuns(ownerOf(req), {
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ runs });
    }),
  );

  /** Run history for one workflow, scoped to the caller. */
  app.get(
    '/api/workflows/:id/runs',
    handle(async (req, res) => {
      const parsedId = idSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        return res.status(400).json({ error: 'invalid_id', message: 'That is not a workflow id.' });
      }

      // Confirm the workflow exists and belongs to the caller before listing,
      // so a probe for another owner's id returns 404, not an empty list.
      const workflow = await getWorkflowById(ownerOf(req), parsedId.data);
      if (!workflow) {
        return res.status(404).json({ error: 'not_found', message: 'No such workflow.' });
      }

      const limit = Number(req.query.limit);
      const runs = await listRuns(ownerOf(req), {
        workflowId: parsedId.data,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ runs });
    }),
  );

  /** Fetch one workflow by id. */
  app.get(
    '/api/workflows/:id',
    handle(async (req, res) => {
      const parsedId = idSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        return res.status(400).json({ error: 'invalid_id', message: 'That is not a workflow id.' });
      }

      const workflow = await getWorkflowById(ownerOf(req), parsedId.data);
      if (!workflow) {
        return res.status(404).json({ error: 'not_found', message: 'No such workflow.' });
      }
      return res.json(workflow);
    }),
  );

  /**
   * Save a workflow.
   *
   * Upsert by name, because that is what the canvas "Save" button means: the user
   * names a workflow and expects saving again to replace it. This is a single
   * atomic statement, so concurrent saves of different workflows cannot lose each
   * other — the failure mode of the old whole-file JSON rewrite.
   */
  app.post(
    '/api/workflows',
    handle(async (req, res) => {
      const parsed = workflowBodySchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { version: _ignoredVersion, ...input } = parsed.data;
      const workflow = await upsertWorkflowByName(ownerOf(req), input);
      return res.status(200).json(workflow);
    }),
  );

  /** Create a workflow, failing if the name is taken. */
  app.post(
    '/api/workflows/create',
    handle(async (req, res) => {
      const parsed = workflowBodySchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { version: _ignoredVersion, ...input } = parsed.data;
      const workflow = await createWorkflow(ownerOf(req), input);
      return res.status(201).json(workflow);
    }),
  );

  /** Update a workflow by id, with optimistic locking. */
  app.put(
    '/api/workflows/:id',
    handle(async (req, res) => {
      const parsedId = idSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        return res.status(400).json({ error: 'invalid_id', message: 'That is not a workflow id.' });
      }

      const parsed = patchBodySchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { version, ...input } = parsed.data;
      const workflow = await updateWorkflow(ownerOf(req), parsedId.data, input, version);
      if (!workflow) {
        return res.status(404).json({ error: 'not_found', message: 'No such workflow.' });
      }
      return res.json(workflow);
    }),
  );

  /** Delete a workflow by id. */
  app.delete(
    '/api/workflows/:id',
    handle(async (req, res) => {
      const parsedId = idSchema.safeParse(req.params.id);
      if (!parsedId.success) {
        return res.status(400).json({ error: 'invalid_id', message: 'That is not a workflow id.' });
      }

      const deleted = await deleteWorkflowById(ownerOf(req), parsedId.data);
      if (!deleted) {
        return res.status(404).json({ error: 'not_found', message: 'No such workflow.' });
      }
      return res.status(204).end();
    }),
  );

  /** Record the outcome of a run as its own row in the run-history table. */
  app.post(
    '/api/workflows/runs',
    handle(async (req, res) => {
      const parsed = runBodySchema.safeParse(req.body);
      if (!parsed.success) return validationFailure(res, parsed.error);

      const { name, ...run } = parsed.data;
      const record = await recordRun(ownerOf(req), name, run);
      if (!record) {
        return res.status(404).json({ error: 'not_found', message: 'No such workflow.' });
      }
      return res.status(201).json({ run: record });
    }),
  );
}
