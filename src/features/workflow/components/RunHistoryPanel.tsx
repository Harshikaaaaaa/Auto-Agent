import React, { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw, CheckCircle2, XCircle, Ban, Loader2 } from 'lucide-react';
import { listWorkflowRuns, type WorkflowRun } from '@features/workflow/services/workflowStorage';

interface RunHistoryPanelProps {
  isVisible: boolean;
  /** When set, show only this workflow's runs; otherwise recent runs across all. */
  workflowId?: string;
  /** Bumping this forces a reload — e.g. right after a run finishes. */
  reloadKey?: number;
  onClose: () => void;
}

function formatDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${mins}m ${rem}s`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

const STATUS_STYLES: Record<string, { badge: string; icon: React.ReactNode }> = {
  completed: {
    badge: 'bg-emerald-500/15 text-emerald-400',
    icon: <CheckCircle2 className="w-3.5 h-3.5" />,
  },
  failed: { badge: 'bg-red-500/15 text-red-400', icon: <XCircle className="w-3.5 h-3.5" /> },
  cancelled: { badge: 'bg-white/10 text-white/60', icon: <Ban className="w-3.5 h-3.5" /> },
  running: { badge: 'bg-blue-500/15 text-blue-400', icon: <Loader2 className="w-3.5 h-3.5" /> },
};

/**
 * Read-only run history.
 *
 * The server records every execution (status, duration, node/failure counts, and
 * the failure reason) in the `workflow_runs` table. Before Task 16 the client
 * sent that data but never showed it back — this panel closes that loop so an
 * operator can see what happened on past runs without reading server logs.
 */
export const RunHistoryPanel: React.FC<RunHistoryPanelProps> = ({
  isVisible,
  workflowId,
  reloadKey,
  onClose,
}) => {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await listWorkflowRuns(workflowId, 25));
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (!isVisible) return;
    void load();
  }, [isVisible, reloadKey, load]);

  if (!isVisible) return null;

  return (
    <div className="w-[520px] glass-panel rounded-3xl shadow-2xl flex flex-col h-[560px] overflow-hidden border-white/10">
      <div className="p-5 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <History className="w-4 h-4 text-bolt-accent" />
          <p className="text-sm font-bold text-white">Run History</p>
          <span className="text-[9px] px-2 py-0.5 rounded-full font-bold bg-white/5 text-white/50">
            {workflowId ? 'This workflow' : 'All workflows'}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => void load()}
            title="Refresh"
            aria-label="Refresh run history"
            className="p-2 hover:bg-white/5 rounded-full"
          >
            <RefreshCw className={`w-4 h-4 text-white/60 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={onClose}
            aria-label="Close run history"
            className="p-2 hover:bg-white/5 rounded-full text-white/60"
          >
            <XCircle className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-black/40">
        {loading && runs.length === 0 && (
          <div className="text-white/30 text-xs p-4 text-center">Loading run history…</div>
        )}
        {!loading && runs.length === 0 && (
          <div className="text-white/30 text-xs p-4 text-center">
            No runs recorded yet. Save a workflow and run it — its executions show up here.
          </div>
        )}
        {runs.map((run) => {
          const style = STATUS_STYLES[run.status] ?? STATUS_STYLES.running;
          return (
            <div
              key={run.id}
              data-testid="run-history-item"
              className="rounded-xl border border-white/5 bg-white/[0.02] p-3"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span
                    className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${style.badge}`}
                  >
                    {style.icon}
                    {run.status}
                  </span>
                  {!workflowId && (
                    <span className="truncate text-xs font-medium text-white/70">
                      {run.workflowName}
                    </span>
                  )}
                </div>
                <span className="shrink-0 text-[10px] text-white/40">
                  {formatWhen(run.finishedAt ?? run.createdAt)}
                </span>
              </div>

              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-white/50">
                <span>Duration: {formatDuration(run.durationMs)}</span>
                {run.nodeCount !== null && <span>Nodes: {run.nodeCount}</span>}
                {run.failureCount ? (
                  <span className="text-red-400/70">Failures: {run.failureCount}</span>
                ) : null}
                {run.model && <span>Model: {run.model}</span>}
              </div>

              {run.status === 'failed' && (run.failureKind || run.error) && (
                <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 p-2 text-[10px] text-red-300/80">
                  {run.failureKind && (
                    <span className="mr-2 rounded-full bg-red-500/15 px-2 py-0.5 font-bold uppercase tracking-wide">
                      {run.failureKind}
                    </span>
                  )}
                  {run.error && <span className="break-words">{run.error}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
