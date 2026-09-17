import React from 'react';
import {
  X,
  Terminal as TerminalIcon,
  Download,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { ExecutionLog, GraphState } from '@features/workflow/types';
import { Node } from 'reactflow';

interface ExecutionMonitorProps {
  isVisible: boolean;
  isExecuting: boolean;
  currentNodeLabel: string | null;
  executionLogs: ExecutionLog[];
  workflowNodes: Node[];
  graphState: GraphState | null;
  onClose: () => void;
  onDownload: (content: string, filename: string) => void;
}

/** Renders a collapsible JSON tree for state inspection */
const StateTree = ({ state, label }: { state: Record<string, any>; label: string }) => {
  const [isOpen, setIsOpen] = React.useState(false);
  const entries = Object.entries(state).filter(([k]) => k !== '__metadata');

  if (entries.length === 0) return null;

  return (
    <div className="mt-2">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1 text-[9px] font-bold text-white/40 hover:text-white/60 transition-colors"
      >
        {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {label}
      </button>
      {isOpen && (
        <div className="mt-1 text-[9px] text-white/50 bg-white/[0.03] p-2 rounded-lg border border-white/5 overflow-x-auto">
          <pre>{JSON.stringify(Object.fromEntries(entries), null, 2)}</pre>
        </div>
      )}
    </div>
  );
};

export const ExecutionMonitor: React.FC<ExecutionMonitorProps> = ({
  isVisible,
  isExecuting,
  currentNodeLabel,
  executionLogs,
  workflowNodes,
  graphState,
  onClose,
  onDownload,
}) => {
  if (!isVisible) return null;

  const nodeCount = workflowNodes.length || executionLogs.length;
  const nodeFeedback = workflowNodes.map((node) => {
    const label = node.data?.label || node.id;
    const logs = executionLogs.filter((log) => log.node === label);
    const latest = logs[logs.length - 1];
    // The engine sets `status` on every log entry, so trust it. This used to
    // fall back to searching the OUTPUT for 'error' and 'failed', which
    // marked a perfectly successful step as failed whenever the page it
    // scraped happened to contain either word.
    const inferredStatus =
      latest?.status || (latest ? 'completed' : currentNodeLabel === label ? 'running' : 'pending');
    return { node, label, log: latest, status: inferredStatus };
  });
  const latestStatus = graphState?.__metadata?.status || 'idle';
  const failureCount = nodeFeedback.filter(
    (item) => item.status === 'failed' || item.status === 'retrying',
  ).length;

  return (
    <div className="w-[520px] glass-panel rounded-3xl shadow-2xl flex flex-col h-[560px] overflow-hidden border-white/10">
      <div className="p-5 border-b border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <TerminalIcon className="w-4 h-4 text-bolt-accent" />
          <p className="text-sm font-bold text-white">State Graph Monitor</p>
          {graphState && (
            <span
              className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${
                graphState.__metadata.status === 'completed'
                  ? 'bg-emerald-500/15 text-emerald-400'
                  : graphState.__metadata.status === 'failed'
                    ? 'bg-red-500/15 text-red-400'
                    : 'bg-blue-500/15 text-blue-400'
              }`}
            >
              {graphState.__metadata.status.toUpperCase()}
            </span>
          )}
        </div>
        <button onClick={onClose} className="p-2 hover:bg-white/5 rounded-full">
          <X className="w-4 h-4" />
        </button>
      </div>

      {isExecuting && currentNodeLabel && (
        <div className="px-5 py-3 border-b border-white/10 bg-white/5 text-[11px] text-white/80 flex items-center justify-between gap-3">
          <span className="font-semibold">Executing node:</span>
          <span className="rounded-full bg-bolt-accent/15 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-bolt-accent">
            {currentNodeLabel}
          </span>
        </div>
      )}

      <div className="px-5 py-3 border-b border-white/10 bg-[#0a0a0a]">
        <div className="flex gap-2 flex-wrap text-[9px] font-bold uppercase tracking-[0.16em] text-white/60">
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
            Status: {latestStatus}
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
            Nodes: {nodeCount}
          </span>
          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1">
            Failures: {failureCount}
          </span>
        </div>
      </div>

      <div className="flex-1 p-6 overflow-y-auto space-y-5 font-mono text-[10px] leading-relaxed bg-black/40">
        {executionLogs.length === 0 && isExecuting && (
          <div className="space-y-3 animate-pulse">
            {[1, 2, 3].map((i) => (
              <div key={i} className="space-y-2">
                <div className="flex justify-between">
                  <div className="h-3 bg-white/10 rounded w-48" />
                  <div className="h-3 bg-white/5 rounded w-16" />
                </div>
                <div className="h-12 bg-white/5 rounded-lg" />
              </div>
            ))}
          </div>
        )}
        {executionLogs.length === 0 && !isExecuting && (
          <div className="text-white/20">Waiting for execution...</div>
        )}
        {nodeFeedback.map(({ label, log, status }, idx) => {
          const displayLog =
            log ||
            ({
              node: label,
              time: '--:--:--',
              output: status === 'running' ? 'Node is executing...' : 'Waiting for upstream nodes.',
              status,
            } as ExecutionLog);
          const statusLabel = status === 'completed' ? 'COMPLETE' : status.toUpperCase();
          const duration = displayLog.durationMs
            ? displayLog.durationMs >= 1000
              ? `${(displayLog.durationMs / 1000).toFixed(1)}s`
              : `${Math.round(displayLog.durationMs)}ms`
            : null;
          const isFailed = status === 'failed' || status === 'retrying';

          return (
            <div key={idx} className="space-y-2 group">
              <div className="flex justify-between items-center border-b border-white/5 pb-1">
                <span className="text-bolt-accent font-bold flex items-center gap-2">
                  {status === 'completed' && <CheckCircle2 className="w-3 h-3 text-emerald-400" />}
                  {status === 'running' && (
                    <Loader2 className="w-3 h-3 animate-spin text-bolt-accent" />
                  )}
                  {status === 'pending' && <Circle className="w-3 h-3 text-white/25" />}
                  {isFailed && <AlertCircle className="w-3 h-3 text-red-400" />}
                  <span className="text-white/30">
                    [{idx + 1}/{nodeCount}]
                  </span>{' '}
                  [{displayLog.time}] {label}
                </span>
                <div className="flex items-center gap-2">
                  {duration && <span className="text-white/30 font-mono">{duration}</span>}
                  {/* Why it failed, so "reconnect the tool" and
                                        "one of the inputs is wrong" are told apart
                                        at a glance. */}
                  {displayLog.failureKind && (
                    <span className="rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[9px] font-bold uppercase tracking-[0.1em] text-red-300">
                      {displayLog.failureKind.replace(/_/g, ' ')}
                    </span>
                  )}
                  <span
                    className={
                      isFailed
                        ? 'text-red-400'
                        : status === 'pending'
                          ? 'text-white/30'
                          : 'text-emerald-500'
                    }
                  >
                    {statusLabel}
                  </span>
                </div>
              </div>
              <div className="text-white/60 bg-white/5 p-3 rounded-lg overflow-x-auto">
                <pre className="whitespace-pre-wrap">{displayLog.output}</pre>
              </div>
              {displayLog.stateSnapshot && (
                <StateTree state={displayLog.stateSnapshot} label="State after this node" />
              )}
              <button
                onClick={() => onDownload(displayLog.output, label)}
                disabled={!log}
                className="flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 text-white/40 rounded-lg text-[9px] font-bold border border-white/5 transition-all"
              >
                <Download className="w-3 h-3" />
                Export output
              </button>
            </div>
          );
        })}
        {isExecuting && workflowNodes.length > 0 && (
          <div className="flex items-center gap-2 text-white/40 italic">
            <div className="w-2 h-2 rounded-full bg-bolt-accent animate-pulse" />
            Executing next node...
          </div>
        )}

        {/* Final state summary */}
        {graphState && graphState.__metadata.status === 'completed' && (
          <div className="border-t border-white/10 pt-4 mt-4">
            <div className="text-[10px] font-bold text-emerald-400 mb-2">✓ FINAL GRAPH STATE</div>
            <div className="text-white/50 bg-white/[0.03] p-3 rounded-lg border border-emerald-500/10 overflow-x-auto">
              <pre className="whitespace-pre-wrap">
                {JSON.stringify(
                  Object.fromEntries(
                    Object.entries(graphState).filter(([k]) => k !== '__metadata'),
                  ),
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
