import { useState, useCallback, useRef } from 'react';
import { Node, Edge } from 'reactflow';
import { ExecutionLog, FlowEdge, GraphState, WorkflowNode } from '@features/workflow/types';
import { executeNodeAction } from '@features/ai/services/aiService';
import { WorkflowContextBuffer } from '@features/ai/types';
import {
  actionRequiresApproval,
  findActionsByCapability,
  getActionSideEffect,
  getTool,
} from '@features/tools/toolRegistry';
import { evaluateCondition as evaluateSafeCondition } from '@features/workflow/services/safeExpression';
import { missingExternalInputs } from '@features/workflow/services/externalInputs';
import {
  MAX_RETRY_ATTEMPTS,
  NodeExecutionError,
  UNSUPPORTED_STEP_PREFIX,
  classifyFailureMessage,
  detectActionFailure,
  isRetryable,
  remedyFor,
  retryDelayMs,
  type FailureKind,
} from '@features/workflow/services/nodeFailure';
import '@features/tools/connectors'; // ensure all tools are registered

/**
 * The outcome of a run, returned by executeFlow so the caller can report it in
 * the chat without racing React state. `logs` is the per-node record: which
 * step ran, whether it passed or failed, what it produced, and why it failed.
 */
export interface RunSummary {
  status: 'completed' | 'failed' | 'paused' | 'cancelled';
  logs: ExecutionLog[];
}

const EXECUTION_CHECKPOINT_KEY = 'autoagent_runtime_checkpoint';

/**
 * Other registered actions that provide the same capability as the one that just
 * failed, best first.
 *
 * SUGGESTED, never substituted. Automatically rerouting a failed `chat.send`
 * from Slack to WhatsApp, or a failed `email.send` to a chat tool, would be the
 * same wrong-tool substitution that Tasks 8 and 10 removed from planning and
 * chat editing: the user asked for a specific destination, and "resilience" that
 * silently delivers somewhere else is worse than a clear failure. So the
 * alternatives are named in the log for a human to choose.
 */
function alternativeProvidersFor(toolId?: string, actionName?: string): string[] {
  if (!toolId || !actionName) return [];
  const action = getTool(toolId)?.actions.find((a) => a.name === actionName);
  if (!action) return [];

  const alternatives = new Set<string>();
  for (const capability of action.capabilities) {
    for (const candidate of findActionsByCapability(capability)) {
      if (candidate.toolId === toolId && candidate.action.name === actionName) continue;
      alternatives.add(`${candidate.toolId}.${candidate.action.name}`);
    }
  }
  return Array.from(alternatives);
}

type RuntimeExecutionCheckpoint = {
  runId: string;
  status: 'running' | 'paused' | 'failed' | 'completed';
  currentNodeId: string | null;
  completedNodeIds: string[];
  executedSignatures: string[];
  graphState: GraphState;
  startedAt: string;
  lastUpdatedAt: string;
  nodesSnapshot: Array<{ id: string; label: string; type?: string }>;
  edgesSnapshot: Array<{ id: string; source: string; target: string; condition?: string }>;
};

function saveRuntimeCheckpoint(checkpoint: RuntimeExecutionCheckpoint) {
  try {
    localStorage.setItem(EXECUTION_CHECKPOINT_KEY, JSON.stringify(checkpoint));
  } catch (err) {
    console.warn('[WorkflowExecution] Failed to persist checkpoint:', err);
  }
}

