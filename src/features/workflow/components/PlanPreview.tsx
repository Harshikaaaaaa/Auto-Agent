import { useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Play, Trash2, X } from 'lucide-react';
import type { NodeData, Workflow, WorkflowNode } from '@features/workflow/types';
import type { WorkflowPlan } from '@features/ai/services/workflowPlanGenerator';
import { relinkPlanGraph } from '@features/ai/services/workflowPlanGenerator';
import { actionRequiresApproval } from '@features/tools/toolRegistry';
import type { ToolStatus } from '@features/tools/types';
import {
  externalInputKeysOf,
  externalInputValue,
  missingExternalInputs,
} from '@features/workflow/services/externalInputs';

/**
 * The plan preview.
 *
 * It has one job: show what the workflow will ACTUALLY do, and let the user fix
 * it before it reaches the canvas. The version this replaces showed a panel of
 * "Recommended reusable tools" with keyword scores and a "Use this capability"
 * button that reordered a display array and changed nothing about the workflow —
 * a control that looked like it did something. Worse, it never showed which tool
 * a step was bound to, never showed steps the planner could not satisfy, and
 * never asked for the values a run needs, so a plan with a hole in it looked
 * identical to one without.
 *
 * What it shows now, all of it read off the draft graph rather than restated:
 *  - every step's real binding, "toolId.action", or that it is an AI step
 *  - steps with NO tool behind them, and why, called out at the top
 *  - which steps will pause for human approval
 *  - the values the user has to supply before a run can work
 *  - which bound tools are not connected yet
 *
 * What it lets the user change: rename a step, delete a step, fill in a required
 * value, and opt a step IN to approval. Approval that is mandatory because the
 * action is irreversible cannot be switched off here — that gate is the
 * registry's, and a preview is not the place to negotiate it away.
 */

export type NodeGenerationStatus = 'pending' | 'generating' | 'done' | 'error';

export interface PlanPreviewProps {
  /** The validated plan, for its title and summary. */
  plan: WorkflowPlan;
  /** The graph the plan produced. Edited locally; the parent gets the result. */
  draft: Workflow;
  /** Connection state, so an unconnected tool can be flagged before the run. */
  toolStatuses: ToolStatus[];
  /** Per-node progress while the parent streams the committed graph. */
  statuses?: Record<string, NodeGenerationStatus>;
  /** How many nodes have landed on the canvas so far. */
  committedCount?: number;
  /** Streaming in progress: editing is frozen. */
  isCommitting?: boolean;
  onCancel: () => void;
  onCommit: (draft: Workflow) => void;
}

const TYPE_LABELS: Record<string, string> = {
  trigger: 'Trigger',
  tool: 'Tool',
  ai_agent: 'AI step',
  logic: 'Decision',
  output: 'Output',
  approval: 'Approval',
  validation: 'Validation',
};

