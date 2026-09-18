import React, { useState, useCallback, useMemo, useEffect, lazy, Suspense } from 'react';
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Panel,
  addEdge,
  Connection,
  Edge,
  Node,
  useNodesState,
  useEdgesState,
  MarkerType,
  useReactFlow,
} from 'reactflow';
import {
  Play,
  ChevronRight,
  X,
  Plus,
  Loader2,
  ChevronLeft,
  Terminal as TerminalIcon,
  FolderOpen,
  Box,
  FileText,
  Mail,
  Save,
  Download,
  Trash2,
  Undo2,
  Redo2,
  CheckCircle2,
  History,
} from 'lucide-react';
import {
  generateWorkflowPlan,
  planToWorkflow,
  PlanValidationError,
  type WorkflowPlan,
} from '@features/ai/services/workflowPlanGenerator';
import { PlanPreview } from './PlanPreview';
import {
  TASK_DRAFTS_STORAGE_KEY,
  TASK_SESSIONS_STORAGE_KEY,
  createChatTaskSession,
  createNodeId,
  deriveTaskNameFromPrompt,
  isMeaningfulWorkflowPrompt,
  loadStoredTaskDrafts,
  loadStoredTaskSessions,
  normalizeTaskTitle,
  type ChatMessage,
  type ChatTaskSession,
} from '@features/workflow/services/taskSessions';
import {
  applyPatch,
  describeOperation,
  generateGraphPatch,
  isDestructive,
  PatchValidationError,
  type GraphPatch,
} from '@features/ai/services/workflowPatchGenerator';
import { AI_CONFIG } from '@features/ai/config';
import { WorkflowNode } from './WorkflowNode';
import { ExecutionMonitor } from './ExecutionMonitor';
import { RunHistoryPanel } from './RunHistoryPanel';
import {
  inputsToCollect,
  missingRequiredInputs,
  requiredInputsForRun,
  type RequiredInput,
} from '@features/workflow/services/externalInputs';
import { NodeType } from '@/shared/types';
import {
  useWorkflowExecution,
  type RunSummary,
} from '@features/workflow/hooks/useWorkflowExecution';
import type { ExecutionLog } from '@features/workflow/types';
import { useTools } from '@features/tools/useTools';
import { getTool, getAllTools } from '@features/tools/toolRegistry';
import type {
  FlowEdge,
  ReusableNodeTemplate,
  Workflow,
  WorkflowEdge,
  WorkflowNode as WorkflowNodeModel,
  NodeData,
} from '@features/workflow/types';
import { validateCondition } from '@features/workflow/services/safeExpression';
import {
  saveWorkflow,
  loadWorkflow,
  listWorkflows,
  deleteWorkflow,
  SavedWorkflow,
} from '@features/workflow/services/workflowStorage';
import { useUndoRedo } from '@features/workflow/hooks/useUndoRedo';
import { useWorkflowVersions } from '@features/workflow/hooks/useWorkflowVersions';
import { suggestFixes, type FixSuggestion } from '@features/workflow/services/failureFixes';
import {
  currentNodeVersionIndex,
  listNodeVersions,
  pushNodeVersion,
  restoreNodeVersion,
} from '@features/workflow/services/nodeVersions';
// Lazy-loaded so the export machinery — the 10 framework code generators and
// jszip, the single largest dependency in the app — ships as a separate async
// chunk fetched only when the user opens the Export modal, instead of bloating
// the initial page load. This is what clears Vite's 500 kB chunk warning.
const ExportModal = lazy(() => import('./ExportModal').then((m) => ({ default: m.ExportModal })));

