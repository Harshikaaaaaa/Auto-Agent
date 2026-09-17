import type { Workflow } from '@features/workflow/types';
import { findReusableToolTemplate, getAllTools } from '@features/tools/toolRegistry';

/**
 * Client-side normalisation of a model-generated workflow.
 *
 * This runs in the browser rather than on the server because it needs the live
 * tool registry (which tools are registered and authenticated right now). It was
 * previously duplicated inside each provider service; the provider calls moved
 * server-side, so the shared post-processing lives here once.
 */

/** Ensure the top-level shape is usable, repairing what can be repaired. */
export function normalizeWorkflowShape(raw: unknown): Workflow {
  const workflow = (raw ?? {}) as Workflow;

  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    throw new Error('The model did not return a valid workflow (missing nodes array).');
  }
  if (!workflow.edges || !Array.isArray(workflow.edges)) {
    workflow.edges = [];
  }

  // Some models return nested objects as JSON strings.
  if (typeof workflow.initialState === 'string') {
    try {
      workflow.initialState = JSON.parse(workflow.initialState);
    } catch {
      workflow.initialState = {};
    }
  }
  if (!workflow.initialState || typeof workflow.initialState !== 'object') {
    workflow.initialState = {};
  }

  for (const node of workflow.nodes) {
    if (node.data?.stateContract && typeof node.data.stateContract === 'string') {
      try {
        node.data.stateContract = JSON.parse(node.data.stateContract);
      } catch {
        node.data.stateContract = { inputKeys: [], outputKeys: [] };
      }
    }
    if (node.data?.routerConfig && typeof node.data.routerConfig === 'string') {
      try {
        node.data.routerConfig = JSON.parse(node.data.routerConfig);
      } catch {
        node.data.routerConfig = undefined;
      }
    }
  }

  return workflow;
}

/**
 * Bind nodes to registered tool actions where the intent is unambiguous.
 *
 * Only ever binds to a tool that is actually registered — it cannot invent one.
 * A node left unbound falls through to the generic AI path at run time, which is
 * the honest outcome when no tool matches.
 *
 * DEAD PATH — do not wire this back up. This is keyword substitution: it binds a
 * tool because the node's label happens to contain a word. That is the mechanism
 * behind the reported defect, where a request for a downloadable Markdown file
 * became "Save results to Google Sheets". The only supported route is now the
 * planner in `workflowPlanGenerator.ts`, which validates every binding against
 * the catalog and marks a gap unsupported instead of guessing. Reachable only
 * from the legacy `generateWorkflow` helpers, which nothing in the UI calls;
 * Task 11 removes them along with the second execution engine.
 */
export function bindNodesToRegisteredTools(workflow: Workflow): Workflow {
  const registeredTools = getAllTools();

  for (const node of workflow.nodes) {
    if (node.type === 'output' || node.type === 'trigger') continue;
    if (node.data.toolId && node.data.toolAction) continue;

    const text = `${node.data.label ?? ''} ${node.data.description ?? ''}`.toLowerCase();

    const builtInMatch = findReusableToolTemplate(text);
    if (builtInMatch) {
      node.data.toolId = builtInMatch.toolId;
      node.data.toolAction = builtInMatch.toolAction;
      node.type = 'tool';
      node.data.type = 'tool' as never;
      node.data.stateContract = {
        inputKeys: builtInMatch.inputKeys,
        outputKeys: builtInMatch.outputKeys,
      };
      continue;
    }

    for (const tool of registeredTools) {
      const mentionsTool = [tool.name.toLowerCase(), tool.id.toLowerCase()].some((kw) =>
        text.includes(kw),
      );
      if (!mentionsTool) continue;

      for (const action of tool.actions) {
        const actionWords = action.name.replace(/_/g, ' ').toLowerCase();
        if (text.includes(actionWords) || text.includes(action.name)) {
          node.data.toolId = tool.id;
          node.data.toolAction = action.name;
          node.type = 'tool';
          node.data.type = 'tool' as never;
          if (!node.data.stateContract) {
            node.data.stateContract = {
              inputKeys: action.inputKeys,
              outputKeys: action.outputKeys,
            };
          }
          break;
        }
      }

      if (node.data.toolId) break;
    }
  }

  return workflow;
}

/** Normalise then bind, the standard post-processing for a generated workflow. */
export function normalizeGeneratedWorkflow(raw: unknown): Workflow {
  return bindNodesToRegisteredTools(normalizeWorkflowShape(raw));
}