export function PlanPreview({
  plan,
  draft,
  toolStatuses,
  statuses = {},
  committedCount = 0,
  isCommitting = false,
  onCancel,
  onCommit,
}: PlanPreviewProps) {
  // Seeded once. The parent remounts this component per generation with a
  // fresh key, so there is no effect resyncing state behind the user's edits.
  const [nodes, setNodes] = useState<WorkflowNode[]>(draft.nodes);

  const unsupported = useMemo(() => nodes.filter((node) => node.data.unsupported), [nodes]);

  const missingInputs = useMemo(() => missingExternalInputs(nodes), [nodes]);

  const unconnectedTools = useMemo(() => {
    const bound = new Set(
      nodes.map((node) => node.data.toolId).filter((id): id is string => Boolean(id)),
    );
    return Array.from(bound)
      .map((id) => toolStatuses.find((tool) => tool.id === id))
      .filter((tool): tool is ToolStatus => Boolean(tool) && !tool!.authenticated);
  }, [nodes, toolStatuses]);

  const updateNode = (nodeId: string, change: (data: NodeData) => NodeData) => {
    setNodes((current) =>
      current.map((node) => (node.id === nodeId ? { ...node, data: change(node.data) } : node)),
    );
  };

  const removeNode = (nodeId: string) => {
    setNodes((current) => {
      // A plan with no steps is not a plan. Deleting the last one would
      // commit an empty graph, so the button is disabled at one node too.
      if (current.length <= 1) return current;
      return relinkPlanGraph(current.filter((node) => node.id !== nodeId)).nodes;
    });
  };

  const commit = () => {
    const { nodes: linked, edges } = relinkPlanGraph(nodes);
    onCommit({ nodes: linked, edges, initialState: draft.initialState ?? {} });
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6 bg-[#050505]/80 backdrop-blur-md">
      <div className="bg-[#0a0a0a] border border-white/10 rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden">
        <div className="px-6 py-5 border-b border-white/10 flex items-start justify-between gap-4">
          <div>
            <h3 className="font-bold text-lg text-white">{plan.title}</h3>
            {plan.description && (
              <p className="text-[12px] text-white/50 mt-1">{plan.description}</p>
            )}
            <p className="text-[11px] text-white/40 mt-1">
              {nodes.length} {nodes.length === 1 ? 'step' : 'steps'} • {plan.estimatedTime}
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close preview"
            className="p-1.5 hover:bg-white/5 rounded-full text-white/40 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 max-h-[60vh] overflow-y-auto space-y-4">
          {/* The honest part. A gap is stated before anything else, in
                        plain terms, instead of being papered over with a tool
                        that happens to share a keyword. */}
          {unsupported.length > 0 && (
            <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-300" />
                <h4 className="text-sm font-semibold text-amber-200">
                  {unsupported.length} {unsupported.length === 1 ? 'step has' : 'steps have'} no
                  tool behind {unsupported.length === 1 ? 'it' : 'them'}
                </h4>
              </div>
              <ul className="mt-2 space-y-1 text-[11px] text-amber-100/80">
                {unsupported.map((node) => (
                  <li key={node.id}>
                    <span className="font-semibold">{node.data.label}</span>:{' '}
                    {node.data.unsupportedReason}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[11px] text-amber-100/60">
                A run will stop at the first of these. Delete the step, or connect a tool that can
                do it and generate again.
              </p>
            </div>
          )}

          {missingInputs.length > 0 && (
            <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 p-4">
              <h4 className="text-sm font-semibold text-sky-200">
                {missingInputs.length} {missingInputs.length === 1 ? 'value is' : 'values are'}{' '}
                still needed
              </h4>
              <p className="mt-1 text-[11px] text-sky-100/70">
                No earlier step produces {missingInputs.length === 1 ? 'it' : 'them'}, so you have
                to supply {missingInputs.length === 1 ? 'it' : 'them'}. Fill them in below, or later
                on the canvas.
              </p>
            </div>
          )}

          {unconnectedTools.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-4">
              <h4 className="text-sm font-semibold text-white">Not connected yet</h4>
              <p className="mt-1 text-[11px] text-white/50">
                {unconnectedTools.map((tool) => tool.name).join(', ')} — the run will stop until you
                connect {unconnectedTools.length === 1 ? 'it' : 'them'}.
              </p>
            </div>
          )}

          {nodes.map((node, index) => {
            const status = statuses[node.id] ?? (index < committedCount ? 'done' : 'pending');
            const mandatoryApproval = actionRequiresApproval(
              node.data.toolId,
              node.data.toolAction,
            );
            const gated = mandatoryApproval || Boolean(node.data.requiresApproval);
            const externalKeys = externalInputKeysOf(node.data);
            const outputKeys = node.data.stateContract?.outputKeys ?? [];

            return (
              <div
                key={node.id}
                data-testid={`plan-step-${node.id}`}
                className={`p-4 rounded-xl border transition-all ${
                  node.data.unsupported
                    ? 'bg-amber-500/5 border-amber-500/30'
                    : status === 'done'
                      ? 'bg-emerald-500/10 border-emerald-500/30'
                      : 'bg-white/5 border-white/10'
                }`}
              >
                <div className="flex items-start gap-3">
                  <div className="w-5 flex-shrink-0 mt-1">
                    {status === 'done' ? (
                      <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                    ) : status === 'generating' ? (
                      <Loader2 className="w-4 h-4 animate-spin text-white/60" />
                    ) : status === 'error' ? (
                      <span className="text-red-400 text-sm">✖</span>
                    ) : (
                      <div className="w-5 h-5 rounded-full border-2 border-white/20 flex items-center justify-center">
                        <span className="text-[10px] font-bold text-white/40">{index + 1}</span>
                      </div>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <input
                      value={node.data.label}
                      aria-label={`Step ${index + 1} name`}
                      disabled={isCommitting}
                      onChange={(event) =>
                        updateNode(node.id, (data) => ({
                          ...data,
                          label: event.target.value,
                        }))
                      }
                      className="w-full bg-transparent font-semibold text-white outline-none border-b border-transparent focus:border-white/20 disabled:opacity-60"
                    />

                    {node.data.description && (
                      <p className="text-[12px] text-white/50 mt-1">{node.data.description}</p>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-white/50">
                        {TYPE_LABELS[String(node.data.type)] ?? String(node.data.type)}
                      </span>

                      {/* The binding, spelled out. This is the
                                                claim the whole task is about, so it is
                                                shown verbatim rather than summarised. */}
                      {node.data.unsupported ? (
                        <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-amber-200">
                          no tool
                        </span>
                      ) : node.data.toolId && node.data.toolAction ? (
                        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-mono text-emerald-200">
                          {node.data.toolId}.{node.data.toolAction}
                        </span>
                      ) : (
                        <span className="rounded-full border border-white/10 bg-black/30 px-2 py-0.5 text-[9px] text-white/40">
                          no tool call
                        </span>
                      )}

                      {gated && (
                        <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.12em] text-orange-200">
                          asks approval
                        </span>
                      )}
                    </div>

                    {outputKeys.length > 0 && (
                      <div className="text-[10px] text-emerald-400/60 mt-2">
                        Outputs: {outputKeys.join(', ')}
                      </div>
                    )}

                    {externalKeys.length > 0 && (
                      <div className="mt-3 space-y-2">
                        {externalKeys.map((key) => (
                          <label key={key} className="block">
                            <span className="text-[10px] uppercase tracking-[0.12em] text-white/40">
                              {key}
                            </span>
                            <input
                              value={externalInputValue(node, key)}
                              aria-label={`${key} for ${node.data.label}`}
                              disabled={isCommitting}
                              placeholder={`You need to supply ${key}`}
                              onChange={(event) =>
                                updateNode(node.id, (data) => ({
                                  ...data,
                                  [key]: event.target.value,
                                }))
                              }
                              className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-white/25 disabled:opacity-60"
                            />
                          </label>
                        ))}
                      </div>
                    )}

                    <label className="mt-3 flex items-center gap-2 text-[11px] text-white/50">
                      <input
                        type="checkbox"
                        checked={gated}
                        aria-label={`Ask for approval before ${node.data.label}`}
                        // Irreversible actions always gate, and a preview
                        // must not be able to bargain that away.
                        disabled={mandatoryApproval || isCommitting}
                        onChange={(event) =>
                          updateNode(node.id, (data) => ({
                            ...data,
                            requiresApproval: event.target.checked,
                          }))
                        }
                      />
                      {mandatoryApproval
                        ? 'Always asks — this action cannot be undone'
                        : 'Ask me before this step runs'}
                    </label>
                  </div>

                  <button
                    onClick={() => removeNode(node.id)}
                    aria-label={`Delete step ${node.data.label}`}
                    disabled={isCommitting || nodes.length <= 1}
                    className="p-1.5 rounded-lg text-white/30 hover:text-red-300 hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-white/30 transition-colors flex-shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-6 py-4 border-t border-white/10 flex items-center justify-between gap-3">
          <div className="text-[12px] text-white/40">
            {isCommitting
              ? `Adding step ${Math.min(committedCount + 1, nodes.length)} of ${nodes.length}`
              : unsupported.length > 0
                ? `${unsupported.length} unresolved ${unsupported.length === 1 ? 'gap' : 'gaps'}`
                : `${nodes.length} ${nodes.length === 1 ? 'step' : 'steps'} ready`}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              disabled={isCommitting}
              className="px-4 py-2.5 rounded-xl border border-white/10 text-xs font-bold text-white/60 hover:text-white hover:bg-white/5 disabled:opacity-40 transition-all"
            >
              Discard
            </button>
            <button
              onClick={commit}
              disabled={isCommitting}
              className="flex items-center gap-2 px-6 py-2.5 bg-bolt-accent text-black rounded-xl text-xs font-bold hover:bg-bolt-accent/90 disabled:opacity-60 transition-all"
            >
              {isCommitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-black" />
              )}
              Add to canvas
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