function loadRuntimeCheckpoint(): RuntimeExecutionCheckpoint | null {
  try {
    const raw = localStorage.getItem(EXECUTION_CHECKPOINT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RuntimeExecutionCheckpoint;
    if (!parsed || !parsed.graphState || !parsed.runId) return null;
    return parsed;
  } catch (err) {
    console.warn('[WorkflowExecution] Failed to restore checkpoint:', err);
    return null;
  }
}

function clearRuntimeCheckpoint() {
  try {
    localStorage.removeItem(EXECUTION_CHECKPOINT_KEY);
  } catch (err) {
    console.warn('[WorkflowExecution] Failed to clear checkpoint:', err);
  }
}

/**
 * Evaluates an edge condition against graph state.
 *
 * Delegates to the restricted expression evaluator. This previously used
 * `new Function`, which executed stored conditions as real JavaScript — and
 * workflows load from shared server storage, so that was remote code execution
 * in the browser. See `safeExpression.ts`.
 *
 * Returns true when no condition is specified (unconditional edge), and false
 * when a condition cannot be parsed or evaluated (fail closed).
 */
function evaluateCondition(condition: string | undefined, state: Record<string, any>): boolean {
  return evaluateSafeCondition(condition, state);
}

/**
 * Merges a node's output into the graph state using the specified reducer strategy.
 */
function mergeIntoState(
  state: GraphState,
  output: Record<string, any>,
  reducer: 'overwrite' | 'append' | 'merge' = 'overwrite',
): GraphState {
  const newState = { ...state };

  for (const [key, value] of Object.entries(output)) {
    if (key === '__metadata') continue; // protect metadata

    switch (reducer) {
      case 'append': {
        const existing = newState[key];
        newState[key] = Array.isArray(existing)
          ? [...existing, value]
          : existing !== undefined
            ? [existing, value]
            : [value];
        break;
      }

      case 'merge':
        if (
          typeof newState[key] === 'object' &&
          typeof value === 'object' &&
          !Array.isArray(value)
        ) {
          newState[key] = { ...newState[key], ...value };
        } else {
          newState[key] = value;
        }
        break;

      case 'overwrite':
      default:
        newState[key] = value;
        break;
    }
  }

  return newState;
}

export const useWorkflowExecution = (
  nodes: Node[],
  edges: FlowEdge[],
  setNodes: (nodes: Node[] | ((nodes: Node[]) => Node[])) => void,
  onApprovalRequired?: (payload: {
    nodeId: string;
    nodeLabel: string;
    message: string;
  }) => Promise<boolean>,
) => {
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([]);
  const [graphState, setGraphState] = useState<GraphState | null>(null);
  const [currentNodeId, setCurrentNodeId] = useState<string | null>(null);
  const [currentNodeLabel, setCurrentNodeLabel] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<
    'idle' | 'running' | 'paused' | 'cancelled' | 'completed' | 'failed'
  >('idle');
  const executionControlRef = useRef({
    pauseRequested: false,
    cancelRequested: false,
    retryCounts: {} as Record<string, number>,
    executedSignatures: new Set<string>(),
  });

  // Mirrors executionLogs synchronously so executeFlow can return the complete
  // run report at the moment it finishes, without waiting for a React re-render.
  const runLogsRef = useRef<ExecutionLog[]>([]);
  const appendLog = useCallback((entry: ExecutionLog) => {
    runLogsRef.current = [...runLogsRef.current, entry];
    setExecutionLogs((prev) => [...prev, entry]);
  }, []);

  const pauseExecution = useCallback(() => {
    executionControlRef.current.pauseRequested = true;
    setRuntimeStatus('paused');
  }, []);

  const resumeExecution = useCallback(() => {
    executionControlRef.current.pauseRequested = false;
    setRuntimeStatus('running');
  }, []);

  const cancelExecution = useCallback(() => {
    executionControlRef.current.cancelRequested = true;
    setRuntimeStatus('cancelled');
  }, []);

  const executeFlow = useCallback(async (): Promise<RunSummary> => {
    if (nodes.length === 0) {
      return { status: 'completed', logs: [] };
    }

    // ── Pre-flight: values no step can produce ──
    //
    // An external input is one nothing upstream writes: a spreadsheet id, a
    // target URL, a recipient. Starting a run without one means the first few
    // steps do real work and then the bound action fails on an empty field,
    // several nodes and one confusing error later. Checked here so the run
    // never starts.
    const availableAtStart = new Set<string>();
    nodes.forEach((node) => {
      if (node.data.initialState && typeof node.data.initialState === 'object') {
        Object.keys(node.data.initialState).forEach((key) => availableAtStart.add(key));
      }
    });

    const missing = missingExternalInputs(nodes as unknown as WorkflowNode[], availableAtStart);

    if (missing.length > 0) {
      const detail = missing.map((item) => `${item.label} needs "${item.key}"`).join('; ');
      const failLog: ExecutionLog = {
        node: missing[0].label,
        time: new Date().toLocaleTimeString(),
        output:
          `Cannot start: ${missing.length === 1 ? 'a required value is' : 'required values are'} ` +
          `missing. ${detail}. Fill these in on the step, then run again.`,
        status: 'failed',
        failureKind: 'invalid_input',
      };
      runLogsRef.current = [failLog];
      setExecutionLogs([failLog]);
      setRuntimeStatus('failed');
      setIsExecuting(false);
      return { status: 'failed', logs: runLogsRef.current };
    }

    const restoredCheckpoint = loadRuntimeCheckpoint();
    const canResume =
      restoredCheckpoint &&
      restoredCheckpoint.status !== 'completed' &&
      restoredCheckpoint.status !== 'failed';
    const restoredCompleted = new Set(canResume ? restoredCheckpoint.completedNodeIds || [] : []);

    executionControlRef.current = {
      pauseRequested: false,
      cancelRequested: false,
      retryCounts: {},
      executedSignatures: new Set<string>(),
    };

    // Only carry executed signatures forward when we are genuinely RESUMING a
    // paused run. A leftover checkpoint from a run that FAILED (or a fresh run
    // that happens to find stale state) must not pre-seed these: doing so makes
    // every already-run node match its old signature and get skipped, so a
    // retry — e.g. re-running with a corrected URL — silently executes zero
    // nodes and reports "all 0 steps passed".
    if (canResume && restoredCheckpoint?.executedSignatures?.length) {
      restoredCheckpoint.executedSignatures.forEach((sig) =>
        executionControlRef.current.executedSignatures.add(sig),
      );
    }
    setRuntimeStatus('running');
    setIsExecuting(true);
    setExecutionLogs([]);
    runLogsRef.current = [];

    // Initialize GraphState
    // Check if the workflow provided initialState via the first node's data
    const initialData: Record<string, any> = {};

    // Gather any initialState from nodes (stored during generation)
    nodes.forEach((n) => {
      if (n.data.initialState) {
        Object.assign(initialData, n.data.initialState);
      }
    });

    let state: GraphState =
      canResume && restoredCheckpoint
        ? restoredCheckpoint.graphState
        : {
            ...initialData,
            __metadata: {
              runId: crypto.randomUUID(),
              startedAt: new Date().toISOString(),
              currentNodeId: null,
              status: 'running',
            },
          };

    setGraphState(state);

    // ── Build the context buffer for cross-node memory ──
    // Extract the original user prompt from initialState (stored during generation)
    const originalPrompt =
      (initialData as any).user_request ||
      (initialData as any).userRequest ||
      (initialData as any).prompt ||
      (initialData as any).request ||
      '';

    const contextBuffer: WorkflowContextBuffer = {
      originalPrompt,
      fullGraphState: { ...state },
      executionHistory: [],
    };
    // ─────────────────────────────────────────────────────

    const visited = new Set<string>();

    // Topological sort using Kahn's algorithm
    const inDegree = new Map<string, number>();
    nodes.forEach((n) => inDegree.set(n.id, 0));
    edges.forEach((e) => inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1));

    const queue = nodes
      .filter((n) => (inDegree.get(n.id) || 0) === 0)
      .map((n) => n.id)
      .filter((n) => !restoredCompleted.has(n));

    while (queue.length > 0) {
      if (executionControlRef.current.cancelRequested) {
        setRuntimeStatus('cancelled');
        setIsExecuting(false);
        return { status: 'cancelled', logs: runLogsRef.current };
      }

      while (executionControlRef.current.pauseRequested) {
        setRuntimeStatus('paused');
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (executionControlRef.current.cancelRequested) {
          setRuntimeStatus('cancelled');
          setIsExecuting(false);
          return { status: 'cancelled', logs: runLogsRef.current };
        }
      }

      const nodeId = queue.shift()!;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);

      const node = nodes.find((n) => n.id === nodeId);
      if (!node) continue;

      // Update metadata
      state = {
        ...state,
        __metadata: { ...state.__metadata, currentNodeId: nodeId },
      };
      setCurrentNodeId(nodeId);
      setCurrentNodeLabel(node.data.label || nodeId);

      // Mark running
      setNodes((nds) =>
        nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, isRunning: true } } : n)),
      );

      const stateContract = node.data.stateContract || { inputKeys: [], outputKeys: [] };
      const reducer = stateContract.reducer || 'overwrite';

      // Safely get inputKeys and outputKeys with fallbacks
      const inputKeys = stateContract.inputKeys || [];
      const outputKeys = stateContract.outputKeys || [];

      // Extract input slice from state (only the keys this node reads)
      const inputState: Record<string, any> = {};
      for (const key of inputKeys) {
        if (state[key] !== undefined) {
          inputState[key] = state[key];
        }
      }

      const nodeStartTime = performance.now();

      try {
        let nodeOutput: Record<string, any>;

        // Approval is derived from the action's side-effect class, not from
        // a hardcoded list of tool ids (which went stale whenever a
        // connector was added, and gated harmless reads like read_inbox
        // while missing anything new that actually sends).
        //
        // An `irreversible` action ALWAYS gates, and a workflow cannot opt
        // out of that. A node may additionally opt IN via requiresApproval.
        const requiresApproval =
          actionRequiresApproval(node.data.toolId, node.data.toolAction) ||
          Boolean(node.data.requiresApproval);

        const signature = JSON.stringify({
          nodeId: node.id,
          label: node.data.label,
          toolId: node.data.toolId,
          toolAction: node.data.toolAction,
          input: inputState,
          stateKeySnapshot: Object.keys(state).sort(),
        });

        if (executionControlRef.current.executedSignatures.has(signature)) {
          console.warn(
            `[Execution] Skipping duplicate node execution for ${node.data.label || node.id}`,
          );
          nodeOutput = {
            status: 'skipped',
            skipped: true,
            nodeId: node.id,
            reason: 'Duplicate execution prevented',
          };
          state = mergeIntoState(state, nodeOutput, reducer);
          setGraphState({ ...state });
          continue;
        }

        if (requiresApproval && onApprovalRequired) {
          const approved = await onApprovalRequired({
            nodeId: node.id,
            nodeLabel: node.data.label || node.id,
            message:
              node.data.approvalMessage ||
              `Approve this risky action before continuing: ${node.data.label || 'Workflow step'}`,
          });

          if (!approved) {
            state = {
              ...state,
              __metadata: { ...state.__metadata, status: 'paused', currentNodeId: nodeId },
            };
            setGraphState({ ...state });
            setRuntimeStatus('paused');
            setIsExecuting(false);
            return { status: 'paused', logs: runLogsRef.current };
          }
        }

        // A step the planner could not bind to any registered action.
        // Fail loudly here: the branches below would otherwise send it to
        // the LLM, which would return plausible text and the run would be
        // logged as completed.
        if (node.data.unsupported) {
          throw new NodeExecutionError(
            `${UNSUPPORTED_STEP_PREFIX} ${node.data.label || nodeId} — ` +
              `${node.data.unsupportedReason || 'no connected tool provides this capability'}.`,
            { kind: 'unsupported', nodeId },
          );
        }

        // Check if this node is bound to a tool action
        const { toolId, toolAction } = node.data;
        if (toolId && toolAction) {
          const tool = getTool(toolId);
          if (!tool) {
            throw new NodeExecutionError(`Tool "${toolId}" is not registered.`, {
              kind: 'permanent',
              nodeId,
              toolId,
              toolAction,
            });
          }
          if (!tool.isAuthenticated()) {
            throw new NodeExecutionError(`${tool.name} is not authenticated. Connect it first.`, {
              kind: 'auth',
              nodeId,
              toolId,
              toolAction,
            });
          }

          const action = tool.actions.find((a) => a.name === toolAction);
          if (!action) {
            throw new NodeExecutionError(
              `Action "${toolAction}" does not exist on tool "${toolId}".`,
              { kind: 'permanent', nodeId, toolId, toolAction },
            );
          }

          // Build input: start with stateContract keys, then apply node-specific configured fields,
          // then fill remaining action keys from the graph state.
          const mergedInput: Record<string, any> = { ...inputState };

          const reservedNodeKeys = new Set([
            'description',
            'icon',
            'color',
            'type',
            'toolId',
            'toolAction',
            'stateContract',
            'routerConfig',
            'breakpoint',
            'isRunning',
            'lastSuccess',
            'output',
            'initialState',
          ]);

          for (const [key, value] of Object.entries(node.data || {})) {
            if (!reservedNodeKeys.has(key) && value !== undefined) {
              mergedInput[key] = value;
            }
          }
          // The node's label is a reliable format hint for a download node
          // ("Download DOCX File" vs "Download Markdown File") when two parallel
          // branches share state; pass it explicitly so a connector can use it.
          if (node.data.label !== undefined) mergedInput.label = node.data.label;

          if (node.data.initialState && typeof node.data.initialState === 'object') {
            for (const [key, value] of Object.entries(node.data.initialState)) {
              if (value !== undefined) {
                mergedInput[key] = value;
              }
            }
          }

          for (const key of action.inputKeys) {
            if (mergedInput[key] === undefined && state[key] !== undefined) {
              mergedInput[key] = state[key];
            }
          }

          if (node.data.configuredRecipient) {
            mergedInput.to = node.data.configuredRecipient;
          }

          nodeOutput = await action.execute(mergedInput);

          // The action reports failure through its declared `error`
          // output. Raised here, BEFORE the result is merged into graph
          // state, so a failed step cannot contribute data to the ones
          // after it.
          const failure = detectActionFailure(nodeOutput);
          if (failure) {
            throw new NodeExecutionError(failure.message, {
              kind: failure.kind,
              nodeId,
              toolId,
              toolAction,
            });
          }
        } else if (node.data.initialState) {
          // Node has initialState — use it directly as output
          nodeOutput = {};
          for (const key of outputKeys) {
            if (node.data.initialState[key] !== undefined) {
              nodeOutput[key] = node.data.initialState[key];
            }
          }
        } else if (outputKeys.length > 0) {
          // No tool binding and no initialState — call Gemini AI to process this node
          // Pass the context buffer so AI has full workflow awareness
          nodeOutput = await executeNodeAction(
            node.data.label,
            node.data.description || '',
            inputState,
            outputKeys,
            contextBuffer,
          );
        } else {
          // Node with no output keys is a passthrough
          nodeOutput = {};
        }

        // Merge output into graph state
        state = mergeIntoState(state, nodeOutput, reducer);
        restoredCompleted.add(nodeId);
        executionControlRef.current.executedSignatures.add(signature);
        setGraphState({ ...state });
        saveRuntimeCheckpoint({
          runId: state.__metadata.runId,
          status: 'running',
          currentNodeId: nodeId,
          completedNodeIds: Array.from(restoredCompleted),
          executedSignatures: Array.from(executionControlRef.current.executedSignatures),
          graphState: { ...state },
          startedAt: state.__metadata.startedAt,
          lastUpdatedAt: new Date().toISOString(),
          nodesSnapshot: nodes.map((n) => ({
            id: n.id,
            label: n.data.label || n.id,
            type: n.type,
          })),
          edgesSnapshot: edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            condition: e.condition,
          })),
        });

        // Update context buffer with this node's output
        contextBuffer.fullGraphState = { ...state };
        contextBuffer.executionHistory.push({
          nodeLabel: node.data.label,
          outputKeys: outputKeys,
          outputSummary: JSON.stringify(nodeOutput, null, 2),
        });

        // Build human-readable output for logs
        const outputSummary = JSON.stringify(nodeOutput, null, 2);
        const nodeDurationMs = Math.round(performance.now() - nodeStartTime);

        // Create state snapshot (exclude metadata for readability)
        const { __metadata, ...stateWithoutMeta } = state;
        const stateSnapshot = { ...stateWithoutMeta };

        appendLog({
          node: node.data.label,
          time: new Date().toLocaleTimeString(),
          output: outputSummary,
          status: 'completed',
          stateSnapshot,
          durationMs: nodeDurationMs,
        });

        // Tool failure is detected above, before the merge, by reading the
        // declared `error` output. The substring sniff that used to live
        // here — `email_status` or `status` containing 'error' or 'failed'
        // — reported Gmail's "Authentication expired", "rate limit
        // exceeded" and "was rejected by Gmail" as successful sends, and
        // never looked at `web`/`files`/`slack` results at all.

        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId
              ? {
                  ...n,
                  data: { ...n.data, isRunning: false, lastSuccess: true, output: outputSummary },
                }
              : n,
          ),
        );
      } catch (err) {
        const attemptsSoFar = executionControlRef.current.retryCounts[nodeId] || 0;
        const message = err instanceof Error ? err.message : String(err);

        // Why it failed decides what happens next. Previously every
        // failure was retried twice, immediately: an unauthenticated tool
        // and a missing spreadsheet id both burned three attempts before
        // reporting the same thing they reported the first time.
        const kind: FailureKind =
          err instanceof NodeExecutionError ? err.kind : classifyFailureMessage(message);

        // An irreversible action is never retried. A send that times out
        // may already have gone through, and a second attempt would
        // deliver twice.
        const irreversible =
          getActionSideEffect(node.data.toolId, node.data.toolAction) === 'irreversible';

        const mayRetry = isRetryable(kind) && !irreversible && attemptsSoFar < MAX_RETRY_ATTEMPTS;

        if (mayRetry) {
          const attempt = attemptsSoFar + 1;
          const delay = retryDelayMs(attempt);
          executionControlRef.current.retryCounts[nodeId] = attempt;
          visited.delete(nodeId);
          queue.unshift(nodeId);

          appendLog({
            node: node.data.label,
            time: new Date().toLocaleTimeString(),
            output:
              `${message}\nRetrying in ${delay}ms (attempt ${attempt} of ${MAX_RETRY_ATTEMPTS}) — ` +
              `classified as ${kind}.`,
            status: 'retrying',
            failureKind: kind,
            stateSnapshot: { ...state },
          });

          setNodes((nds) =>
            nds.map((n) =>
              n.id === nodeId
                ? { ...n, data: { ...n.data, isRunning: false, lastSuccess: false } }
                : n,
            ),
          );

          // Backoff with jitter, so a graph of nodes hitting one
          // throttled API does not retry in lockstep.
          await new Promise((resolve) => setTimeout(resolve, delay));
          if (executionControlRef.current.cancelRequested) {
            setRuntimeStatus('cancelled');
            setIsExecuting(false);
            return { status: 'cancelled', logs: runLogsRef.current };
          }
          continue;
        }

        console.error(`Error executing node ${nodeId}:`, err);

        // Name the other tools that provide the same capability. A
        // suggestion for a human, NOT an automatic reroute — see
        // `alternativeProvidersFor`.
        const alternatives = alternativeProvidersFor(node.data.toolId, node.data.toolAction);

        const explanation =
          `${message}\n${remedyFor(kind)}` +
          (attemptsSoFar > 0
            ? `\nGave up after ${attemptsSoFar + 1} attempts.`
            : isRetryable(kind)
              ? ''
              : `\nNot retried: a ${kind} failure does not resolve on its own.`) +
          (irreversible && isRetryable(kind)
            ? '\nNot retried automatically because this action cannot be undone.'
            : '') +
          (alternatives.length > 0
            ? `\nOther tools that can do this: ${alternatives.join(', ')}.`
            : '');

        appendLog({
          node: node.data.label,
          time: new Date().toLocaleTimeString(),
          output: explanation,
          status: 'failed',
          failureKind: kind,
          alternatives,
          stateSnapshot: { ...state },
        });
        state = {
          ...state,
          __metadata: { ...state.__metadata, status: 'failed', error: String(err) },
        };
        setGraphState({ ...state });
        setRuntimeStatus('failed');
        saveRuntimeCheckpoint({
          runId: state.__metadata.runId,
          status: 'failed',
          currentNodeId: nodeId,
          completedNodeIds: Array.from(restoredCompleted),
          executedSignatures: Array.from(executionControlRef.current.executedSignatures),
          graphState: { ...state },
          startedAt: state.__metadata.startedAt,
          lastUpdatedAt: new Date().toISOString(),
          nodesSnapshot: nodes.map((n) => ({
            id: n.id,
            label: n.data.label || n.id,
            type: n.type,
          })),
          edgesSnapshot: edges.map((e) => ({
            id: e.id,
            source: e.source,
            target: e.target,
            condition: e.condition,
          })),
        });

        setNodes((nds) =>
          nds.map((n) =>
            n.id === nodeId
              ? { ...n, data: { ...n.data, isRunning: false, lastSuccess: false } }
              : n,
          ),
        );
        setIsExecuting(false);
        return { status: 'failed', logs: runLogsRef.current };
      }

      // Determine which outgoing edges to follow.
      // For logic/router nodes, evaluate edge conditions against current state.
      // For normal nodes, all outgoing edges are followed.
      const outgoingEdges = edges.filter((e) => e.source === nodeId) as (Edge & {
        condition?: string;
      })[];
      const hasConditions = outgoingEdges.some((e) => e.condition);

      let activeChildren: string[];
      if (hasConditions) {
        // Only follow edges whose condition evaluates to true
        activeChildren = outgoingEdges
          .filter((e) => evaluateCondition(e.condition, state))
          .map((e) => e.target);

        // If no condition matched and node has a routerConfig with defaultRoute, use it
        if (activeChildren.length === 0 && node.data.routerConfig?.defaultRoute) {
          activeChildren = [node.data.routerConfig.defaultRoute];
        }

        console.log(
          `[Router] Node "${node.data.label}" routed to: ${activeChildren.join(', ') || '(no match)'}`,
        );
      } else {
        activeChildren = outgoingEdges.map((e) => e.target);
      }

      // Decrement in-degree for active children; enqueue when all parents done
      for (const childId of activeChildren) {
        const newDegree = (inDegree.get(childId) || 1) - 1;
        inDegree.set(childId, newDegree);
        if (newDegree === 0) {
          queue.push(childId);
        }
      }
    }

    // Only mark 'completed' if no node error set it to 'failed'
    if (executionControlRef.current.cancelRequested) {
      state = {
        ...state,
        __metadata: { ...state.__metadata, currentNodeId: null, status: 'paused' },
      };
      setRuntimeStatus('cancelled');
      saveRuntimeCheckpoint({
        runId: state.__metadata.runId,
        status: 'paused',
        currentNodeId: null,
        completedNodeIds: Array.from(restoredCompleted),
        executedSignatures: Array.from(executionControlRef.current.executedSignatures),
        graphState: { ...state },
        startedAt: state.__metadata.startedAt,
        lastUpdatedAt: new Date().toISOString(),
        nodesSnapshot: nodes.map((n) => ({ id: n.id, label: n.data.label || n.id, type: n.type })),
        edgesSnapshot: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          condition: e.condition,
        })),
      });
    } else if (state.__metadata.status !== 'failed') {
      state = {
        ...state,
        __metadata: { ...state.__metadata, currentNodeId: null, status: 'completed' },
      };
      setRuntimeStatus('completed');
      saveRuntimeCheckpoint({
        runId: state.__metadata.runId,
        status: 'completed',
        currentNodeId: null,
        completedNodeIds: Array.from(restoredCompleted),
        executedSignatures: Array.from(executionControlRef.current.executedSignatures),
        graphState: { ...state },
        startedAt: state.__metadata.startedAt,
        lastUpdatedAt: new Date().toISOString(),
        nodesSnapshot: nodes.map((n) => ({ id: n.id, label: n.data.label || n.id, type: n.type })),
        edgesSnapshot: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          condition: e.condition,
        })),
      });
      clearRuntimeCheckpoint();
    } else {
      state = {
        ...state,
        __metadata: { ...state.__metadata, currentNodeId: null },
      };
      setRuntimeStatus('failed');
    }
    setGraphState({ ...state });
    setCurrentNodeId(null);
    setCurrentNodeLabel(null);
    setIsExecuting(false);

    const finalStatus: RunSummary['status'] =
      state.__metadata.status === 'completed'
        ? 'completed'
        : state.__metadata.status === 'paused'
          ? executionControlRef.current.cancelRequested
            ? 'cancelled'
            : 'paused'
          : 'failed';
    return { status: finalStatus, logs: runLogsRef.current };
  }, [nodes, edges, setNodes, appendLog]);

  const clearLogs = useCallback(() => {
    setExecutionLogs([]);
    setGraphState(null);
    clearRuntimeCheckpoint();
  }, []);

  return {
    isExecuting,
    executionLogs,
    graphState,
    currentNodeId,
    currentNodeLabel,
    runtimeStatus,
    executeFlow,
    pauseExecution,
    resumeExecution,
    cancelExecution,
    clearLogs,
    hasSavedCheckpoint: !!loadRuntimeCheckpoint(),
  };
};