/** Shorten a node's output for the chat; the full detail stays in the monitor. */
function summarizeOutput(output: string): string {
  const clean = (output || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 160 ? `${clean.slice(0, 157)}…` : clean;
}

/**
 * Turn a finished run into a per-node chat report: a headline for the outcome,
 * then one line per step saying whether it passed (and what it produced) or
 * failed (and why). This is the same information the State Graph Monitor shows,
 * surfaced in the conversation so the user never has to hunt for it.
 */
function buildRunReport(summary: RunSummary): string {
  const icon: Record<string, string> = {
    completed: '✅',
    failed: '❌',
    retrying: '🔁',
    running: '⏳',
  };
  // The last log per node is its final outcome (a retried node logs twice).
  const lastByNode = new Map<string, ExecutionLog>();
  for (const log of summary.logs) lastByNode.set(log.node, log);
  const steps = Array.from(lastByNode.values());

  const passed = steps.filter((s) => s.status === 'completed').length;
  const failed = steps.filter((s) => s.status === 'failed').length;

  const headline =
    summary.status === 'completed'
      ? `Run finished — all ${passed} step${passed === 1 ? '' : 's'} passed.`
      : summary.status === 'failed'
        ? `Run failed — ${passed} passed, ${failed} failed.`
        : summary.status === 'cancelled'
          ? 'Run cancelled.'
          : 'Run paused for approval.';

  const lines = steps.map((log, index) => {
    const mark = icon[log.status ?? 'running'] ?? '•';
    const duration = log.durationMs != null ? ` (${Math.round(log.durationMs)}ms)` : '';
    const head = `${mark} ${index + 1}. ${log.node}${duration}`;
    if (log.status === 'failed') {
      const why = log.failureKind ? ` [${log.failureKind}]` : '';
      return `${head}${why}\n    ${summarizeOutput(log.output) || 'failed'}`;
    }
    const produced = summarizeOutput(log.output);
    return produced ? `${head}\n    → ${produced}` : head;
  });

  return [headline, ...lines].join('\n');
}

const nodeTypes = {
  trigger: WorkflowNode,
  tool: WorkflowNode,
  ai_agent: WorkflowNode,
  logic: WorkflowNode,
  output: WorkflowNode,
  memory: WorkflowNode,
  retrieval: WorkflowNode,
  validation: WorkflowNode,
  approval: WorkflowNode,
  mcp: WorkflowNode,
};

export function WorkflowCanvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [magicPrompt, setMagicPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [savedList, setSavedList] = useState<SavedWorkflow[]>([]);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  const [activeWorkflowName, setActiveWorkflowName] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showChatPanel, setShowChatPanel] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [taskSessions, setTaskSessions] = useState<ChatTaskSession[]>(() =>
    loadStoredTaskSessions(),
  );
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>(() =>
    loadStoredTaskDrafts(),
  );
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [showTemplatesModal, setShowTemplatesModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const taskParam = new URLSearchParams(window.location.search).get('task');
    if (!taskParam) {
      setActiveTaskId((current) => current ?? null);
      return;
    }

    const storedMatch = taskSessions.some((task) => task.id === taskParam);
    if (!storedMatch) {
      const url = new URL(window.location.href);
      url.searchParams.delete('task');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      setActiveTaskId(null);
      return;
    }

    setActiveTaskId((current) => current ?? taskParam);
  }, [taskSessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TASK_SESSIONS_STORAGE_KEY, JSON.stringify(taskSessions));
    } catch (error) {
      console.warn('[TaskSessions] Unable to persist sessions:', error);
    }
  }, [taskSessions]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TASK_DRAFTS_STORAGE_KEY, JSON.stringify(taskDrafts));
    } catch (error) {
      console.warn('[TaskDrafts] Unable to persist drafts:', error);
    }
  }, [taskDrafts]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);

    if (activeTaskId) {
      url.searchParams.set('task', activeTaskId);
    } else {
      url.searchParams.delete('task');
    }

    if (window.location.search !== url.search) {
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, [activeTaskId]);

  const ensureActiveTask = useCallback(() => {
    if (activeTaskId) return activeTaskId;

    const nextTask = createChatTaskSession(
      `Task ${taskSessions.length + 1}`,
      taskSessions.length + 1,
    );
    setTaskSessions((prev) => [...prev, nextTask]);
    setTaskDrafts((prev) => ({ ...prev, [nextTask.id]: '' }));
    setActiveTaskId(nextTask.id);
    setNodes([]);
    setEdges([]);
    setShowChatPanel(true);
    return nextTask.id;
  }, [activeTaskId, taskSessions.length, setNodes, setEdges]);
  const [connectionSuggestion, setConnectionSuggestion] = useState<{
    source: string;
    target?: string;
    position: { x: number; y: number };
  } | null>(null);
  const [authReconnect, setAuthReconnect] = useState<{
    toolId: string;
    toolName: string;
    message: string;
  } | null>(null);
  const [approvalRequest, setApprovalRequest] = useState<{
    nodeId: string;
    nodeLabel: string;
    message: string;
  } | null>(null);
  const [activeView, setActiveView] = useState<'graph' | 'execution' | 'history'>('graph');
  // Bumped after a run is recorded so an open history panel refetches.
  const [runHistoryReloadKey, setRunHistoryReloadKey] = useState(0);
  const reusableToolNodes = useMemo<ReusableNodeTemplate[]>(
    () =>
      getAllTools().flatMap((tool) =>
        tool.actions.map((action) => ({
          toolId: tool.id,
          toolName: tool.name,
          toolAction: action.name,
          label: `${tool.name}: ${action.name.replace(/_/g, ' ')}`,
          description: action.description,
          inputKeys: action.inputKeys,
          outputKeys: action.outputKeys,
          nodeType: NodeType.TOOL,
        })),
      ),
    [],
  );

  const reusableHelperNodes = useMemo<ReusableNodeTemplate[]>(
    () => [
      {
        id: 'set_variable',
        label: 'Set Variable',
        description: 'Assign or overwrite a state value for downstream steps.',
        nodeType: NodeType.AI_AGENT,
        stateContract: { inputKeys: ['value', 'key'], outputKeys: ['value'] },
      },
      {
        id: 'if_condition',
        label: 'If Condition',
        description: 'Branch execution based on a boolean or comparison expression.',
        nodeType: NodeType.LOGIC,
        stateContract: { inputKeys: ['condition'], outputKeys: ['decision'] },
      },
      {
        id: 'merge_data',
        label: 'Merge Data',
        description: 'Combine multiple fields into a single structured object.',
        nodeType: NodeType.AI_AGENT,
        stateContract: { inputKeys: ['payload', 'data'], outputKeys: ['merged'] },
      },
      {
        id: 'wait_delay',
        label: 'Wait Delay',
        description: 'Pause the workflow for a fixed duration before continuing.',
        nodeType: NodeType.LOGIC,
        stateContract: { inputKeys: ['delay_ms'], outputKeys: ['wait_complete'] },
      },
      {
        id: 'format_text',
        label: 'Format Text',
        description: 'Transform text or JSON into a cleaner message or output payload.',
        nodeType: NodeType.AI_AGENT,
        stateContract: { inputKeys: ['text', 'format'], outputKeys: ['formatted_text'] },
      },
      {
        id: 'http_request',
        label: 'HTTP Request',
        description: 'Call an external endpoint and save the response payload.',
        nodeType: NodeType.TOOL,
        stateContract: { inputKeys: ['url', 'method', 'body'], outputKeys: ['response'] },
      },
      {
        id: 'mcp_tool_node',
        label: 'MCP Tool Node',
        description:
          'Call a tool through an MCP-capable server and pass the result into the workflow state.',
        nodeType: NodeType.MCP,
        stateContract: { inputKeys: ['tool_name', 'request'], outputKeys: ['tool_result'] },
      },
      {
        id: 'rag_search',
        label: 'RAG Search',
        description:
          'Retrieve relevant context from indexed knowledge before generation or decision-making.',
        nodeType: NodeType.RETRIEVAL,
        stateContract: { inputKeys: ['query', 'context'], outputKeys: ['retrieved_context'] },
      },
      {
        id: 'memory_recall',
        label: 'Memory Recall',
        description: 'Fetch prior user or workflow memory to inform the next step.',
        nodeType: NodeType.MEMORY,
        stateContract: { inputKeys: ['memory_key', 'user_context'], outputKeys: ['memory_result'] },
      },
      {
        id: 'validation_gate',
        label: 'Validation Gate',
        description: 'Check whether data meets required conditions before continuing execution.',
        nodeType: NodeType.VALIDATION,
        stateContract: { inputKeys: ['payload', 'rules'], outputKeys: ['validated'] },
      },
      {
        id: 'approval_gate',
        label: 'Approval Gate',
        description:
          'Pause execution and wait for explicit human approval before a risky action continues.',
        nodeType: NodeType.APPROVAL,
        stateContract: { inputKeys: ['decision', 'reason'], outputKeys: ['approved'] },
      },
      {
        id: 'summary_output',
        label: 'Summary Output',
        description: 'Create a final summary message for the user or downstream step.',
        nodeType: NodeType.OUTPUT,
        stateContract: { inputKeys: ['summary'], outputKeys: ['result'] },
      },
    ],
    [],
  );

  const reusableNodes = useMemo<ReusableNodeTemplate[]>(
    () => [...reusableToolNodes, ...reusableHelperNodes],
    [reusableToolNodes, reusableHelperNodes],
  );
  const activeTask = activeTaskId
    ? (taskSessions.find((task) => task.id === activeTaskId) ?? null)
    : null;
  const chatMessages = activeTask?.messages ?? [];
  const activeTaskDraft = activeTaskId ? (taskDrafts[activeTaskId] ?? '') : magicPrompt;

  useEffect(() => {
    if (!activeTaskId) return;

    const nextTask = taskSessions.find((task) => task.id === activeTaskId);
    if (!nextTask) return;

    const taskNodes = nextTask.workflow?.nodes ?? [];
    const taskEdges = nextTask.workflow?.edges ?? [];
    setNodes(taskNodes);
    setEdges(taskEdges);
  }, [activeTaskId]);

  useEffect(() => {
    if (!activeTaskId) return;

    const currentTask = taskSessions.find((task) => task.id === activeTaskId);
    const serializedCurrent = JSON.stringify(currentTask?.workflow ?? { nodes: [], edges: [] });
    const serializedNext = JSON.stringify({ nodes, edges });

    if (serializedCurrent === serializedNext) return;

    setTaskSessions((prev) =>
      prev.map((task) =>
        task.id === activeTaskId ? { ...task, workflow: { nodes, edges } } : task,
      ),
    );
  }, [activeTaskId, nodes, edges]);
  const getActivePrompt = useCallback(
    () => (activeTaskId ? (taskDrafts[activeTaskId] ?? '') : magicPrompt).trim(),
    [activeTaskId, taskDrafts, magicPrompt],
  );
  const setActiveTaskDraft = useCallback(
    (value: string) => {
      if (!activeTaskId) {
        setMagicPrompt(value);
        return;
      }
      setTaskDrafts((prev) => ({ ...prev, [activeTaskId]: value }));
    },
    [activeTaskId],
  );
  const createNewTask = useCallback(() => {
    const nextIndex = taskSessions.length + 1;
    const nextTask = createChatTaskSession(`Task ${nextIndex}`, nextIndex);
    setTaskSessions((prev) => [...prev, nextTask]);
    setTaskDrafts((prev) => ({ ...prev, [nextTask.id]: '' }));
    setActiveTaskId(nextTask.id);
    setNodes([]);
    setEdges([]);
    setChatInput('');
    setMagicPrompt('');
    setSidebarOpen(true);
    setShowChatPanel(true);
  }, [taskSessions.length, setNodes, setEdges]);

  const handleDeleteTask = useCallback(
    (taskId: string) => {
      setTaskSessions((prev) => {
        const remaining = prev.filter((task) => task.id !== taskId);
        if (remaining.length === 0) {
          const fresh = createChatTaskSession('Task 1', 1);
          setActiveTaskId(fresh.id);
          setNodes([]);
          setEdges([]);
          setTaskDrafts((current) => ({ ...current, [fresh.id]: '' }));
          return [fresh];
        }

        setActiveTaskId((current) => (current === taskId ? remaining[0].id : current));
        if (activeTaskId === taskId) {
          const nextTask = remaining[0];
          setNodes(nextTask.workflow?.nodes ?? []);
          setEdges(nextTask.workflow?.edges ?? []);
        }
        return remaining;
      });

      setTaskDrafts((prev) => {
        const next = { ...prev };
        delete next[taskId];
        return next;
      });
    },
    [activeTaskId, setNodes, setEdges],
  );
  const updateActiveTaskMessages = useCallback(
    (updater: (messages: ChatMessage[]) => ChatMessage[]) => {
      if (!activeTaskId) return;
      setTaskSessions((prev) =>
        prev.map((task) =>
          task.id === activeTaskId ? { ...task, messages: updater(task.messages) } : task,
        ),
      );
    },
    [activeTaskId],
  );
  const workflowTemplates = useMemo(
    () => [
      {
        id: 'lead_follow_up',
        title: 'Lead follow-up',
        summary: 'Capture lead data, summarize it, and send a personalized email.',
        prompt:
          'Create a lead qualification workflow: collect a lead, summarize the request, send a follow-up email, and log the result to a sheet.',
      },
      {
        id: 'support_triage',
        title: 'Support triage',
        summary: 'Review incoming request, route to team, and notify channel.',
        prompt:
          'Create a support triage workflow that reads an incoming request, categorizes the issue, and alerts the right team in Slack.',
      },
      {
        id: 'content_approval',
        title: 'Content approval',
        summary: 'Draft content, validate it, and ask for approval before publishing.',
        prompt:
          'Create a content approval workflow that drafts a message, checks it for formatting issues, and pauses for approval before sending.',
      },
    ],
    [],
  );
  /**
   * The plan awaiting review, and the graph it produced.
   *
   * `id` exists so the preview can be keyed on it: a new generation remounts
   * the editor with fresh state instead of an effect quietly overwriting
   * whatever the user had already edited.
   */
  const [planDraft, setPlanDraft] = useState<{
    id: string;
    plan: WorkflowPlan;
    workflow: Workflow;
  } | null>(null);
  const [isCommittingPlan, setIsCommittingPlan] = useState(false);
  const [planStep, setPlanStep] = useState(0);
  /** A chat edit is being worked out. Blocks a second concurrent instruction. */
  const [isPatching, setIsPatching] = useState(false);
  /**
   * A validated patch that removes or replaces steps, held for confirmation.
   * Losing a configured node to one ambiguous sentence is not recoverable —
   * canvas undo records no history yet — so these are never auto-applied.
   */
  const [pendingPatch, setPendingPatch] = useState<GraphPatch | null>(null);
  /**
   * External inputs a run needs but does not have yet (a target URL, a
   * recipient, a spreadsheet id). Collected with an inline form in the chat
   * panel instead of a stack of blocking window.prompt dialogs. When set, the
   * chat shows one field per input and a "Run with these" button.
   */
  const [pendingInputs, setPendingInputs] = useState<RequiredInput[] | null>(null);
  const [pendingInputValues, setPendingInputValues] = useState<Record<string, string>>({});
  /** Bumped by the input collector to request a run after the node write flushes. */
  const [runRequestToken, setRunRequestToken] = useState(0);
  /**
   * A decision the run needs from the operator, asked IN THE CHAT rather than
   * through a native window.confirm. Either offer to resume a saved run, or ask
   * to connect a tool before starting.
   */
  const [pendingRunAction, setPendingRunAction] = useState<
    | { kind: 'resume'; fromFailed: boolean }
    | { kind: 'auth'; tools: { id: string; name: string }[] }
    | null
  >(null);
  /**
   * Targeted fixes offered after a failed run — a short list of specific
   * candidate patches (each a canned instruction), plus a "write my own"
   * option. Rendered as a chat card mirroring the pendingPatch pattern.
   */
  const [pendingFixes, setPendingFixes] = useState<FixSuggestion[] | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      const saved = localStorage.getItem('autoagent_selected_model');
      if (saved) return saved;
    } catch {
      // Storage unavailable (private mode): fall back to the default model.
    }
    return 'auto';
  });

  useEffect(() => {
    try {
      localStorage.setItem('autoagent_selected_model', selectedModel);
    } catch {
      // Storage unavailable (private mode): selection stays in memory only.
    }
  }, [selectedModel]);
  const [generationStatuses, setGenerationStatuses] = useState<
    Record<string, 'pending' | 'generating' | 'done' | 'error'>
  >({});
  const { fitView } = useReactFlow();

  const effectiveModel = useMemo(() => {
    if (!selectedModel || selectedModel === 'auto') {
      return AI_CONFIG.getRecommendedModel(getActivePrompt());
    }
    return selectedModel;
  }, [getActivePrompt, selectedModel]);

  // Refresh saved workflows list
  // Refresh saved workflows list
  useEffect(() => {
    listWorkflows().then(setSavedList);
  }, []);

  const handleSave = useCallback(async () => {
    if (!workflowName.trim()) return;
    try {
      const nextName = workflowName.trim();
      await saveWorkflow(nextName, nodes, edges, undefined, {
        provider: AI_CONFIG.provider,
        runCount: 0,
        tags: ['workflow', AI_CONFIG.provider],
        version: 1,
        savedAt: new Date().toISOString(),
        metadata: {
          benchmark: AI_CONFIG.benchmark,
          lastSelectedModel: selectedModel,
          lastExecutionStatus: 'idle',
        },
      });
      setActiveWorkflowName(nextName);
      const list = await listWorkflows();
      setSavedList(list);
      setShowSaveDialog(false);
      setWorkflowName('');
    } catch (e) {
      console.error(e);
      alert('Failed to save workflow');
    }
  }, [workflowName, nodes, edges, selectedModel]);

  const handleLoad = useCallback(
    async (name: string) => {
      const wf = await loadWorkflow(name);
      if (!wf) return;
      setActiveWorkflowName(name);
      setNodes(wf.nodes);
      setEdges(wf.edges);
      setTimeout(() => fitView({ padding: 0.2 }), 100);
    },
    [setNodes, setEdges, fitView],
  );

  const handleDelete = useCallback(async (name: string) => {
    if (!confirm(`Delete workflow "${name}"?`)) return;
    try {
      await deleteWorkflow(name);
      const list = await listWorkflows();
      setSavedList(list);
    } catch (e) {
      console.error(e);
      alert('Failed to delete workflow');
    }
  }, []);

  const {
    isExecuting,
    executionLogs,
    graphState,
    currentNodeLabel,
    runtimeStatus,
    executeFlow,
    pauseExecution,
    resumeExecution,
    cancelExecution,
    clearLogs,
  } = useWorkflowExecution(nodes, edges, setNodes, async (payload) => {
    setApprovalRequest(payload);
    return await new Promise<boolean>((resolve) => {
      const original = payload;
      const approve = () => {
        setApprovalRequest(null);
        resolve(true);
      };
      const reject = () => {
        setApprovalRequest(null);
        resolve(false);
      };
      setApprovalRequest({ ...original, message: payload.message });
      (window as any).__workflowApprovalHandlers = { approve, reject };
    });
  });
  const { toolStatuses, authInProgress, authenticate } = useTools();
  const { undo, redo, canUndo, canRedo } = useUndoRedo(nodes, edges, setNodes, setEdges);
  const {
    versions,
    currentIndex: versionIndex,
    canGoBack: canGoBackVersion,
    canGoForward: canGoForwardVersion,
    snapshot: snapshotVersion,
    goTo: goToVersion,
  } = useWorkflowVersions(activeTaskId ?? undefined);
  const [showVersionMenu, setShowVersionMenu] = useState(false);
  /** The version picker shown in the chat footer (distinct from the toolbar one). */
  const [showChatVersions, setShowChatVersions] = useState(false);

  // Offer to resume a saved run — in the CHAT, not a native popup. Fires once
  // per mount when a resumable checkpoint exists; the operator answers with the
  // Resume / Start fresh buttons on the card (see pendingRunAction rendering).
  const checkpointOfferedRef = React.useRef(false);
  useEffect(() => {
    if (checkpointOfferedRef.current) return;
    try {
      const raw = localStorage.getItem('autoagent_runtime_checkpoint');
      if (!raw) return;
      const checkpoint = JSON.parse(raw);
      if (!checkpoint || !checkpoint.graphState) return;
      const isResumable = ['running', 'paused', 'failed'].includes(checkpoint.status);
      if (!isResumable || !nodes.length || !activeTaskId) return;

      checkpointOfferedRef.current = true;
      setShowChatPanel(true);
      setPendingRunAction({ kind: 'resume', fromFailed: checkpoint.status === 'failed' });
      updateActiveTaskMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text:
            `There is an unfinished run from ${checkpoint.status === 'failed' ? 'a failed step' : 'earlier'}. ` +
            `Want me to resume it from where it stopped, or start fresh?`,
        },
      ]);
    } catch (err) {
      console.warn('[WorkflowCanvas] Unable to restore execution checkpoint:', err);
    }
  }, [nodes.length, activeTaskId, updateActiveTaskMessages]);

  // Keyboard shortcuts for undo/redo
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [undo, redo]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId],
  );

  // Calculate all available input keys from used tools + existing state
  const availableWorkflowKeys = useMemo(() => {
    if (selectedNodeId !== 'root') return [];
    const keys = new Set<string>();

    // 1. Add existing initialState keys
    if (selectedNode?.data.initialState) {
      Object.keys(selectedNode.data.initialState).forEach((k) => keys.add(k));
    }

    // 2. Add keys from tools found via toolId
    nodes.forEach((n) => {
      if (n.data.toolId) {
        const tool = getTool(n.data.toolId);
        if (tool) {
          // If toolAction matches, use that action's keys
          const action = tool.actions.find((a) => a.name === n.data.toolAction);
          if (action?.inputKeys) {
            action.inputKeys.forEach((k) => keys.add(k));
          } else {
            // No matching action — add ALL action keys from this tool
            tool.actions.forEach((a) => a.inputKeys.forEach((k) => keys.add(k)));
          }
        }
      }
    });

    // 3. Scan node labels/descriptions for tool name mentions (fallback matching)
    const allTools = getAllTools();
    nodes.forEach((n) => {
      if (n.data.toolId) return; // Already handled above
      const text = ((n.data.label || '') + ' ' + (n.data.description || '')).toLowerCase();
      for (const tool of allTools) {
        const mentions = [tool.name.toLowerCase(), tool.id.toLowerCase()];
        if (mentions.some((kw) => text.includes(kw))) {
          tool.actions.forEach((a) => a.inputKeys.forEach((k) => keys.add(k)));
          break;
        }
      }
    });

    return Array.from(keys).sort();
  }, [nodes, selectedNodeId, selectedNode]);
  const showSplash = nodes.length === 0 && !isGenerating;
  const showGeneratingOverlay = nodes.length === 0 && isGenerating;

  const onConnectStart = useCallback(
    (
      _: React.MouseEvent | React.TouchEvent,
      params: { nodeId?: string | null; handleType?: string | null; handleId?: string | null },
    ) => {
      if (!params.nodeId) return;

      const sourceNode = nodes.find((n) => n.id === params.nodeId);
      if (!sourceNode) return;

      setConnectionSuggestion({
        source: params.nodeId,
        position: {
          x: sourceNode.position.x + 260,
          y: sourceNode.position.y + 180,
        },
      });
    },
    [nodes],
  );

  const onConnect = useCallback(
    (params: Connection | Edge) => {
      if (!params.source) return;

      const sourceNode = nodes.find((n) => n.id === params.source);
      if (!sourceNode) return;

      if (!params.target) {
        setConnectionSuggestion({
          source: params.source,
          position: { x: sourceNode.position.x + 260, y: sourceNode.position.y + 180 },
        });
        return;
      }

      const targetNode = nodes.find((n) => n.id === params.target);
      if (!targetNode) {
        setEdges((eds) =>
          addEdge(
            {
              ...params,
              animated: true,
              style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' },
            },
            eds,
          ),
        );
        return;
      }

      const midX = (sourceNode.position.x + targetNode.position.x) / 2 + 180;
      const midY = (sourceNode.position.y + targetNode.position.y) / 2 + 60;
      setConnectionSuggestion({
        source: params.source,
        target: params.target,
        position: { x: midX, y: midY },
      });
    },
    [nodes, setEdges],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => setSelectedNodeId(node.id),
    [],
  );
  const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

  const handleMagicGenerate = async () => {
    const prompt = getActivePrompt();
    const promptAnalysis = isMeaningfulWorkflowPrompt(prompt);
    if (!promptAnalysis.valid) {
      if (activeTaskId) {
        setTaskSessions((prev) =>
          prev.map((task) =>
            task.id === activeTaskId
              ? {
                  ...task,
                  name: deriveTaskNameFromPrompt(prompt) || task.name,
                  messages: [
                    ...task.messages,
                    {
                      role: 'assistant',
                      text: promptAnalysis.reason || 'Please describe a concrete workflow goal.',
                    },
                  ],
                }
              : task,
          ),
        );
      }
      return;
    }

    const activeId = ensureActiveTask();
    const nextTaskTimestamp = Date.now();
    setSidebarOpen(false);
    setShowChatPanel(true);
    setActiveTaskId((current) => current ?? activeId ?? `task-${nextTaskTimestamp}`);

    if (activeId) {
      const nextName = deriveTaskNameFromPrompt(prompt);
      setTaskSessions((prev) =>
        prev.map((task) =>
          task.id === activeId
            ? {
                ...task,
                name: normalizeTaskTitle(nextName || task.name),
                messages: [
                  ...task.messages,
                  { role: 'user', text: prompt },
                  {
                    role: 'assistant',
                    text: "I'm validating your workflow request and building the plan before execution.",
                  },
                ],
              }
            : task,
        ),
      );
    }

    setIsGenerating(true);
    try {
      const modelForGeneration = effectiveModel;
      const plan = await generateWorkflowPlan(
        promptAnalysis.normalized || prompt,
        modelForGeneration,
      );
      setPlanDraft({
        id: `plan-${Date.now()}`,
        plan,
        workflow: planToWorkflow(plan),
      });
      setGenerationStatuses({});
      setPlanStep(0);
      setIsCommittingPlan(false);
      setActiveTaskDraft('');
      setMagicPrompt('');
      if (activeId) {
        setTaskSessions((prev) =>
          prev.map((task) =>
            task.id === activeId
              ? {
                  ...task,
                  messages: [
                    ...task.messages,
                    {
                      role: 'assistant',
                      text: 'Your workflow draft is ready. I can refine, route, or execute it next.',
                    },
                  ],
                }
              : task,
          ),
        );
      }
    } catch (err) {
      console.error(err);
      // Say which of the two failed: a plan that contradicted the tool
      // catalog needs a different fix from a provider that was unreachable.
      const detail =
        err instanceof PlanValidationError
          ? `I could not build a plan that matches the connected tools:\n- ${err.issues.join('\n- ')}`
          : err instanceof Error
            ? `I hit a problem generating that flow: ${err.message}`
            : 'I hit a problem generating that flow.';

      if (activeId) {
        setTaskSessions((prev) =>
          prev.map((task) =>
            task.id === activeId
              ? {
                  ...task,
                  messages: [...task.messages, { role: 'assistant', text: detail }],
                }
              : task,
          ),
        );
      }
    } finally {
      setIsGenerating(false);
    }
  };

  /**
   * Apply a validated patch to the canvas and report exactly what changed.
   */
  const applyGraphPatch = useCallback(
    (patch: GraphPatch) => {
      const result = applyPatch(
        {
          nodes: nodes as unknown as WorkflowNodeModel[],
          edges: edges as unknown as WorkflowEdge[],
        },
        patch,
      );

      setNodes(result.nodes as unknown as Node[]);
      setEdges(
        result.edges.map((edge) => ({
          ...edge,
          animated: true,
          style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
          markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' },
        })) as unknown as Edge[],
      );

      const changes =
        result.applied.length > 0
          ? result.applied.map((line) => `- ${line}`).join('\n')
          : '- nothing changed';

      // Capture the resulting graph as a labeled version the user can switch
      // back to. Snapshot the patched graph (result.*), not the pre-patch
      // nodes/edges still in state this render.
      const version = snapshotVersion(
        result.nodes as unknown as Node[],
        result.edges as unknown as Edge[],
        patch.summary || result.applied[0] || 'workflow change',
      );

      updateActiveTaskMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: `${patch.summary || 'Applied your change.'}\n${changes}\n[${version.label}] saved — you can switch back to any version from the toolbar.`,
        },
      ]);
    },
    [nodes, edges, setNodes, setEdges, updateActiveTaskMessages, snapshotVersion],
  );

  /**
   * Put a saved version back on the canvas. The undo/redo observer is suppressed
   * for the restore so switching versions does not itself create a fresh undo
   * entry the user then has to step through.
   */
  const switchToVersion = useCallback(
    (index: number) => {
      const restored = goToVersion(index, (vNodes, vEdges) => {
        setNodes(vNodes);
        setEdges(vEdges);
      });
      setShowVersionMenu(false);
      if (restored) {
        updateActiveTaskMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: `Switched to ${restored.label} — ${restored.summary}.`,
          },
        ]);
      }
    },
    [goToVersion, setNodes, setEdges, updateActiveTaskMessages],
  );

  /**
   * Run one chat-edit instruction through the real patch pipeline
   * (generate → validate → apply), the same path a typed instruction takes.
   * Extracted so a canned failure-fix prompt reuses it verbatim. Returns whether
   * a patch was applied, so the caller can decide whether to re-run.
   */
  const runPatchInstruction = useCallback(
    async (instruction: string): Promise<boolean> => {
      updateActiveTaskMessages((prev) => [...prev, { role: 'user', text: instruction }]);
      setIsPatching(true);
      try {
        const patch = await generateGraphPatch(
          instruction,
          {
            nodes: nodes as unknown as WorkflowNodeModel[],
            edges: edges as unknown as WorkflowEdge[],
          },
          effectiveModel,
        );
        if (patch.operations.length === 0) {
          updateActiveTaskMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              text:
                patch.clarification ||
                'I could not turn that into a change. Can you say it a different way?',
            },
          ]);
          return false;
        }
        applyGraphPatch(patch);
        return true;
      } catch (error) {
        const detail =
          error instanceof PatchValidationError
            ? `I could not turn that into a valid change:\n- ${error.issues.join('\n- ')}`
            : error instanceof Error
              ? `I could not apply that change: ${error.message}`
              : 'I could not apply that change.';
        updateActiveTaskMessages((prev) => [...prev, { role: 'assistant', text: detail }]);
        return false;
      } finally {
        setIsPatching(false);
      }
    },
    [nodes, edges, effectiveModel, applyGraphPatch, updateActiveTaskMessages],
  );

  /**
   * Handle a click on one of the post-failure fix suggestions. A `patch` fix
   * runs its canned instruction and, on success, re-runs the workflow. The
   * others route to the existing mechanisms (reconnect via a plain re-run, a
   * value change via the input collector, retry via a re-run, custom via the
   * chat box).
   */
  const applyFixSuggestion = useCallback(
    async (fix: FixSuggestion) => {
      setPendingFixes(null);
      if (fix.kind === 'custom') {
        updateActiveTaskMessages((prev) => [
          ...prev,
          { role: 'assistant', text: 'Okay — describe the fix below and I will apply it.' },
        ]);
        setShowChatPanel(true);
        return;
      }
      if (fix.kind === 'change_input') {
        // Reuse the input collector: pre-fill current values so the user just
        // edits and re-runs.
        const editable = requiredInputsForRun(nodes as unknown as WorkflowNodeModel[]);
        if (editable.length > 0) {
          setPendingInputs(editable);
          setPendingInputValues(Object.fromEntries(editable.map((i) => [i.key, i.value])));
        }
        return;
      }
      if (fix.kind === 'reconnect' || fix.kind === 'retry') {
        // Nothing to patch — just run again (reconnect is handled by the run's
        // own auth gate, which will prompt if a tool is still disconnected).
        setRunRequestToken((token) => token + 1);
        return;
      }
      // A concrete graph patch: apply it, then re-run if it stuck.
      const applied = await runPatchInstruction(fix.prompt ?? '');
      if (applied) setRunRequestToken((token) => token + 1);
    },
    [nodes, runPatchInstruction, updateActiveTaskMessages],
  );

  /**
   * Chat editing.
   *
   * The model returns operations against the real graph; every one is validated
   * against that graph and the tool catalog before anything is applied. There is
   * deliberately NO fallback: the previous implementation could not fail to do
   * something, so an instruction it had no branch for — "I didn't mention Google
   * Sheets, fix it" — fell through to adding an unrelated node. An instruction
   * that cannot be mapped now produces a question or an error instead.
   */
  const handleWorkflowChatSubmit = useCallback(async () => {
    const instruction = chatInput.trim();
    if (!instruction || !activeTaskId || isPatching) return;

    updateActiveTaskMessages((prev) => [...prev, { role: 'user', text: instruction }]);
    setChatInput('');
    setPendingPatch(null);

    if (nodes.length === 0) {
      updateActiveTaskMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: 'There is no workflow on the canvas yet. Describe what you want built and I will plan it first.',
        },
      ]);
      return;
    }

    setIsPatching(true);
    try {
      const patch = await generateGraphPatch(
        instruction,
        {
          nodes: nodes as unknown as WorkflowNodeModel[],
          edges: edges as unknown as WorkflowEdge[],
        },
        effectiveModel,
      );

      // An ambiguous instruction comes back as a question. Asking is the
      // honest response; guessing is what produced the reported defect.
      if (patch.operations.length === 0) {
        updateActiveTaskMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text:
              patch.clarification ||
              'I could not tell what to change. Can you say which step you mean?',
          },
        ]);
        return;
      }

      // Removing or replacing a node loses its configuration, and canvas
      // undo does not record history yet, so those are confirmed first.
      if (isDestructive(patch)) {
        setPendingPatch(patch);
        updateActiveTaskMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            text: `${patch.summary || 'Here is what I would change.'}\nThis removes or replaces steps, so confirm it below before I apply it.`,
          },
        ]);
        return;
      }

      applyGraphPatch(patch);
    } catch (error) {
      console.error('Workflow chat edit failed:', error);
      const detail =
        error instanceof PatchValidationError
          ? `I could not turn that into a valid change:\n- ${error.issues.join('\n- ')}`
          : error instanceof Error
            ? `I could not apply that change: ${error.message}`
            : 'I could not apply that change.';
      updateActiveTaskMessages((prev) => [...prev, { role: 'assistant', text: detail }]);
    } finally {
      setIsPatching(false);
    }
  }, [
    activeTaskId,
    applyGraphPatch,
    chatInput,
    edges,
    effectiveModel,
    isPatching,
    nodes,
    updateActiveTaskMessages,
  ]);

  /**
   * Put the reviewed graph on the canvas.
   *
   * The argument is the draft as the user LEFT it in the preview — renamed
   * steps, deleted steps, filled-in values and all — not the plan as generated.
   * Nothing is re-derived here: what the preview showed is what lands.
   */
  const handleCommitPlan = async (reviewed: Workflow) => {
    const formattedNodes = reviewed.nodes.map((node) => ({
      ...node,
      position: { x: node.position.x + 300, y: node.position.y + 150 },
    }));

    const formattedEdges = reviewed.edges.map((edge) => ({
      ...edge,
      animated: true,
      style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' },
    }));

    setIsCommittingPlan(true);
    setPlanStep(0);

    // Streamed one at a time purely so the user can see what arrived. There
    // is no model call in this loop — node data came from the validated plan
    // step via `buildNodeFromPlanStep`.
    for (let i = 0; i < formattedNodes.length; i++) {
      const node = formattedNodes[i];
      setGenerationStatuses((prev) => ({ ...prev, [node.id]: 'generating' }));
      await new Promise((resolve) => setTimeout(resolve, 120));
      // Seed v1 = the ORIGINAL node config as it was generated, so the very
      // first patch adds v2 and the user can always switch back to how the node
      // started — the "before any change" baseline.
      const seeded = { ...node, data: pushNodeVersion(node.data as unknown as NodeData) };
      setNodes((prev) => [...prev, seeded as Node]);
      setGenerationStatuses((prev) => ({ ...prev, [node.id]: 'done' }));
      setPlanStep(i + 1);
    }

    setEdges(formattedEdges as Edge[]);
    setMagicPrompt('');
    setPlanDraft(null);
    setIsCommittingPlan(false);
    setTimeout(() => fitView({ padding: 0.2 }), 100);
  };

  /**
   * Analyzes the workflow to find which tools are required
   */
  const getRequiredTools = useCallback(() => {
    const requiredToolIds = new Set<string>();

    nodes.forEach((node) => {
      if (node.data.type === NodeType.TOOL && node.data.toolId) {
        requiredToolIds.add(node.data.toolId);
      }
    });

    return Array.from(requiredToolIds);
  }, [nodes]);

  /**
   * Checks if all required tools are authenticated
   * Returns { allAuthenticated: boolean, missingTools: ToolStatus[] }
   */
  const checkRequiredAuthentication = useCallback(() => {
    const requiredToolIds = getRequiredTools();
    const missingTools = requiredToolIds
      .map((toolId) => toolStatuses.find((t) => t.id === toolId))
      .filter((tool) => tool && !tool.authenticated);

    return {
      allAuthenticated: missingTools.length === 0,
      missingTools: missingTools.filter((t) => t !== undefined),
    };
  }, [getRequiredTools, toolStatuses]);

  const handleBlankAgent = () => {
    const triggerNode: Node = {
      id: 'trigger_start',
      type: 'trigger',
      position: { x: 260, y: 140 },
      data: {
        label: 'Start',
        type: NodeType.TRIGGER,
        description: 'Workflow trigger node',
        stateContract: { inputKeys: [], outputKeys: ['trigger_data'] },
      },
    };

    setNodes([triggerNode]);
    setEdges([]);
    setSelectedNodeId(triggerNode.id);
  };

  const insertReusableNodeBetween = useCallback(
    (
      template: {
        label: string;
        description: string;
        nodeType: NodeType;
        toolId?: string;
        toolAction?: string;
        stateContract?: { inputKeys: string[]; outputKeys: string[] };
      },
      source: string,
      target?: string,
    ) => {
      if (!source) return;

      const newNodeId = createNodeId(template.label);

      const sourceNode = nodes.find((n) => n.id === source);
      const targetNode = target ? nodes.find((n) => n.id === target) : undefined;
      const insertPosition =
        sourceNode && targetNode
          ? {
              x: (sourceNode.position.x + targetNode.position.x) / 2,
              y: (sourceNode.position.y + targetNode.position.y) / 2 + 120,
            }
          : sourceNode
            ? { x: sourceNode.position.x + 220, y: sourceNode.position.y + 150 }
            : { x: 500, y: 220 };

      const newNode: Node = {
        id: newNodeId,
        type:
          template.nodeType === NodeType.TOOL
            ? 'tool'
            : template.nodeType === NodeType.LOGIC
              ? 'logic'
              : template.nodeType === NodeType.OUTPUT
                ? 'output'
                : 'ai_agent',
        position: insertPosition,
        data: {
          label: template.label,
          type: template.nodeType,
          description: template.description,
          ...(template.toolId && template.toolAction
            ? { toolId: template.toolId, toolAction: template.toolAction }
            : {}),
          stateContract: template.stateContract || { inputKeys: [], outputKeys: ['result'] },
        },
      };

      const firstEdge = {
        id: `edge_${source}_${newNodeId}`,
        source,
        target: newNodeId,
        animated: true,
        style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' },
      };

      const finalEdges: Edge[] = target
        ? [
            {
              id: `edge_${newNodeId}_${target}`,
              source: newNodeId,
              target,
              animated: true,
              style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
              markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' },
            } as Edge,
          ]
        : [];

      setNodes((prev) => [...prev, newNode]);
      setEdges((prev) => {
        const filtered = target
          ? prev.filter((edge) => !(edge.source === source && edge.target === target))
          : prev.filter((edge) => edge.source !== source || edge.target !== newNodeId);

        return [...filtered, firstEdge as Edge, ...finalEdges];
      });
      setConnectionSuggestion(null);
    },
    [nodes, setNodes, setEdges],
  );

  const addReusableNode = useCallback(
    (template: {
      label: string;
      description: string;
      nodeType: NodeType;
      toolId?: string;
      toolAction?: string;
      stateContract?: { inputKeys: string[]; outputKeys: string[] };
    }) => {
      const newNodeId = createNodeId(template.label);
      const existingCount = nodes.length;

      const baseNode: Node = {
        id: newNodeId,
        type:
          template.nodeType === NodeType.TOOL
            ? 'tool'
            : template.nodeType === NodeType.LOGIC
              ? 'logic'
              : template.nodeType === NodeType.OUTPUT
                ? 'output'
                : 'ai_agent',
        position: {
          x: 300 + (existingCount % 4) * 260,
          y: 180 + Math.floor(existingCount / 4) * 180,
        },
        data: {
          label: template.label,
          type: template.nodeType,
          description: template.description,
          ...(template.toolId && template.toolAction
            ? { toolId: template.toolId, toolAction: template.toolAction }
            : {}),
          stateContract: template.stateContract || { inputKeys: [], outputKeys: ['result'] },
        },
      };

      setNodes((prev) => [...prev, baseNode]);
    },
    [nodes, setNodes],
  );

  const validateWorkflowForExecution = useCallback(() => {
    if (nodes.length === 0) {
      return { valid: false, message: 'Add at least one workflow node before running.' };
    }

    const triggerNodes = nodes.filter((node) => node.type === 'trigger');
    if (triggerNodes.length === 0) {
      return { valid: false, message: 'Every workflow needs a trigger node before execution.' };
    }

    const invalidNodes = nodes.filter((node) => {
      if (!node.data || (!node.data.toolId && !node.data.toolAction)) return false;
      return !node.data.toolId || !node.data.toolAction;
    });

    if (invalidNodes.length > 0) {
      return {
        valid: false,
        message: `Some tool nodes are incomplete: ${invalidNodes.map((n) => n.data.label || n.id).join(', ')}`,
      };
    }

    const missingToolDefinitions = nodes.filter(
      (node) => node.data.toolId && !getTool(node.data.toolId),
    );
    if (missingToolDefinitions.length > 0) {
      return {
        valid: false,
        message: `Tool registry is missing definitions for: ${missingToolDefinitions.map((n) => n.data.toolId).join(', ')}`,
      };
    }

    const orphanNodes = nodes.filter((node) => {
      const nodeHasSource = edges.some((edge) => edge.source === node.id);
      const nodeHasTarget = edges.some((edge) => edge.target === node.id);
      return node.type !== 'trigger' && !nodeHasSource && !nodeHasTarget;
    });

    if (orphanNodes.length > 0) {
      return {
        valid: false,
        message: `These workflow nodes are disconnected: ${orphanNodes.map((n) => n.data.label || n.id).join(', ')}`,
      };
    }

    // Validate edge conditions before the run rather than discovering a bad
    // one mid-execution. At run time an undecidable condition fails closed,
    // which silently drops a branch — surfacing it here explains why instead.
    const badConditions = (edges as FlowEdge[])
      .map((edge) => ({ edge, error: validateCondition(edge.condition ?? '') }))
      .filter((entry): entry is { edge: FlowEdge; error: string } => entry.error !== null);

    if (badConditions.length > 0) {
      const details = badConditions
        .map(({ edge, error }) => {
          const from = nodes.find((n) => n.id === edge.source)?.data.label || edge.source;
          const to = nodes.find((n) => n.id === edge.target)?.data.label || edge.target;
          return `"${from}" to "${to}": ${error}`;
        })
        .join('\n');
      return {
        valid: false,
        message: `Some branch conditions are not valid, so those paths could never be taken:\n\n${details}`,
      };
    }

    return { valid: true, message: 'Workflow ready' };
  }, [nodes, edges]);

  /**
   * Write supplied input values onto every node that declares the key.
   *
   * Written in BOTH places a run reads from: the top-level `node.data[key]`
   * (used when a tool node builds its call) and `node.data.initialState[key]`
   * (which seeds the graph state and is what the executor's pre-flight scans).
   * Writing only one leaves the run either without the value or still reporting
   * it as missing.
   */
  const writeInputsToNodes = useCallback(
    (values: Record<string, string>) => {
      setNodes((prev) =>
        prev.map((node) => {
          const contract = node.data?.stateContract || {};
          const declared = Array.isArray(contract.externalInputKeys)
            ? contract.externalInputKeys
            : Array.isArray(contract.inputKeys)
              ? contract.inputKeys
              : [];
          const applicable = Object.entries(values).filter(
            ([key, value]) => declared.includes(key) && value.trim() !== '',
          );
          if (applicable.length === 0) return node;

          const nextData = { ...node.data };
          const nextInitial = { ...(node.data.initialState || {}) };
          for (const [key, value] of applicable) {
            nextData[key] = value.trim();
            nextInitial[key] = value.trim();
          }
          nextData.initialState = nextInitial;
          return { ...node, data: nextData };
        }),
      );
    },
    [setNodes],
  );

  /**
   * Gate a run on its required inputs.
   *
   * When something is still missing, open the inline collector in the chat
   * panel (friendly form + Run button) instead of a stack of blocking
   * window.prompt dialogs, and return false so this run attempt stops — the
   * collector's own button restarts it once the values are in.
   */
  const collectRequiredInputsBeforeExecution = useCallback(() => {
    const graph = nodes as unknown as WorkflowNodeModel[];
    // Only genuinely-required, still-blank values block the run.
    const missingRequired = missingRequiredInputs(graph);
    if (missingRequired.length === 0) return true;

    // The card shows the required-blank fields PLUS any optional ones, so the
    // user can choose to provide extras — each explained by its description.
    const toShow = inputsToCollect(graph);
    setPendingInputs(toShow);
    setPendingInputValues(Object.fromEntries(toShow.map((input) => [input.key, input.value])));
    setShowChatPanel(true);
    updateActiveTaskMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        text:
          `Before I can run this, I need ${missingRequired.length === 1 ? 'a value' : `${missingRequired.length} values`} ` +
          `nothing in the workflow produces: ${missingRequired.map((i) => `"${i.label}"`).join(', ')}. ` +
          `Fill ${missingRequired.length === 1 ? 'it' : 'them'} in below and I'll run it.`,
      },
    ]);
    return false;
  }, [nodes, updateActiveTaskMessages]);

  /**
   * Submit the inline input form: write the values onto the nodes, echo the
   * user's answers into the chat, and request a run. The run itself is fired by
   * an effect once the node update has flushed (see `runRequestToken`), so the
   * executor's pre-flight sees the freshly-written values rather than racing
   * the setNodes above.
   */
  const submitPendingInputs = useCallback(() => {
    if (!pendingInputs) return;
    // Only REQUIRED fields must be filled; optional ones may be left blank.
    const requiredBlank = pendingInputs.some(
      (input) => input.required && !(pendingInputValues[input.key] ?? '').trim(),
    );
    if (requiredBlank) return; // Run button is disabled in this state anyway.

    // Write only the fields the user actually provided (skip blank optionals).
    const values: Record<string, string> = {};
    for (const input of pendingInputs) {
      const value = (pendingInputValues[input.key] ?? '').trim();
      if (value) values[input.key] = value;
    }

    writeInputsToNodes(values);
    const provided = pendingInputs
      .filter((input) => values[input.key])
      .map((input) => `${input.label}: ${values[input.key]}`);
    updateActiveTaskMessages((prev) => [
      ...prev,
      {
        role: 'user',
        text: provided.length > 0 ? provided.join('\n') : 'Run it.',
      },
    ]);
    setPendingInputs(null);
    setPendingInputValues({});
    setRunRequestToken((token) => token + 1);
  }, [pendingInputs, pendingInputValues, writeInputsToNodes, updateActiveTaskMessages]);

  /**
   * Open the input editor on demand — every external input the workflow takes,
   * pre-filled with its current value — so the user can change a value (e.g. a
   * bad URL that returned an error page) and re-run, straight from the chat,
   * without a successful-but-wrong run being a dead end. Always available, not
   * just after a failure.
   */
  const openInputEditor = useCallback(() => {
    const graph = nodes as unknown as WorkflowNodeModel[];
    const editable = requiredInputsForRun(graph);
    setShowChatPanel(true);
    if (editable.length === 0) {
      updateActiveTaskMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text: 'This workflow has no external inputs to change. Add a step that takes one, or edit a node in its settings.',
        },
      ]);
      return;
    }
    setPendingInputs(editable);
    setPendingInputValues(Object.fromEntries(editable.map((i) => [i.key, i.value])));
    updateActiveTaskMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        text: `Change ${editable.length === 1 ? 'the value' : 'any values'} below and I'll re-run: ${editable
          .map((i) => i.label)
          .join(', ')}.`,
      },
    ]);
  }, [nodes, updateActiveTaskMessages]);

  const handleExecuteFlow = async () => {
    const hasAllInputs = collectRequiredInputsBeforeExecution();
    if (!hasAllInputs) {
      return;
    }

    // Observability: time the run and capture its shape so the outcome recorded
    // in run history carries a duration and node count, not just a status.
    const runStartedAt = new Date();
    const runNodeCount = nodes.length;

    const validation = validateWorkflowForExecution();
    if (!validation.valid) {
      // Report the problem in the chat instead of a native alert.
      setShowChatPanel(true);
      updateActiveTaskMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `I can't run this yet: ${validation.message}` },
      ]);
      return;
    }

    // Any tools that still need connecting? Ask in the chat, not a popup.
    const { allAuthenticated, missingTools } = checkRequiredAuthentication();
    if (!allAuthenticated && missingTools.length > 0) {
      setShowChatPanel(true);
      setPendingRunAction({
        kind: 'auth',
        tools: missingTools.map((t) => ({ id: t.id, name: t.name })),
      });
      updateActiveTaskMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          text:
            `This workflow uses ${missingTools.map((t) => t.name).join(', ')}, which ${missingTools.length === 1 ? 'is' : 'are'} not connected yet. ` +
            `Connect ${missingTools.length === 1 ? 'it' : 'them'} below and I'll run it.`,
        },
      ]);
      return;
    }

    try {
      setAuthReconnect(null);
      setIsTesting(true);
      setShowChatPanel(true);
      if (activeTaskId) {
        setTaskSessions((prev) =>
          prev.map((task) =>
            task.id === activeTaskId
              ? {
                  ...task,
                  messages: [
                    ...task.messages,
                    {
                      role: 'assistant',
                      text: 'Running the current workflow and streaming execution updates here.',
                    },
                  ],
                }
              : task,
          ),
        );
      }
      // executeFlow returns the full run report synchronously, so the chat can
      // show the per-node outcome without racing React state.
      const summary = await executeFlow();
      updateActiveTaskMessages((prev) => [
        ...prev,
        { role: 'assistant', text: buildRunReport(summary) },
      ]);

      // If the run failed for a reason a DIFFERENT input value could fix — a bad
      // URL, a wrong recipient, an id that 404s — and the workflow actually has
      // external inputs, offer to try again with new values right here. A
      // transient/rate-limit failure is not the input's fault, so we don't
      // re-ask for it in that case.
      if (summary.status === 'failed') {
        const failedStep = summary.logs.find((log) => log.status === 'failed');

        // Offer targeted fixes for the actual failure — a short list of specific
        // options (reconnect, change value, render the page, swap tool…) plus a
        // "write my own" custom option — instead of one catch-all.
        if (failedStep) {
          const fixes = suggestFixes({
            node: failedStep.node,
            failureKind: failedStep.failureKind,
            alternatives: failedStep.alternatives,
            output: failedStep.output,
          });
          setPendingFixes(fixes);
          updateActiveTaskMessages((prev) => [
            ...prev,
            {
              role: 'assistant',
              text: `“${failedStep.node}” failed. Here are a few ways I can fix it — pick one below, or write your own.`,
            },
          ]);
        }
      }

      if (activeWorkflowName) {
        const { recordWorkflowRun } = await import('@features/workflow/services/workflowStorage');
        const finishedAt = new Date();
        const failedStep = summary.logs.find((log) => log.status === 'failed');
        await recordWorkflowRun(activeWorkflowName, {
          // Record the REAL outcome, not always 'completed'.
          status: summary.status === 'completed' ? 'completed' : 'failed',
          failureKind: failedStep?.failureKind,
          error: failedStep ? summarizeOutput(failedStep.output) : undefined,
          model: effectiveModel,
          provider: effectiveModel,
          nodeCount: runNodeCount,
          failureCount: summary.logs.filter((log) => log.status === 'failed').length,
          durationMs: finishedAt.getTime() - runStartedAt.getTime(),
          startedAt: runStartedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        });
        setRunHistoryReloadKey((k) => k + 1);
      }
      setIsTesting(false);
    } catch (err) {
      const errorText = String(err || 'Workflow execution failed');
      const lower = errorText.toLowerCase();
      const isAuthIssue =
        lower.includes('auth') ||
        lower.includes('expired') ||
        lower.includes('not authenticated') ||
        lower.includes('connect it first');

      if (activeTaskId) {
        setTaskSessions((prev) =>
          prev.map((task) =>
            task.id === activeTaskId
              ? {
                  ...task,
                  messages: [
                    ...task.messages,
                    { role: 'assistant', text: `Execution failed: ${errorText}` },
                  ],
                }
              : task,
          ),
        );
      }

      if (isAuthIssue) {
        const toolId =
          toolStatuses.find(
            (t) => lower.includes(t.name.toLowerCase()) || lower.includes(t.id.toLowerCase()),
          )?.id || 'gmail';
        const toolName = toolStatuses.find((t) => t.id === toolId)?.name || 'Gmail';
        setAuthReconnect({ toolId, toolName, message: errorText });
        setIsTesting(false);
        if (activeWorkflowName) {
          const { recordWorkflowRun } = await import('@features/workflow/services/workflowStorage');
          const finishedAt = new Date();
          await recordWorkflowRun(activeWorkflowName, {
            status: 'failed',
            failureKind: 'auth',
            error: errorText,
            model: effectiveModel,
            provider: effectiveModel,
            nodeCount: runNodeCount,
            durationMs: finishedAt.getTime() - runStartedAt.getTime(),
            startedAt: runStartedAt.toISOString(),
            finishedAt: finishedAt.toISOString(),
          });
          setRunHistoryReloadKey((k) => k + 1);
        }
        return;
      }

      if (activeWorkflowName) {
        const { recordWorkflowRun } = await import('@features/workflow/services/workflowStorage');
        const finishedAt = new Date();
        await recordWorkflowRun(activeWorkflowName, {
          status: 'failed',
          error: errorText,
          model: effectiveModel,
          provider: effectiveModel,
          nodeCount: runNodeCount,
          durationMs: finishedAt.getTime() - runStartedAt.getTime(),
          startedAt: runStartedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
        });
        setRunHistoryReloadKey((k) => k + 1);
      }
      // The failure is already reported in the chat above; no native alert.
      setIsTesting(false);
    }
  };

  const handleReconnectAndRerun = async () => {
    if (!authReconnect) return;

    try {
      await authenticate(authReconnect.toolId);
      setAuthReconnect(null);
      await handleExecuteFlow();
    } catch (err) {
      console.error(`Reconnect failed for ${authReconnect.toolName}:`, err);
      const message = err instanceof Error ? err.message : String(err);
      setAuthReconnect({
        ...authReconnect,
        message: `Reconnect failed for ${authReconnect.toolName}: ${message}`,
      });
    }
  };

  /** Resume a saved run (from the chat card), or start fresh by clearing it. */
  const resumeSavedRun = useCallback(() => {
    setPendingRunAction(null);
    updateActiveTaskMessages((prev) => [...prev, { role: 'user', text: 'Resume the saved run.' }]);
    setActiveView('execution');
    setIsTesting(true);
    void executeFlow();
  }, [executeFlow, updateActiveTaskMessages]);

  const startFreshRun = useCallback(() => {
    setPendingRunAction(null);
    clearLogs(); // clears the saved checkpoint
    updateActiveTaskMessages((prev) => [
      ...prev,
      { role: 'assistant', text: 'Cleared the old run. Click Run Flow when you are ready.' },
    ]);
  }, [clearLogs, updateActiveTaskMessages]);

  /** Connect the tools the run needs (from the chat card), then run. */
  const connectPendingTools = useCallback(async () => {
    if (pendingRunAction?.kind !== 'auth') return;
    const tools = pendingRunAction.tools;
    setPendingRunAction(null);
    for (const tool of tools) {
      try {
        await authenticate(tool.id);
      } catch (err) {
        console.error(`[Auth] Could not connect ${tool.name}:`, err);
      }
    }
    // Re-run: the auth gate will pass now, or ask again if a connect failed.
    setRunRequestToken((token) => token + 1);
  }, [pendingRunAction, authenticate]);

  // Fire the run once the inline input collector's values have been written to
  // the nodes. Keyed on a token (not on nodes) so it runs exactly once per
  // submit, after the setNodes flush, so the executor sees the fresh values.
  useEffect(() => {
    if (runRequestToken === 0) return;
    void handleExecuteFlow();
    // handleExecuteFlow is intentionally omitted: it is redefined every render
    // and reads current state; the token is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runRequestToken]);

  const downloadOutput = (content: string, filename: string) => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleClear = () => {
    setNodes([]);
    setEdges([]);
    clearLogs();
  };

  return (
    <div className="flex h-screen w-full bg-[#050505] overflow-hidden text-white relative">
      {approvalRequest && (
        <div className="absolute inset-0 bg-black/70 z-[120] flex items-center justify-center p-6">
          <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#111111] p-6 shadow-2xl">
            <div className="flex items-center gap-3 mb-3">
              <CheckCircle2 className="w-5 h-5 text-amber-400" />
              <div className="text-sm font-bold text-white">Approve workflow step</div>
            </div>
            <p className="text-xs text-white/70 mb-2">
              Node: <span className="font-semibold text-white">{approvalRequest.nodeLabel}</span>
            </p>
            <p className="text-xs text-white/60 leading-6 mb-5">{approvalRequest.message}</p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => {
                  setApprovalRequest(null);
                  (window as any).__workflowApprovalHandlers?.reject?.();
                }}
                className="px-4 py-2 rounded-xl border border-white/10 bg-white/5 text-white/80 text-xs font-semibold hover:bg-white/10"
              >
                Reject
              </button>
              <button
                onClick={() => {
                  setApprovalRequest(null);
                  (window as any).__workflowApprovalHandlers?.approve?.();
                }}
                className="px-4 py-2 rounded-xl bg-amber-500 text-black text-xs font-bold hover:bg-amber-400"
              >
                Approve & Continue
              </button>
            </div>
          </div>
        </div>
      )}
      {sidebarOpen && (
        <aside className="w-64 bg-[#0a0a0a] flex flex-col border-r border-white/5 z-50 shrink-0">
          <div className="p-5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(false)}
                className="p-1 rounded-full hover:bg-white/5 text-white/40 hover:text-white"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="font-bold text-sm tracking-tight text-white/90">AutoAgent</span>
            </div>
          </div>

          <div className="px-5 mb-4">
            <div className="p-4 bg-white/[0.03] border border-white/5 rounded-2xl">
              <p className="text-[11px] font-bold text-white/30 uppercase tracking-widest mb-4">
                Connected Tools
              </p>
              <div className="space-y-3">
                {toolStatuses.map((tool) => (
                  <button
                    key={tool.id}
                    onClick={() => {
                      console.log(
                        `🔑 [Auth] Attempting to ${tool.authenticated ? 're-' : ''}authenticate ${tool.name}...`,
                      );
                      authenticate(tool.id);
                    }}
                    disabled={authInProgress === tool.id}
                    className="w-full flex items-center justify-between group hover:bg-white/5 rounded-lg px-2 py-1.5 transition-all -mx-2"
                  >
                    <div className="flex items-center gap-2">
                      <Mail className="w-3.5 h-3.5" style={{ color: tool.color }} />
                      <span className="text-[11px] font-medium text-white/60 group-hover:text-white/80">
                        {tool.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {authInProgress === tool.id && (
                        <Loader2 className="w-3 h-3 animate-spin text-white/40" />
                      )}
                      <div
                        className={`w-1.5 h-1.5 rounded-full transition-all ${
                          tool.authenticated
                            ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]'
                            : 'bg-white/20'
                        }`}
                      />
                      {tool.authenticated && (
                        <span className="text-[9px] text-white/30 opacity-0 group-hover:opacity-100 transition-opacity">
                          refresh
                        </span>
                      )}
                    </div>
                  </button>
                ))}
                {toolStatuses.length === 0 && (
                  <p className="text-[10px] text-white/30 italic">No tools registered</p>
                )}
              </div>
            </div>
          </div>

          <nav className="flex-1 overflow-y-auto p-4 space-y-2">
            <div className="space-y-3">
              <div className="flex items-center justify-between px-1">
                <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/35">
                  Task Sessions
                </div>
                <button
                  onClick={createNewTask}
                  className="p-1.5 rounded-lg border border-white/10 bg-white/[0.02] text-white/60 hover:text-white hover:bg-white/[0.05]"
                  title="New Task"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="space-y-2">
                {taskSessions.map((task, index) => (
                  <div
                    key={task.id}
                    className={`flex items-center gap-2 rounded-xl border transition-all ${activeTaskId === task.id ? 'border-bolt-accent/40 bg-bolt-accent/10 text-white' : 'border-white/5 bg-white/[0.02] text-white/60 hover:bg-white/[0.04]'}`}
                  >
                    <button
                      onClick={() => {
                        setActiveTaskId(task.id);
                        setChatInput('');
                        setShowChatPanel(true);
                        setSidebarOpen(true);
                      }}
                      className="flex-1 text-left px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-medium truncate">{task.name}</span>
                        <span className="text-[9px] text-white/40">{index + 1}</span>
                      </div>
                      <div className="text-[9px] text-white/35 mt-1">
                        {task.messages.length} messages
                      </div>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete ${task.name}?`)) {
                          handleDeleteTask(task.id);
                        }
                      }}
                      className="mr-2 rounded-lg p-1.5 text-white/35 hover:bg-white/5 hover:text-red-300"
                      title="Delete task"
                      aria-label={`Delete ${task.name}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <button
              onClick={() => setActiveView('graph')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                activeView === 'graph'
                  ? 'bg-white/5 text-white'
                  : 'text-white/40 hover:text-white hover:bg-white/5'
              }`}
            >
              <Box className="w-4 h-4 text-bolt-accent" />
              <span className="text-xs font-semibold">Graph View</span>
            </button>
            <button
              onClick={() => setActiveView(activeView === 'execution' ? 'graph' : 'execution')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                activeView === 'execution'
                  ? 'bg-white/5 text-white'
                  : 'text-white/40 hover:text-white hover:bg-white/5'
              }`}
            >
              <TerminalIcon className="w-4 h-4" />
              <span className="text-xs font-semibold">Execution Hub</span>
            </button>
            <button
              onClick={() => setActiveView(activeView === 'history' ? 'graph' : 'history')}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${
                activeView === 'history'
                  ? 'bg-white/5 text-white'
                  : 'text-white/40 hover:text-white hover:bg-white/5'
              }`}
            >
              <History className="w-4 h-4" />
              <span className="text-xs font-semibold">Run History</span>
            </button>

            <div className="pt-2 border-t border-white/5 mt-2">
              <p className="px-2 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-2">
                Reusable Nodes
              </p>
              <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                {reusableNodes.map((template) => (
                  <button
                    key={template.id || `${template.toolId}-${template.toolAction}`}
                    onClick={() =>
                      addReusableNode({
                        label: template.label,
                        description: template.description,
                        nodeType: template.nodeType,
                        ...(template.toolId ? { toolId: template.toolId } : {}),
                        ...(template.toolAction ? { toolAction: template.toolAction } : {}),
                        ...(template.stateContract
                          ? { stateContract: template.stateContract }
                          : {}),
                      })
                    }
                    className="w-full rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5 text-left transition hover:bg-white/5"
                    title={template.description}
                  >
                    <div className="text-[10px] font-medium text-white/75 truncate">
                      {template.label}
                    </div>
                    <div className="text-[9px] text-white/35 truncate">
                      {template.toolName || 'Logic / Helper'}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {savedList.length > 0 && (
              <div className="mt-4 pt-4 border-t border-white/5">
                <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 px-3">
                  My Workflows
                </p>
                {savedList.map((w) => (
                  <div
                    key={w.name}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/5 transition-all group"
                  >
                    <button
                      onClick={() => handleLoad(w.name)}
                      className="flex-1 text-left text-xs text-white/60 hover:text-white truncate"
                    >
                      {w.name}
                    </button>
                    <button
                      onClick={() => handleDelete(w.name)}
                      className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </nav>

          <div className="p-6 border-t border-white/5">
            <div className="bg-white/[0.02] p-4 rounded-xl border border-white/5">
              <p className="text-[11px] text-white/40 font-medium leading-relaxed">
                Each node reads/writes to a shared state object. Click "Run Flow" to execute the
                graph.
              </p>
            </div>
          </div>
        </aside>
      )}

      <main className="flex-1 flex relative min-w-0 bg-grid overflow-hidden">
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="absolute left-4 top-4 z-50 flex items-center gap-2 rounded-xl border border-white/10 bg-[#0a0a0a]/85 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.18em] text-white/60 hover:text-white hover:bg-white/[0.04]"
          >
            <ChevronRight className="w-3.5 h-3.5" />
            Menu
          </button>
        )}

        {showSplash && (
          <div className="absolute inset-0 z-40 flex items-center justify-center p-6 bg-[#050505]/55 backdrop-blur-sm">
            <div className="w-full max-w-3xl">
              <h1 className="text-5xl font-bold tracking-tighter text-white mb-10 text-center">
                What do you wanna automate today?
              </h1>
              <div className="relative group rounded-[28px] border border-white/10 bg-[#111111]/80 p-5 shadow-2xl shadow-black/30 backdrop-blur-md">
                <textarea
                  value={activeTaskDraft}
                  onChange={(e) => setActiveTaskDraft(e.target.value)}
                  placeholder="Describe your workflow goal..."
                  className="w-full bg-transparent text-xl text-white/90 placeholder:text-white/20 focus:outline-none resize-none min-h-[120px] leading-relaxed font-medium"
                  onKeyDown={async (e) => {
                    if (e.key === 'Enter' && !e.shiftKey && (activeTaskDraft || '').trim()) {
                      e.preventDefault();
                      e.stopPropagation();
                      await handleMagicGenerate();
                    }
                  }}
                />
                <div className="flex items-center justify-between gap-3 pt-4 border-t border-white/5">
                  <div className="flex gap-2">
                    <button
                      onClick={() => setShowTemplatesModal(true)}
                      className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-white/60 hover:bg-white/10 transition-all flex items-center gap-2"
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      Templates
                    </button>
                    <button
                      onClick={handleBlankAgent}
                      className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-white/60 hover:bg-white/10 transition-all flex items-center gap-2"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Blank
                    </button>
                  </div>

                  <div className="flex items-center gap-2 ml-auto">
                    <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#0d0d0d] px-2 py-1.5 shadow-inner shadow-black/30">
                      <label className="text-[11px] text-white/45 font-medium">Model:</label>
                      <select
                        value={selectedModel}
                        onChange={(e) => setSelectedModel(e.target.value)}
                        className="appearance-none bg-[#0d0d0d] text-white text-xs font-medium border-0 outline-none rounded-md pr-6 cursor-pointer min-w-[200px]"
                        style={{
                          backgroundImage:
                            'linear-gradient(45deg, transparent 50%, rgba(255,255,255,0.7) 50%), linear-gradient(135deg, rgba(255,255,255,0.7) 50%, transparent 50%)',
                          backgroundPosition:
                            'calc(100% - 14px) calc(50% - 2px), calc(100% - 9px) calc(50% - 2px)',
                          backgroundSize: '5px 5px, 5px 5px',
                          backgroundRepeat: 'no-repeat',
                          colorScheme: 'dark',
                        }}
                      >
                        <option value="auto" className="bg-[#111] text-white">
                          Auto best fit
                        </option>
                        <option value={AI_CONFIG.openRouterModel} className="bg-[#111] text-white">
                          OpenRouter: {AI_CONFIG.openRouterModel}
                        </option>
                        <option value={AI_CONFIG.geminiModel} className="bg-[#111] text-white">
                          Gemini: {AI_CONFIG.geminiModel}
                        </option>
                        <option value={AI_CONFIG.ollamaModel} className="bg-[#111] text-white">
                          Ollama: {AI_CONFIG.ollamaModel}
                        </option>
                      </select>
                    </div>

                    <button
                      onClick={handleMagicGenerate}
                      disabled={!getActivePrompt() || isGenerating}
                      className="p-4 bg-white/10 hover:bg-bolt-accent hover:text-black rounded-2xl transition-all disabled:opacity-20 shadow-lg group"
                    >
                      {isGenerating ? (
                        <Loader2 className="w-6 h-6 animate-spin" />
                      ) : (
                        <ChevronRight className="w-6 h-6 group-hover:translate-x-1 transition-transform" />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {nodes.length === 1 && nodes[0].type === 'trigger' && !isGenerating && (
          <div className="absolute inset-x-0 top-20 z-30 flex justify-center pointer-events-none">
            <div className="pointer-events-auto w-full max-w-2xl rounded-2xl border border-white/10 bg-[#0d0d0d]/90 p-4 shadow-2xl">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                    Choose reusable node
                  </p>
                  <h3 className="text-sm font-semibold text-white">Build from a starting block</h3>
                </div>
                <button
                  onClick={() => setNodes([])}
                  className="rounded-full p-1.5 text-white/40 hover:bg-white/5 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                {reusableNodes.map((template) => (
                  <button
                    key={template.id || `${template.toolId}-${template.toolAction}`}
                    onClick={() => {
                      const nextId = createNodeId(template.label || 'node');
                      const recommendedModel = AI_CONFIG.getRecommendedModel(getActivePrompt());
                      if (selectedModel === 'auto' || !selectedModel) {
                        setSelectedModel(recommendedModel);
                      }
                      const newNode: Node = {
                        id: nextId,
                        type:
                          template.nodeType === NodeType.TOOL
                            ? 'tool'
                            : template.nodeType === NodeType.LOGIC
                              ? 'logic'
                              : template.nodeType === NodeType.OUTPUT
                                ? 'output'
                                : 'ai_agent',
                        position: { x: 520, y: 250 },
                        data: {
                          label: template.label,
                          type: template.nodeType,
                          description: template.description,
                          ...(template.toolId ? { toolId: template.toolId } : {}),
                          ...(template.toolAction ? { toolAction: template.toolAction } : {}),
                          stateContract: template.stateContract || {
                            inputKeys: [],
                            outputKeys: ['result'],
                          },
                        },
                      };
                      const edge = {
                        id: `edge_${nodes[0].id}_${nextId}`,
                        source: nodes[0].id,
                        target: nextId,
                        animated: true,
                        style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
                        markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' },
                      };
                      setNodes((prev) => [...prev, newNode]);
                      setEdges((prev) => [...prev, edge as Edge]);
                    }}
                    className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/5"
                  >
                    <div className="text-[10px] font-medium text-white/80">{template.label}</div>
                    <div className="text-[9px] text-white/35 mt-1">
                      {template.toolName || 'Logic / helper'}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {connectionSuggestion && (
          <div
            className="absolute z-40 pointer-events-none"
            style={{
              left: connectionSuggestion.position.x,
              top: connectionSuggestion.position.y,
              transform: 'translate(-50%, -50%)',
            }}
          >
            <div className="pointer-events-auto w-[360px] rounded-2xl border border-white/10 bg-[#0d0d0d]/95 p-3 shadow-2xl backdrop-blur-sm">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                    Suggested reusable node
                  </p>
                  <h3 className="text-sm font-semibold text-white">Insert between these nodes</h3>
                </div>
                <button
                  onClick={() => setConnectionSuggestion(null)}
                  className="rounded-full p-1.5 text-white/40 hover:bg-white/5 hover:text-white"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                {reusableNodes.map((template) => (
                  <button
                    key={template.id || `${template.toolId}-${template.toolAction}`}
                    onClick={() =>
                      insertReusableNodeBetween(
                        template,
                        connectionSuggestion.source,
                        connectionSuggestion.target,
                      )
                    }
                    className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/5"
                  >
                    <div className="text-[10px] font-medium text-white/80">{template.label}</div>
                    <div className="text-[9px] text-white/35 mt-1">
                      {template.toolName || 'Logic / helper'}
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  onClick={() => {
                    const directTarget = connectionSuggestion.target;
                    if (!directTarget) {
                      setConnectionSuggestion(null);
                      return;
                    }
                    setEdges((prev) =>
                      addEdge(
                        {
                          id: `edge_${connectionSuggestion.source}_${directTarget}`,
                          source: connectionSuggestion.source,
                          target: directTarget,
                          animated: true,
                          style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
                          markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' },
                        },
                        prev,
                      ),
                    );
                    setConnectionSuggestion(null);
                  }}
                  className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-[10px] font-semibold text-white/70 hover:bg-white/10"
                >
                  Connect directly
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Plan Preview Modal */}
        {planDraft && (
          <PlanPreview
            // Keyed per generation so a new plan gets a fresh editor
            // rather than one holding the previous plan's edits.
            key={planDraft.id}
            plan={planDraft.plan}
            draft={planDraft.workflow}
            toolStatuses={toolStatuses}
            statuses={generationStatuses}
            committedCount={planStep}
            isCommitting={isCommittingPlan}
            onCancel={() => setPlanDraft(null)}
            onCommit={handleCommitPlan}
          />
        )}

        {/* Templates Modal */}
        {showTemplatesModal && (
          <div
            className="absolute inset-0 z-50 flex items-center justify-center p-6 bg-[#050505]/80 backdrop-blur-md"
            onClick={() => setShowTemplatesModal(false)}
          >
            <div
              className="bg-[#0a0a0a] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                <h3 className="font-bold text-sm text-white">Saved Workflows</h3>
                <button
                  onClick={() => setShowTemplatesModal(false)}
                  className="p-1.5 hover:bg-white/5 rounded-full text-white/40 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="p-2 max-h-[60vh] overflow-y-auto">
                {workflowTemplates.length > 0 && (
                  <div className="mb-4 border-b border-white/10 pb-4">
                    <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-white/35">
                      Starter templates
                    </p>
                    <div className="space-y-2">
                      {workflowTemplates.map((template) => (
                        <button
                          key={template.id}
                          onClick={() => {
                            setActiveTaskDraft(template.prompt);
                            setShowTemplatesModal(false);
                          }}
                          className="w-full text-left rounded-xl border border-white/5 bg-white/[0.02] p-3 hover:bg-white/5 transition-colors"
                        >
                          <div className="text-xs font-semibold text-white">{template.title}</div>
                          <div className="mt-1 text-[10px] text-white/45">{template.summary}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {savedList.length === 0 ? (
                  <div className="p-8 text-center">
                    <FolderOpen className="w-8 h-8 text-white/10 mx-auto mb-3" />
                    <p className="text-sm text-white/40">No saved workflows found.</p>
                  </div>
                ) : (
                  <div className="grid gap-1">
                    {savedList.map((w) => (
                      <button
                        key={w.name}
                        onClick={() => {
                          handleLoad(w.name);
                          setShowTemplatesModal(false);
                        }}
                        className="flex items-center justify-between p-3 rounded-xl hover:bg-white/5 group text-left transition-all"
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-lg bg-bolt-accent/10 flex items-center justify-center text-bolt-accent">
                            <FileText className="w-4 h-4" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-white/90 group-hover:text-white">
                              {w.name}
                            </p>
                            <p className="text-[10px] text-white/40 mt-0.5">
                              {new Date(w.savedAt).toLocaleDateString()}
                            </p>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-white/20 group-hover:text-white/60 group-hover:translate-x-0.5 transition-all" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 10-Framework Workflow Code Export Modal. Only mounted while
                    open so its lazy chunk (jszip + code generators) is fetched
                    on demand, not at page load. */}
        {showExportModal && (
          <Suspense fallback={null}>
            <ExportModal
              isVisible={showExportModal}
              onClose={() => setShowExportModal(false)}
              nodes={nodes}
              edges={edges}
              workflowName={workflowName || activeTask?.name}
              prompt={getActivePrompt()}
            />
          </Suspense>
        )}

        <header className="absolute top-0 right-0 z-30 px-5 py-4 shrink-0">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowChatPanel(!showChatPanel)}
              className="px-3 py-2 text-white/60 hover:text-white transition-colors text-[10px] font-bold uppercase tracking-[0.2em] border border-white/10 rounded-xl bg-[#0d0d0d]/70 backdrop-blur-sm"
            >
              Chat
            </button>
            {!sidebarOpen && (
              <button
                onClick={() => setSidebarOpen(true)}
                className="px-3 py-2 text-white/60 hover:text-white transition-colors text-[10px] font-bold uppercase tracking-[0.2em] border border-white/10 rounded-xl bg-[#0d0d0d]/70 backdrop-blur-sm"
              >
                Tasks
              </button>
            )}
            <button
              onClick={handleClear}
              className="px-3 py-2 text-white/40 hover:text-white transition-colors text-[10px] font-bold uppercase tracking-[0.2em] border border-white/10 rounded-xl bg-[#0d0d0d]/70 backdrop-blur-sm"
            >
              Clear
            </button>
            <div className="flex items-center gap-1 border-r border-white/10 pr-3">
              <button
                onClick={undo}
                disabled={!canUndo}
                title="Undo (⌘Z)"
                className="p-1.5 text-white/30 hover:text-white disabled:opacity-20 transition-all"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={redo}
                disabled={!canRedo}
                title="Redo (⌘⇧Z)"
                className="p-1.5 text-white/30 hover:text-white disabled:opacity-20 transition-all"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>
            </div>
            {/* Version switcher: step between the labeled snapshots each chat
                patch produces. Hidden until at least one version exists. */}
            {versions.length > 0 && (
              <div className="relative flex items-center gap-1 border-r border-white/10 pr-3">
                <button
                  onClick={() => switchToVersion(versionIndex - 1)}
                  disabled={!canGoBackVersion}
                  title="Previous version"
                  className="p-1.5 text-white/30 hover:text-white disabled:opacity-20 transition-all"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setShowVersionMenu((open) => !open)}
                  title="Workflow versions"
                  className="flex items-center gap-1 px-1.5 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-white/60 hover:text-white"
                >
                  <History className="w-3 h-3" />
                  {versions[versionIndex]?.label ?? `v${versions.length}`}
                  <span className="text-white/30">/ {versions.length}</span>
                </button>
                <button
                  onClick={() => switchToVersion(versionIndex + 1)}
                  disabled={!canGoForwardVersion}
                  title="Next version"
                  className="p-1.5 text-white/30 hover:text-white disabled:opacity-20 transition-all"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                {showVersionMenu && (
                  <div className="absolute right-0 top-full z-50 mt-2 w-64 max-h-72 overflow-y-auto rounded-xl border border-white/10 bg-[#0d0d0d] p-1.5 shadow-2xl">
                    {versions
                      .map((v, i) => ({ v, i }))
                      .reverse()
                      .map(({ v, i }) => (
                        <button
                          key={v.id}
                          onClick={() => switchToVersion(i)}
                          className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/5 ${
                            i === versionIndex ? 'bg-white/[0.06]' : ''
                          }`}
                        >
                          <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-bolt-accent">
                            {v.label}
                            {i === versionIndex && (
                              <span className="rounded-full bg-bolt-accent/20 px-1.5 py-0.5 text-[8px] text-bolt-accent">
                                current
                              </span>
                            )}
                          </span>
                          <span className="line-clamp-2 text-[10px] leading-4 text-white/60">
                            {v.summary}
                          </span>
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
            {showSaveDialog ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={workflowName}
                  onChange={(e) => setWorkflowName(e.target.value)}
                  placeholder="Workflow name…"
                  className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-bolt-accent/40 w-40"
                  onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                  autoFocus
                />
                <button
                  onClick={handleSave}
                  disabled={!workflowName.trim()}
                  className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 transition-all disabled:opacity-30"
                >
                  <Save className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setShowSaveDialog(false)}
                  className="p-2 text-white/40 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowSaveDialog(true)}
                disabled={nodes.length === 0}
                className="flex items-center gap-1.5 px-3 py-2 text-white/40 hover:text-white transition-colors text-xs font-bold disabled:opacity-20"
              >
                <Save className="w-3.5 h-3.5" /> Save
              </button>
            )}
            <button
              onClick={() => setShowExportModal(true)}
              disabled={nodes.length === 0}
              className="flex items-center gap-1.5 px-3 py-2 text-white/60 hover:text-white transition-colors text-xs font-bold disabled:opacity-20 border border-white/10 rounded-xl bg-[#0d0d0d]/70 backdrop-blur-sm hover:bg-white/5"
              title="Export workflow into 10 Python agent frameworks"
            >
              <Download className="w-3.5 h-3.5 text-bolt-accent" /> Export
            </button>
            {isExecuting && (
              <div className="flex items-center gap-2">
                <button
                  onClick={pauseExecution}
                  className="px-3 py-2 border border-white/10 bg-white/5 text-white/80 rounded-xl text-[10px] font-bold hover:bg-white/10"
                >
                  Pause
                </button>
                <button
                  onClick={resumeExecution}
                  className="px-3 py-2 border border-white/10 bg-white/5 text-white/80 rounded-xl text-[10px] font-bold hover:bg-white/10"
                >
                  Resume
                </button>
                <button
                  onClick={cancelExecution}
                  className="px-3 py-2 border border-red-500/30 bg-red-500/10 text-red-300 rounded-xl text-[10px] font-bold hover:bg-red-500/20"
                >
                  Cancel
                </button>
              </div>
            )}
            <button
              onClick={handleExecuteFlow}
              disabled={nodes.length === 0 || isExecuting}
              className="flex items-center gap-2 px-5 py-2.5 bg-bolt-accent text-black rounded-xl text-xs font-bold shadow-2xl hover:bg-bolt-accent/90 transition-all"
            >
              {isExecuting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Play className="w-3.5 h-3.5 fill-black" />
              )}
              {runtimeStatus === 'paused' ? 'Resume' : 'Run Flow'}
            </button>
          </div>
        </header>

        <div className="flex-1 relative h-full" style={{ minHeight: 0 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            className="!w-full !h-full"
            style={{ width: '100%', height: '100%' }}
          >
            <Background color="#111" gap={40} size={1} />
            <MiniMap
              nodeColor={(node) => {
                switch (node.data?.type) {
                  case 'trigger':
                    return '#f59e0b';
                  case 'ai_agent':
                    return '#8b5cf6';
                  case 'tool':
                    return '#3b82f6';
                  case 'logic':
                    return '#ec4899';
                  case 'output':
                    return '#10b981';
                  default:
                    return '#6b7280';
                }
              }}
              maskColor="rgba(0,0,0,0.7)"
              className="!bg-[#0a0a0a] !border-white/5"
              position="bottom-left"
            />
            <Panel position="bottom-center" className="mb-6 pointer-events-auto">
              <Controls
                showInteractive={false}
                className="!static !shadow-none !border-white/5 !bg-[#111]"
              />
            </Panel>

            {/* Loading Overlay While Generating Workflow */}
            {showGeneratingOverlay && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 text-white p-6">
                <div className="rounded-3xl border border-white/10 bg-[#111]/95 p-8 text-center shadow-2xl">
                  <div className="mx-auto mb-4 w-12 h-12 flex items-center justify-center rounded-full bg-white/10">
                    <Loader2 className="w-8 h-8 animate-spin text-white" />
                  </div>
                  <h2 className="text-lg font-bold mb-2">Generating workflow...</h2>
                  <p className="text-sm text-white/60 max-w-sm mx-auto">
                    The AI is creating your workflow. This may take a few seconds depending on the
                    model.
                  </p>
                </div>
              </div>
            )}

            {/* STATE GRAPH MONITOR */}
            <Panel
              position="bottom-right"
              className={`mr-6 mb-6 transition-all duration-500 transform ${isTesting || activeView === 'execution' ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0 pointer-events-none'}`}
            >
              <ExecutionMonitor
                isVisible={isTesting || activeView === 'execution'}
                isExecuting={isExecuting}
                currentNodeLabel={currentNodeLabel}
                executionLogs={executionLogs}
                workflowNodes={nodes}
                graphState={graphState}
                onClose={() => {
                  setIsTesting(false);
                  setActiveView('graph');
                }}
                onDownload={downloadOutput}
              />
            </Panel>

            {/* RUN HISTORY */}
            <Panel
              position="bottom-right"
              className={`mr-6 mb-6 transition-all duration-500 transform ${activeView === 'history' ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0 pointer-events-none'}`}
            >
              <RunHistoryPanel
                isVisible={activeView === 'history'}
                reloadKey={runHistoryReloadKey}
                onClose={() => setActiveView('graph')}
              />
            </Panel>

            {authReconnect && (
              <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#050505]/80 backdrop-blur-sm">
                <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#101010] p-6 shadow-2xl">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">
                        Reconnect required
                      </p>
                      <h3 className="mt-2 text-2xl font-bold text-white">
                        {authReconnect.toolName}
                      </h3>
                    </div>
                    <button
                      onClick={() => setAuthReconnect(null)}
                      className="rounded-full p-1.5 text-white/50 hover:bg-white/5 hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <p className="mt-4 text-sm leading-relaxed text-white/70">
                    {authReconnect.message ||
                      'This tool disconnected while the workflow was running.'}
                  </p>

                  <div className="mt-6 flex gap-3">
                    <button
                      onClick={() => setAuthReconnect(null)}
                      className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-white/80 hover:bg-white/10"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleReconnectAndRerun}
                      className="flex-1 rounded-xl bg-bolt-accent px-4 py-2.5 text-sm font-bold text-black hover:bg-bolt-accent/90"
                    >
                      Connect & Rerun
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* NODE INSPECTOR */}
            {selectedNode && !isTesting && (
              <Panel position="top-right" className="mr-6 mt-6 w-[360px] pointer-events-auto">
                <div
                  className="glass-panel rounded-3xl shadow-2xl border-white/10 overflow-hidden"
                  style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}
                >
                  <div className="px-6 py-5 border-b border-white/10 flex items-center justify-between shrink-0">
                    <h3 className="font-bold text-sm">Node Settings</h3>
                    <button
                      onClick={() => setSelectedNodeId(null)}
                      className="p-1.5 hover:bg-white/5 rounded-full"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <div
                    className="p-6 space-y-5 overflow-y-auto flex-1"
                    style={{
                      scrollbarWidth: 'thin',
                      scrollbarColor: 'rgba(255,255,255,0.1) transparent',
                    }}
                  >
                    <div>
                      <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 block">
                        Node Label
                      </label>
                      <input
                        type="text"
                        value={selectedNode.data.label}
                        onChange={(e) =>
                          setNodes((nds) =>
                            nds.map((n) =>
                              n.id === selectedNodeId
                                ? { ...n, data: { ...n.data, label: e.target.value } }
                                : n,
                            ),
                          )
                        }
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-bolt-accent/30"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 block">
                        Instructions
                      </label>
                      <textarea
                        value={selectedNode.data.description || ''}
                        onChange={(e) =>
                          setNodes((nds) =>
                            nds.map((n) =>
                              n.id === selectedNodeId
                                ? { ...n, data: { ...n.data, description: e.target.value } }
                                : n,
                            ),
                          )
                        }
                        className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs min-h-[100px] outline-none focus:border-bolt-accent/30 resize-none"
                      />
                    </div>

                    {/* AI cache toggle: for an AI/generic node (no bound tool),
                        reuse the last output instead of calling the model again.
                        Handy when iterating on downstream steps — no repeated AI
                        cost/latency for a step whose result has not changed. */}
                    {!selectedNode.data.toolId &&
                      selectedNode.id !== 'root' &&
                      (selectedNode.data.stateContract?.outputKeys?.length ?? 0) > 0 && (
                        <div className="pt-3 border-t border-white/5">
                          <label className="flex items-center justify-between gap-3">
                            <span>
                              <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest block">
                                Use cached output
                              </span>
                              <span className="mt-1 block text-[10px] leading-4 text-white/40">
                                Skip the AI call and replay this node&rsquo;s last result.
                                {selectedNode.data.cachedOutput
                                  ? ' A cached result is available.'
                                  : ' Run once first to create a cache.'}
                              </span>
                            </span>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={Boolean(selectedNode.data.useCachedOutput)}
                              disabled={!selectedNode.data.cachedOutput}
                              onClick={() =>
                                setNodes((nds) =>
                                  nds.map((n) =>
                                    n.id === selectedNodeId
                                      ? {
                                          ...n,
                                          data: {
                                            ...n.data,
                                            useCachedOutput: !n.data.useCachedOutput,
                                          },
                                        }
                                      : n,
                                  ),
                                )
                              }
                              className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-30 ${
                                selectedNode.data.useCachedOutput ? 'bg-bolt-accent' : 'bg-white/15'
                              }`}
                            >
                              <span
                                className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                                  selectedNode.data.useCachedOutput
                                    ? 'translate-x-4'
                                    : 'translate-x-0.5'
                                }`}
                              />
                            </button>
                          </label>
                        </div>
                      )}

                    {/* Per-node version history: switch THIS node back to an
                        earlier version of its config without touching the rest
                        of the workflow — e.g. before re-running. Only shown once
                        the node has more than one recorded version. */}
                    {listNodeVersions(selectedNode.data).length > 1 &&
                      (() => {
                        const nodeVersions = listNodeVersions(selectedNode.data);
                        const activeIndex = currentNodeVersionIndex(selectedNode.data);
                        return (
                          <div className="pt-3 border-t border-white/5 space-y-2">
                            <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest block">
                              Version
                            </label>
                            <p className="text-[10px] leading-4 text-white/40">
                              Roll this step back to an earlier version of its settings. Only this
                              node changes.
                            </p>
                            <select
                              value={activeIndex}
                              onChange={(e) => {
                                const index = Number(e.target.value);
                                setNodes((nds) =>
                                  nds.map((n) =>
                                    n.id === selectedNodeId
                                      ? { ...n, data: restoreNodeVersion(n.data, index) }
                                      : n,
                                  ),
                                );
                              }}
                              className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-bolt-accent/30"
                            >
                              {activeIndex === -1 && (
                                <option value={-1} disabled>
                                  (edited — not a saved version)
                                </option>
                              )}
                              {nodeVersions.map((v, i) => (
                                <option key={v.label} value={i}>
                                  {v.label}
                                  {i === nodeVersions.length - 1 ? ' (latest)' : ''} —{' '}
                                  {new Date(v.at).toLocaleTimeString()}
                                </option>
                              ))}
                            </select>
                          </div>
                        );
                      })()}

                    {/* Initial State Editor (Workflow Inputs) */}
                    {selectedNode.id === 'root' && (
                      <div className="pt-3 border-t border-white/5">
                        <div className="flex justify-between items-center mb-2">
                          <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest block">
                            Workflow Inputs
                          </label>
                          <button
                            onClick={() => {
                              const key = prompt('Enter new input name (e.g., custom_id):');
                              if (key) {
                                setNodes((nds) =>
                                  nds.map((n) =>
                                    n.id === 'root'
                                      ? {
                                          ...n,
                                          data: {
                                            ...n.data,
                                            initialState: {
                                              ...(n.data.initialState || {}),
                                              [key]: '',
                                            },
                                          },
                                        }
                                      : n,
                                  ),
                                );
                              }
                            }}
                            className="p-1 hover:bg-white/10 rounded text-white/40 hover:text-white transition-colors"
                            title="Add Input"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>

                        {availableWorkflowKeys.length === 0 ? (
                          <p className="text-[10px] text-white/30 italic">
                            No inputs detected. Add tools or custom inputs.
                          </p>
                        ) : (
                          <div className="space-y-3">
                            {availableWorkflowKeys.map((key) => {
                              const rawValue = selectedNode.data.initialState?.[key];
                              const value =
                                rawValue === null || rawValue === undefined ? '' : String(rawValue);
                              const isInState = selectedNode.data.initialState
                                ? key in selectedNode.data.initialState
                                : false;
                              return (
                                <div key={key}>
                                  <div className="flex items-center justify-between mb-1">
                                    <label className="text-[9px] text-white/50 font-mono flex items-center gap-1.5">
                                      {key}
                                      {!isInState && (
                                        <span className="text-[8px] text-bolt-accent/50 font-sans">
                                          (from tool)
                                        </span>
                                      )}
                                    </label>
                                    <button
                                      onClick={() => {
                                        setNodes((nds) =>
                                          nds.map((n) => {
                                            if (n.id === 'root' && n.data.initialState) {
                                              const { [key]: _, ...rest } = n.data.initialState;
                                              return {
                                                ...n,
                                                data: { ...n.data, initialState: rest },
                                              };
                                            }
                                            return n;
                                          }),
                                        );
                                      }}
                                      className="p-0.5 text-white/20 hover:text-red-400 transition-colors"
                                      title={`Remove ${key}`}
                                    >
                                      <X className="w-2.5 h-2.5" />
                                    </button>
                                  </div>
                                  <input
                                    type="text"
                                    value={value}
                                    placeholder={isInState ? '(empty)' : 'Click to set value…'}
                                    onChange={(e) => {
                                      const newVal = e.target.value;
                                      setNodes((nds) =>
                                        nds.map((n) => {
                                          if (n.id === 'root') {
                                            return {
                                              ...n,
                                              data: {
                                                ...n.data,
                                                initialState: {
                                                  ...(n.data.initialState || {}),
                                                  [key]: newVal,
                                                },
                                              },
                                            };
                                          }
                                          return n;
                                        }),
                                      );
                                    }}
                                    className={`w-full bg-white/5 border rounded-lg px-3 py-2 text-xs outline-none focus:border-bolt-accent/30 font-mono text-white/90 placeholder:text-white/10 ${isInState ? 'border-white/10' : 'border-dashed border-white/5'}`}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Tool Configuration for Gmail */}
                    {selectedNode.data.toolId === 'gmail' &&
                      selectedNode.data.toolAction === 'send_email' && (
                        <div className="pt-3 border-t border-white/5">
                          <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 block">
                            Email Recipient
                          </label>
                          <input
                            type="email"
                            value={selectedNode.data.configuredRecipient || ''}
                            onChange={(e) =>
                              setNodes((nds) =>
                                nds.map((n) =>
                                  n.id === selectedNodeId
                                    ? {
                                        ...n,
                                        data: { ...n.data, configuredRecipient: e.target.value },
                                      }
                                    : n,
                                ),
                              )
                            }
                            placeholder="recipient@example.com (optional)"
                            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-bolt-accent/30 placeholder:text-white/20"
                          />
                          <p className="text-[9px] text-white/30 mt-2">
                            Overrides state keys if set. Leave empty to use state.
                          </p>
                        </div>
                      )}
                    {/* Rendering mode for web-fetch nodes. Shows the current
                        value (so a chat patch is visible here too) and lets it
                        be changed directly, without the chat. */}
                    {selectedNode.data.toolId === 'web' && (
                      <div className="pt-3 border-t border-white/5 space-y-2">
                        <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest block">
                          Rendering
                        </label>
                        <p className="text-[10px] leading-4 text-white/40">
                          How to handle JavaScript-heavy pages. “Always” renders with a headless
                          browser before extracting; “Auto” only renders when the plain fetch comes
                          back empty.
                        </p>
                        <select
                          value={(selectedNode.data.render_mode as string) || 'auto'}
                          onChange={(e) =>
                            setNodes((nds) =>
                              nds.map((n) =>
                                n.id === selectedNodeId
                                  ? { ...n, data: { ...n.data, render_mode: e.target.value } }
                                  : n,
                              ),
                            )
                          }
                          className="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white outline-none focus:border-bolt-accent/30"
                        >
                          <option value="auto">Auto — render only if the page is empty</option>
                          <option value="always">Always — render every time</option>
                          <option value="never">Never — plain fetch only</option>
                        </select>
                      </div>
                    )}
                    {selectedNode.data.stateContract && (
                      <div className="pt-3 border-t border-white/5 space-y-3">
                        <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest block">
                          State Contract
                        </label>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-blue-400 font-bold w-14">Reads:</span>
                            <span className="text-[9px] text-white/50">
                              {selectedNode.data.stateContract.inputKeys?.join(', ') || 'none'}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-[9px] text-emerald-400 font-bold w-14">
                              Writes:
                            </span>
                            <span className="text-[9px] text-white/50">
                              {selectedNode.data.stateContract.outputKeys?.join(', ') || 'none'}
                            </span>
                          </div>
                          {selectedNode.data.stateContract.reducer && (
                            <div className="flex items-center gap-2">
                              <span className="text-[9px] text-amber-400 font-bold w-14">
                                Reducer:
                              </span>
                              <span className="text-[9px] text-white/50">
                                {selectedNode.data.stateContract.reducer}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    {selectedNode.data.output && (
                      <div className="pt-4 border-t border-white/5">
                        <label className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-2 block">
                          Last Output
                        </label>
                        <div className="text-[10px] text-white/40 bg-white/5 p-3 rounded-lg max-h-32 overflow-y-auto font-mono">
                          <pre className="whitespace-pre-wrap">{selectedNode.data.output}</pre>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            )}
          </ReactFlow>
        </div>
      </main>

      {showChatPanel && (
        <aside className="w-[360px] border-l border-white/10 bg-[#090909]/95 backdrop-blur-xl flex flex-col shrink-0 z-40">
          <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
            <div>
              <p className="text-[10px] uppercase tracking-[0.2em] text-white/35">Workflow Chat</p>
              <h3 className="text-sm font-semibold text-white">
                {activeTask?.name || 'Task session'}
              </h3>
            </div>
            <button
              onClick={() => setShowChatPanel(false)}
              className="p-1.5 hover:bg-white/5 rounded-full text-white/40 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            <div className="space-y-4">
              {chatMessages.map((message, index) => (
                <div
                  key={`${activeTaskId}-${message.role}-${index}`}
                  className={`flex gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  {message.role === 'assistant' && (
                    <div className="mt-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[9px] font-bold text-white/70">
                      AI
                    </div>
                  )}
                  {/* pre-wrap: patch summaries and validation
                                        issues are multi-line lists, and without it
                                        they collapsed onto one unreadable line. */}
                  <div
                    className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-[11px] leading-5 ${message.role === 'user' ? 'bg-bolt-accent text-black font-medium' : 'bg-white/[0.04] text-white/80 border border-white/5'}`}
                  >
                    {message.text}
                  </div>
                  {message.role === 'user' && (
                    <div className="mt-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[9px] font-bold text-white/70">
                      U
                    </div>
                  )}
                </div>
              ))}

              {(isGenerating || isPatching) && (
                <div className="flex gap-2 justify-start">
                  <div className="mt-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[9px] font-bold text-white/70">
                    AI
                  </div>
                  <div className="max-w-[85%] rounded-2xl border border-white/5 bg-white/[0.04] px-3 py-2 text-[11px] text-white/70">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex gap-1">
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60 [animation-delay:-0.2s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60 [animation-delay:-0.1s]" />
                        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60" />
                      </span>
                      thinking…
                    </div>
                  </div>
                </div>
              )}

              {/* A patch that removes or replaces steps waits here.
                                Every operation is listed by name so the user is
                                agreeing to something specific, not to "apply". */}
              {pendingPatch && (
                <div
                  data-testid="pending-patch"
                  className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3"
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200">
                    Confirm this change
                  </p>
                  <ul className="mt-2 space-y-1 text-[11px] text-amber-100/85">
                    {pendingPatch.operations.map((operation, index) => (
                      <li key={index}>
                        {describeOperation(operation, nodes as unknown as WorkflowNodeModel[])}
                      </li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => {
                        applyGraphPatch(pendingPatch);
                        setPendingPatch(null);
                      }}
                      className="rounded-lg bg-amber-400 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:bg-amber-300"
                    >
                      Apply
                    </button>
                    <button
                      onClick={() => {
                        setPendingPatch(null);
                        updateActiveTaskMessages((prev) => [
                          ...prev,
                          {
                            role: 'assistant',
                            text: 'Left the workflow as it was.',
                          },
                        ]);
                      }}
                      className="rounded-lg border border-white/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/70 hover:bg-white/5"
                    >
                      Discard
                    </button>
                  </div>
                </div>
              )}

              {/* Targeted fixes after a failed run: a short list of specific
                  options for THIS failure, plus a "write my own" custom option.
                  Each patch option applies its canned instruction and re-runs. */}
              {pendingFixes && pendingFixes.length > 0 && (
                <div
                  data-testid="pending-fixes"
                  className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3"
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-rose-200">
                    Suggested fixes
                  </p>
                  <div className="mt-2 space-y-1.5">
                    {pendingFixes.map((fix, index) => (
                      <button
                        key={index}
                        onClick={() => void applyFixSuggestion(fix)}
                        disabled={isPatching}
                        className={`flex w-full flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-colors disabled:opacity-50 ${
                          fix.kind === 'custom'
                            ? 'border-white/15 bg-white/[0.03] hover:bg-white/5'
                            : 'border-rose-400/25 bg-rose-400/5 hover:bg-rose-400/10'
                        }`}
                      >
                        <span className="text-[11px] font-bold text-white/90">{fix.label}</span>
                        <span className="text-[10px] leading-4 text-white/55">{fix.detail}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => {
                      setPendingFixes(null);
                      updateActiveTaskMessages((prev) => [
                        ...prev,
                        { role: 'assistant', text: 'Okay, I left it as is.' },
                      ]);
                    }}
                    className="mt-2 rounded-lg border border-white/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/70 hover:bg-white/5"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Inline collector for the values a run needs but does not have.
                  Replaces a stack of blocking window.prompt dialogs. */}
              {pendingInputs && pendingInputs.length > 0 && (
                <div
                  data-testid="pending-inputs"
                  className="rounded-2xl border border-bolt-accent/30 bg-bolt-accent/10 p-3"
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-bolt-accent">
                    Fill in to run
                  </p>
                  <div className="mt-2 space-y-3">
                    {pendingInputs.map((input) => (
                      <div key={input.key}>
                        <label className="mb-0.5 flex items-center gap-1.5 text-[11px] font-medium text-white/75">
                          {input.label}
                          {input.required ? (
                            <span className="rounded-full bg-bolt-accent/20 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-bolt-accent">
                              Required
                            </span>
                          ) : (
                            <span className="rounded-full bg-white/10 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide text-white/50">
                              Optional
                            </span>
                          )}
                        </label>
                        {/* Why this value is needed in THIS flow, from the tool's
                            own field description — so a new field is never a mystery. */}
                        {input.description && (
                          <p className="mb-1 text-[10px] leading-4 text-white/40">
                            {input.description}
                            <span className="text-white/25"> · used by {input.nodeLabel}</span>
                          </p>
                        )}
                        <input
                          type="text"
                          autoFocus={input === pendingInputs[0]}
                          value={pendingInputValues[input.key] ?? ''}
                          aria-label={`${input.label} value`}
                          placeholder={
                            input.format === 'url'
                              ? 'https://example.com'
                              : input.format === 'email'
                                ? 'name@example.com'
                                : input.required
                                  ? `Enter ${input.label}…`
                                  : `Optional — leave blank to skip`
                          }
                          onChange={(e) =>
                            setPendingInputValues((prev) => ({
                              ...prev,
                              [input.key]: e.target.value,
                            }))
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              submitPendingInputs();
                            }
                          }}
                          className="w-full rounded-lg border border-white/10 bg-black/30 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-bolt-accent/50"
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={submitPendingInputs}
                      disabled={pendingInputs.some(
                        (input) => input.required && !(pendingInputValues[input.key] ?? '').trim(),
                      )}
                      className="flex items-center gap-1.5 rounded-lg bg-bolt-accent px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:bg-bolt-accent/90 disabled:opacity-40"
                    >
                      <Play className="w-3 h-3 fill-black" />
                      Run with these
                    </button>
                    <button
                      onClick={() => {
                        setPendingInputs(null);
                        setPendingInputValues({});
                        updateActiveTaskMessages((prev) => [
                          ...prev,
                          { role: 'assistant', text: 'Okay, I did not run it.' },
                        ]);
                      }}
                      className="rounded-lg border border-white/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/70 hover:bg-white/5"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* A run decision asked in the chat instead of a native popup:
                  resume a saved run, or connect the tools it needs. */}
              {pendingRunAction?.kind === 'resume' && (
                <div
                  data-testid="pending-resume"
                  className="rounded-2xl border border-blue-400/30 bg-blue-400/10 p-3"
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-blue-300">
                    Unfinished run
                  </p>
                  <p className="mt-1 text-[11px] text-white/70">
                    {pendingRunAction.fromFailed
                      ? 'A previous run stopped at a failed step.'
                      : 'A previous run did not finish.'}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={resumeSavedRun}
                      className="flex items-center gap-1.5 rounded-lg bg-blue-400 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:bg-blue-300"
                    >
                      <Play className="w-3 h-3 fill-black" />
                      Resume
                    </button>
                    <button
                      onClick={startFreshRun}
                      className="rounded-lg border border-white/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/70 hover:bg-white/5"
                    >
                      Start fresh
                    </button>
                  </div>
                </div>
              )}

              {pendingRunAction?.kind === 'auth' && (
                <div
                  data-testid="pending-auth"
                  className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3"
                >
                  <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200">
                    Connect to run
                  </p>
                  <ul className="mt-2 space-y-1 text-[11px] text-amber-100/85">
                    {pendingRunAction.tools.map((tool) => (
                      <li key={tool.id}>{tool.name} — not connected</li>
                    ))}
                  </ul>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      onClick={() => void connectPendingTools()}
                      className="rounded-lg bg-amber-400 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-black hover:bg-amber-300"
                    >
                      Connect &amp; run
                    </button>
                    <button
                      onClick={() => {
                        setPendingRunAction(null);
                        updateActiveTaskMessages((prev) => [
                          ...prev,
                          { role: 'assistant', text: 'Okay, I did not run it.' },
                        ]);
                      }}
                      className="rounded-lg border border-white/15 px-3 py-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-white/70 hover:bg-white/5"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="border-t border-white/10 p-3">
            {/* Version picker, opened by the "Versions" button below. Lists the
                labeled snapshots each chat patch produced; clicking one restores
                the whole workflow to that version. */}
            {showChatVersions && versions.length > 0 && (
              <div className="mb-3 max-h-52 overflow-y-auto rounded-2xl border border-white/10 bg-black/40 p-2">
                <p className="px-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-[0.18em] text-white/40">
                  Workflow versions
                </p>
                {versions
                  .map((v, i) => ({ v, i }))
                  .reverse()
                  .map(({ v, i }) => (
                    <button
                      key={v.id}
                      onClick={() => {
                        switchToVersion(i);
                        setShowChatVersions(false);
                      }}
                      className={`flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left hover:bg-white/5 ${
                        i === versionIndex ? 'bg-white/[0.06]' : ''
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-bolt-accent">
                        {v.label}
                        {i === versionIndex && (
                          <span className="rounded-full bg-bolt-accent/20 px-1.5 py-0.5 text-[8px] text-bolt-accent">
                            current
                          </span>
                        )}
                        <span className="font-normal normal-case text-white/30">
                          {new Date(v.at).toLocaleTimeString()}
                        </span>
                      </span>
                      <span className="line-clamp-2 text-[10px] leading-4 text-white/55">
                        {v.summary}
                      </span>
                    </button>
                  ))}
              </div>
            )}
            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask to add, remove, rename, or route a step..."
              rows={3}
              className="w-full bg-white/[0.03] border border-white/10 rounded-2xl p-3 text-[12px] text-white placeholder:text-white/30 focus:outline-none resize-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleWorkflowChatSubmit();
                }
              }}
            />
            <div className="mt-3 flex items-center justify-between gap-2">
              {/* Always-available way to change an input value (e.g. a bad URL)
                  and re-run, straight from the chat — even after a run that
                  "passed" but scraped the wrong thing. */}
              <div className="flex items-center gap-2">
                <button
                  onClick={openInputEditor}
                  disabled={isPatching || isExecuting || nodes.length === 0}
                  className="px-2.5 py-2 rounded-xl border border-white/10 bg-white/5 text-white/70 text-[10px] font-bold uppercase tracking-[0.16em] hover:bg-white/10 hover:text-white disabled:opacity-30"
                  title="Change a workflow input (like the URL) and re-run"
                >
                  Change inputs
                </button>
                {/* Version control right beside Change inputs: open the list of
                    saved versions and restore any one. Hidden until a chat patch
                    has produced at least one version. */}
                <button
                  onClick={() => setShowChatVersions((open) => !open)}
                  disabled={versions.length === 0}
                  className={`flex items-center gap-1 px-2.5 py-2 rounded-xl border text-[10px] font-bold uppercase tracking-[0.16em] disabled:opacity-30 ${
                    showChatVersions
                      ? 'border-bolt-accent/40 bg-bolt-accent/10 text-bolt-accent'
                      : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                  title="Browse and restore workflow versions"
                >
                  <History className="w-3 h-3" />
                  {versions.length > 0
                    ? `${versions[versionIndex]?.label ?? `v${versions.length}`} / ${versions.length}`
                    : 'Versions'}
                </button>
              </div>
              <button
                onClick={handleWorkflowChatSubmit}
                disabled={isPatching}
                className="px-3 py-2 rounded-xl bg-bolt-accent text-black text-[10px] font-bold uppercase tracking-[0.18em] hover:bg-bolt-accent/90 disabled:opacity-50"
              >
                {isPatching ? 'Working' : 'Send'}
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}
