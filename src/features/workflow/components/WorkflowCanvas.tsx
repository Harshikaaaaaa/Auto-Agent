import React, { useState, useCallback, useMemo, useEffect } from 'react';
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
    useReactFlow
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
    CheckCircle2
} from 'lucide-react';
import { generateWorkflowPlan, planToWorkflow, PlanValidationError, type WorkflowPlan } from '@features/ai/services/workflowPlanGenerator';
import { PlanPreview } from './PlanPreview';
import { AI_CONFIG } from '@features/ai/config';
import { WorkflowNode } from './WorkflowNode';
import { ExecutionMonitor } from './ExecutionMonitor';
import { NodeType } from '@/shared/types';
import { useWorkflowExecution } from '@features/workflow/hooks/useWorkflowExecution';
import { useTools } from '@features/tools/useTools';
import { getTool, getAllTools } from '@features/tools/toolRegistry';
import type { FlowEdge, ReusableNodeTemplate, Workflow } from '@features/workflow/types';
import { validateCondition } from '@features/workflow/services/safeExpression';
import { getDefaultSpreadsheetId } from '@features/tools/connectors/googleSheets';
import { saveWorkflow, loadWorkflow, listWorkflows, deleteWorkflow, SavedWorkflow } from '@features/workflow/services/workflowStorage';
import { useUndoRedo } from '@features/workflow/hooks/useUndoRedo';
import { ExportModal } from './ExportModal';

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
    mcp: WorkflowNode
};

type ChatMessage = { role: 'user' | 'assistant'; text: string };
type ChatTaskSession = {
    id: string;
    name: string;
    messages: ChatMessage[];
    workflow?: {
        nodes: Node[];
        edges: Edge[];
    };
};

const TASK_SESSIONS_STORAGE_KEY = 'autoagent_task_sessions_v1';
const TASK_DRAFTS_STORAGE_KEY = 'autoagent_task_drafts_v1';

const deriveTaskNameFromPrompt = (prompt: string) => {
    const cleaned = (prompt || '').replace(/\s+/g, ' ').trim();
    if (!cleaned) return 'Task';

    const words = cleaned
        .replace(/[^a-zA-Z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6);

    if (words.length === 0) return 'Task';

    const title = words
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

    return title.length > 28 ? `${title.slice(0, 25).trim()}...` : title;
};

const normalizeTaskTitle = (name: string) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return 'Task';
    return trimmed.length > 28 ? `${trimmed.slice(0, 25).trim()}...` : trimmed;
};

const createNodeId = (prefix: string) => {
    const safePrefix = (prefix || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'node';
    const uniqueSuffix = typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID().slice(0, 8)
        : Math.random().toString(36).slice(2, 10);
    return `${safePrefix}_${Date.now()}_${uniqueSuffix}`;
};

const createChatTaskSession = (name: string, index: number): ChatTaskSession => ({
    id: `task-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    name: normalizeTaskTitle(name),
    messages: [
        {
            role: 'assistant',
            text: `Welcome to ${normalizeTaskTitle(name)}. Ask me to add, remove, rename, or route a step in this workflow. Examples: "Add approval before sending email", "Use Gmail instead of Slack", "Rename this step to Lead follow-up".`
        }
    ],
    workflow: { nodes: [], edges: [] }
});

const loadStoredTaskSessions = (): ChatTaskSession[] => {
    if (typeof window === 'undefined') return [];

    try {
        const raw = window.localStorage.getItem(TASK_SESSIONS_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as ChatTaskSession[];
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((task, idx) => ({
                id: task.id || `task-${Date.now()}-${idx + 1}`,
                name: normalizeTaskTitle(task.name || `Task ${idx + 1}`),
                messages: Array.isArray(task.messages) ? task.messages : [{ role: 'assistant', text: `Welcome to ${normalizeTaskTitle(task.name || `Task ${idx + 1}`)}.` }],
                workflow: task.workflow && Array.isArray(task.workflow.nodes)
                    ? { nodes: task.workflow.nodes as Node[], edges: Array.isArray(task.workflow.edges) ? task.workflow.edges as Edge[] : [] }
                    : { nodes: [], edges: [] }
            }));
        }
    } catch (error) {
        console.warn('[TaskSessions] Unable to load stored tasks:', error);
    }

    return [];
};

const loadStoredTaskDrafts = (): Record<string, string> => {
    if (typeof window === 'undefined') return {};

    try {
        const raw = window.localStorage.getItem(TASK_DRAFTS_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        console.warn('[TaskDrafts] Unable to load stored drafts:', error);
        return {};
    }
};

const isMeaningfulWorkflowPrompt = (prompt: string) => {
    const trimmed = (prompt || '').trim();
    if (!trimmed) {
        return { valid: false, reason: 'Describe the workflow you want to build.' };
    }

    const normalized = trimmed.toLowerCase();
    const shortHint = /^(?:hi|hello|hey|test|random|asdf|qwerty|lorem|ipsum|demo|sample|nothing|n)$/i;
    if (shortHint.test(normalized) || normalized.length < 10) {
        return { valid: false, reason: 'This looks too vague or random to generate a safe workflow plan. Describe the actual automation goal.' };
    }

    if (/^(?:asdf|qwerty|hello|hi|hey|test|random|demo|lorem|ipsum|sample)\s*$/i.test(trimmed)) {
        return { valid: false, reason: 'This is not a valid workflow request. Please describe a real automation task.' };
    }

    const workflowSignals = ['email', 'gmail', 'slack', 'sheet', 'google sheets', 'drive', 'whatsapp', 'notify', 'save', 'send', 'summarize', 'update', 'create', 'sync', 'automate', 'workflow', 'trigger', 'approval', 'capture', 'log', 'archive', 'manage', 'monitor', 'follow up', 'lead'];
    const hasSignal = workflowSignals.some((signal) => normalized.includes(signal));
    const hasActionVerb = /(create|send|save|sync|summarize|notify|update|collect|automate|monitor|trigger|archive|reply|follow|route|log|extract|analyze)/i.test(trimmed);

    if (!hasSignal && !hasActionVerb) {
        return { valid: false, reason: 'I can only turn real workflow goals into plans. Please describe a concrete automation task.' };
    }

    return { valid: true, normalized: trimmed };
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
    const [taskSessions, setTaskSessions] = useState<ChatTaskSession[]>(() => loadStoredTaskSessions());
    const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>(() => loadStoredTaskDrafts());
    const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
    const [showTemplatesModal, setShowTemplatesModal] = useState(false);
    const [showExportModal, setShowExportModal] = useState(false);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const taskParam = new URLSearchParams(window.location.search).get('task');
        if (!taskParam) {
            setActiveTaskId(current => current ?? null);
            return;
        }

        const storedMatch = taskSessions.some(task => task.id === taskParam);
        if (!storedMatch) {
            const url = new URL(window.location.href);
            url.searchParams.delete('task');
            window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
            setActiveTaskId(null);
            return;
        }

        setActiveTaskId(current => current ?? taskParam);
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

        const nextTask = createChatTaskSession(`Task ${taskSessions.length + 1}`, taskSessions.length + 1);
        setTaskSessions(prev => [...prev, nextTask]);
        setTaskDrafts(prev => ({ ...prev, [nextTask.id]: '' }));
        setActiveTaskId(nextTask.id);
        setNodes([]);
        setEdges([]);
        setShowChatPanel(true);
        return nextTask.id;
    }, [activeTaskId, taskSessions.length, setNodes, setEdges]);
    const [connectionSuggestion, setConnectionSuggestion] = useState<{ source: string; target?: string; position: { x: number; y: number } } | null>(null);
    const [authReconnect, setAuthReconnect] = useState<{ toolId: string; toolName: string; message: string } | null>(null);
    const [approvalRequest, setApprovalRequest] = useState<{ nodeId: string; nodeLabel: string; message: string } | null>(null);
    const [activeView, setActiveView] = useState<'graph' | 'execution'>('graph');
    const reusableToolNodes = useMemo<ReusableNodeTemplate[]>(() =>
        getAllTools().flatMap(tool =>
            tool.actions.map(action => ({
                toolId: tool.id,
                toolName: tool.name,
                toolAction: action.name,
                label: `${tool.name}: ${action.name.replace(/_/g, ' ')}`,
                description: action.description,
                inputKeys: action.inputKeys,
                outputKeys: action.outputKeys,
                nodeType: NodeType.TOOL
            }))
        ),
        []
    );

    const reusableHelperNodes = useMemo<ReusableNodeTemplate[]>(() => [
        {
            id: 'set_variable',
            label: 'Set Variable',
            description: 'Assign or overwrite a state value for downstream steps.',
            nodeType: NodeType.AI_AGENT,
            stateContract: { inputKeys: ['value', 'key'], outputKeys: ['value'] }
        },
        {
            id: 'if_condition',
            label: 'If Condition',
            description: 'Branch execution based on a boolean or comparison expression.',
            nodeType: NodeType.LOGIC,
            stateContract: { inputKeys: ['condition'], outputKeys: ['decision'] }
        },
        {
            id: 'merge_data',
            label: 'Merge Data',
            description: 'Combine multiple fields into a single structured object.',
            nodeType: NodeType.AI_AGENT,
            stateContract: { inputKeys: ['payload', 'data'], outputKeys: ['merged'] }
        },
        {
            id: 'wait_delay',
            label: 'Wait Delay',
            description: 'Pause the workflow for a fixed duration before continuing.',
            nodeType: NodeType.LOGIC,
            stateContract: { inputKeys: ['delay_ms'], outputKeys: ['wait_complete'] }
        },
        {
            id: 'format_text',
            label: 'Format Text',
            description: 'Transform text or JSON into a cleaner message or output payload.',
            nodeType: NodeType.AI_AGENT,
            stateContract: { inputKeys: ['text', 'format'], outputKeys: ['formatted_text'] }
        },
        {
            id: 'http_request',
            label: 'HTTP Request',
            description: 'Call an external endpoint and save the response payload.',
            nodeType: NodeType.TOOL,
            stateContract: { inputKeys: ['url', 'method', 'body'], outputKeys: ['response'] }
        },
        {
            id: 'mcp_tool_node',
            label: 'MCP Tool Node',
            description: 'Call a tool through an MCP-capable server and pass the result into the workflow state.',
            nodeType: NodeType.MCP,
            stateContract: { inputKeys: ['tool_name', 'request'], outputKeys: ['tool_result'] }
        },
        {
            id: 'rag_search',
            label: 'RAG Search',
            description: 'Retrieve relevant context from indexed knowledge before generation or decision-making.',
            nodeType: NodeType.RETRIEVAL,
            stateContract: { inputKeys: ['query', 'context'], outputKeys: ['retrieved_context'] }
        },
        {
            id: 'memory_recall',
            label: 'Memory Recall',
            description: 'Fetch prior user or workflow memory to inform the next step.',
            nodeType: NodeType.MEMORY,
            stateContract: { inputKeys: ['memory_key', 'user_context'], outputKeys: ['memory_result'] }
        },
        {
            id: 'validation_gate',
            label: 'Validation Gate',
            description: 'Check whether data meets required conditions before continuing execution.',
            nodeType: NodeType.VALIDATION,
            stateContract: { inputKeys: ['payload', 'rules'], outputKeys: ['validated'] }
        },
        {
            id: 'approval_gate',
            label: 'Approval Gate',
            description: 'Pause execution and wait for explicit human approval before a risky action continues.',
            nodeType: NodeType.APPROVAL,
            stateContract: { inputKeys: ['decision', 'reason'], outputKeys: ['approved'] }
        },
        {
            id: 'summary_output',
            label: 'Summary Output',
            description: 'Create a final summary message for the user or downstream step.',
            nodeType: NodeType.OUTPUT,
            stateContract: { inputKeys: ['summary'], outputKeys: ['result'] }
        }
    ], []);

    const reusableNodes = useMemo<ReusableNodeTemplate[]>(() => [...reusableToolNodes, ...reusableHelperNodes], [reusableToolNodes, reusableHelperNodes]);
    const activeTask = activeTaskId ? taskSessions.find(task => task.id === activeTaskId) ?? null : null;
    const chatMessages = activeTask?.messages ?? [];
    const activeTaskDraft = activeTaskId ? (taskDrafts[activeTaskId] ?? '') : magicPrompt;

    useEffect(() => {
        if (!activeTaskId) return;

        const nextTask = taskSessions.find(task => task.id === activeTaskId);
        if (!nextTask) return;

        const taskNodes = nextTask.workflow?.nodes ?? [];
        const taskEdges = nextTask.workflow?.edges ?? [];
        setNodes(taskNodes);
        setEdges(taskEdges);
    }, [activeTaskId]);

    useEffect(() => {
        if (!activeTaskId) return;

        const currentTask = taskSessions.find(task => task.id === activeTaskId);
        const serializedCurrent = JSON.stringify(currentTask?.workflow ?? { nodes: [], edges: [] });
        const serializedNext = JSON.stringify({ nodes, edges });

        if (serializedCurrent === serializedNext) return;

        setTaskSessions(prev => prev.map(task => task.id === activeTaskId
            ? { ...task, workflow: { nodes, edges } }
            : task));
    }, [activeTaskId, nodes, edges]);
    const getActivePrompt = useCallback(() => (activeTaskId ? (taskDrafts[activeTaskId] ?? '') : magicPrompt).trim(), [activeTaskId, taskDrafts, magicPrompt]);
    const setActiveTaskDraft = useCallback((value: string) => {
        if (!activeTaskId) {
            setMagicPrompt(value);
            return;
        }
        setTaskDrafts(prev => ({ ...prev, [activeTaskId]: value }));
    }, [activeTaskId]);
    const createNewTask = useCallback(() => {
        const nextIndex = taskSessions.length + 1;
        const nextTask = createChatTaskSession(`Task ${nextIndex}`, nextIndex);
        setTaskSessions(prev => [...prev, nextTask]);
        setTaskDrafts(prev => ({ ...prev, [nextTask.id]: '' }));
        setActiveTaskId(nextTask.id);
        setNodes([]);
        setEdges([]);
        setChatInput('');
        setMagicPrompt('');
        setSidebarOpen(true);
        setShowChatPanel(true);
    }, [taskSessions.length, setNodes, setEdges]);

    const handleDeleteTask = useCallback((taskId: string) => {
        setTaskSessions(prev => {
            const remaining = prev.filter(task => task.id !== taskId);
            if (remaining.length === 0) {
                const fresh = createChatTaskSession('Task 1', 1);
                setActiveTaskId(fresh.id);
                setNodes([]);
                setEdges([]);
                setTaskDrafts(current => ({ ...current, [fresh.id]: '' }));
                return [fresh];
            }

            setActiveTaskId(current => current === taskId ? remaining[0].id : current);
            if (activeTaskId === taskId) {
                const nextTask = remaining[0];
                setNodes(nextTask.workflow?.nodes ?? []);
                setEdges(nextTask.workflow?.edges ?? []);
            }
            return remaining;
        });

        setTaskDrafts(prev => {
            const next = { ...prev };
            delete next[taskId];
            return next;
        });
    }, [activeTaskId, setNodes, setEdges]);
    const updateActiveTaskMessages = useCallback((updater: (messages: ChatMessage[]) => ChatMessage[]) => {
        if (!activeTaskId) return;
        setTaskSessions(prev => prev.map(task => task.id === activeTaskId
            ? { ...task, messages: updater(task.messages) }
            : task));
    }, [activeTaskId]);
    const workflowTemplates = useMemo(() => [
        {
            id: 'lead_follow_up',
            title: 'Lead follow-up',
            summary: 'Capture lead data, summarize it, and send a personalized email.',
            prompt: 'Create a lead qualification workflow: collect a lead, summarize the request, send a follow-up email, and log the result to a sheet.'
        },
        {
            id: 'support_triage',
            title: 'Support triage',
            summary: 'Review incoming request, route to team, and notify channel.',
            prompt: 'Create a support triage workflow that reads an incoming request, categorizes the issue, and alerts the right team in Slack.'
        },
        {
            id: 'content_approval',
            title: 'Content approval',
            summary: 'Draft content, validate it, and ask for approval before publishing.',
            prompt: 'Create a content approval workflow that drafts a message, checks it for formatting issues, and pauses for approval before sending.'
        }
    ], []);
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
    const [generationStatuses, setGenerationStatuses] = useState<Record<string, 'pending' | 'generating' | 'done' | 'error'>>({});
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
                    lastExecutionStatus: 'idle'
                }
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

    const handleLoad = useCallback(async (name: string) => {
        const wf = await loadWorkflow(name);
        if (!wf) return;
        setActiveWorkflowName(name);
        setNodes(wf.nodes);
        setEdges(wf.edges);
        setTimeout(() => fitView({ padding: 0.2 }), 100);
    }, [setNodes, setEdges, fitView]);

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
        clearLogs
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

    useEffect(() => {
        try {
            const runtimeKey = 'autoagent_runtime_checkpoint';
            const raw = localStorage.getItem(runtimeKey);
            if (!raw) return;
            const checkpoint = JSON.parse(raw);
            if (!checkpoint || !checkpoint.graphState) return;
            const isResumable = ['running', 'paused', 'failed'].includes(checkpoint.status);
            if (!isResumable || !nodes.length) return;

            const shouldResume = window.confirm(
                `Resume the last saved workflow run from ${checkpoint.status === 'failed' ? 'the failed step' : 'the last checkpoint'}?\n\nThis will continue from the latest runtime state.`
            );

            if (shouldResume) {
                setActiveView('execution');
                void executeFlow();
            }
        } catch (err) {
            console.warn('[WorkflowCanvas] Unable to restore execution checkpoint:', err);
        }
    }, [executeFlow, nodes.length]);

    // Keyboard shortcuts for undo/redo
    React.useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
                e.preventDefault();
                if (e.shiftKey) redo(); else undo();
            }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [undo, redo]);

    const selectedNode = useMemo(() => nodes.find(n => n.id === selectedNodeId), [nodes, selectedNodeId]);

    // Calculate all available input keys from used tools + existing state
    const availableWorkflowKeys = useMemo(() => {
        if (selectedNodeId !== 'root') return [];
        const keys = new Set<string>();

        // 1. Add existing initialState keys
        if (selectedNode?.data.initialState) {
            Object.keys(selectedNode.data.initialState).forEach(k => keys.add(k));
        }

        // 2. Add keys from tools found via toolId
        nodes.forEach(n => {
            if (n.data.toolId) {
                const tool = getTool(n.data.toolId);
                if (tool) {
                    // If toolAction matches, use that action's keys
                    const action = tool.actions.find(a => a.name === n.data.toolAction);
                    if (action?.inputKeys) {
                        action.inputKeys.forEach(k => keys.add(k));
                    } else {
                        // No matching action — add ALL action keys from this tool
                        tool.actions.forEach(a => a.inputKeys.forEach(k => keys.add(k)));
                    }
                }
            }
        });

        // 3. Scan node labels/descriptions for tool name mentions (fallback matching)
        const allTools = getAllTools();
        nodes.forEach(n => {
            if (n.data.toolId) return; // Already handled above
            const text = ((n.data.label || '') + ' ' + (n.data.description || '')).toLowerCase();
            for (const tool of allTools) {
                const mentions = [tool.name.toLowerCase(), tool.id.toLowerCase()];
                if (mentions.some(kw => text.includes(kw))) {
                    tool.actions.forEach(a => a.inputKeys.forEach(k => keys.add(k)));
                    break;
                }
            }
        });

        return Array.from(keys).sort();
    }, [nodes, selectedNodeId, selectedNode]);
    const showSplash = nodes.length === 0 && !isGenerating;
    const showGeneratingOverlay = nodes.length === 0 && isGenerating;

    const onConnectStart = useCallback((_: React.MouseEvent | React.TouchEvent, params: { nodeId?: string | null; handleType?: string | null; handleId?: string | null }) => {
        if (!params.nodeId) return;

        const sourceNode = nodes.find(n => n.id === params.nodeId);
        if (!sourceNode) return;

        setConnectionSuggestion({
            source: params.nodeId,
            position: {
                x: sourceNode.position.x + 260,
                y: sourceNode.position.y + 180
            }
        });
    }, [nodes]);

    const onConnect = useCallback(
        (params: Connection | Edge) => {
            if (!params.source) return;

            const sourceNode = nodes.find(n => n.id === params.source);
            if (!sourceNode) return;

            if (!params.target) {
                setConnectionSuggestion({
                    source: params.source,
                    position: { x: sourceNode.position.x + 260, y: sourceNode.position.y + 180 }
                });
                return;
            }

            const targetNode = nodes.find(n => n.id === params.target);
            if (!targetNode) {
                setEdges((eds) => addEdge({
                    ...params,
                    animated: true,
                    style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
                    markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' }
                }, eds));
                return;
            }

            const midX = (sourceNode.position.x + targetNode.position.x) / 2 + 180;
            const midY = (sourceNode.position.y + targetNode.position.y) / 2 + 60;
            setConnectionSuggestion({
                source: params.source,
                target: params.target,
                position: { x: midX, y: midY }
            });
        },
        [nodes, setEdges]
    );

    const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => setSelectedNodeId(node.id), []);
    const onPaneClick = useCallback(() => setSelectedNodeId(null), []);

    const handleMagicGenerate = async () => {
        const prompt = getActivePrompt();
        const promptAnalysis = isMeaningfulWorkflowPrompt(prompt);
        if (!promptAnalysis.valid) {
            if (activeTaskId) {
                setTaskSessions(prev => prev.map(task => task.id === activeTaskId ? {
                    ...task,
                    name: deriveTaskNameFromPrompt(prompt) || task.name,
                    messages: [...task.messages, { role: 'assistant', text: promptAnalysis.reason || 'Please describe a concrete workflow goal.' }]
                } : task));
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
            setTaskSessions(prev => prev.map(task => task.id === activeId ? {
                ...task,
                name: normalizeTaskTitle(nextName || task.name),
                messages: [
                    ...task.messages,
                    { role: 'user', text: prompt },
                    { role: 'assistant', text: 'I\'m validating your workflow request and building the plan before execution.' }
                ]
            } : task));
        }

        setIsGenerating(true);
        try {
            const modelForGeneration = effectiveModel;
            const plan = await generateWorkflowPlan(promptAnalysis.normalized || prompt, modelForGeneration);
            setPlanDraft({
                id: `plan-${Date.now()}`,
                plan,
                workflow: planToWorkflow(plan)
            });
            setGenerationStatuses({});
            setPlanStep(0);
            setIsCommittingPlan(false);
            setActiveTaskDraft('');
            setMagicPrompt('');
            if (activeId) {
                setTaskSessions(prev => prev.map(task => task.id === activeId ? {
                    ...task,
                    messages: [...task.messages, { role: 'assistant', text: 'Your workflow draft is ready. I can refine, route, or execute it next.' }]
                } : task));
            }
        } catch (err) {
            console.error(err);
            // Say which of the two failed: a plan that contradicted the tool
            // catalog needs a different fix from a provider that was unreachable.
            const detail = err instanceof PlanValidationError
                ? `I could not build a plan that matches the connected tools:\n- ${err.issues.join('\n- ')}`
                : err instanceof Error
                    ? `I hit a problem generating that flow: ${err.message}`
                    : 'I hit a problem generating that flow.';

            if (activeId) {
                setTaskSessions(prev => prev.map(task => task.id === activeId ? {
                    ...task,
                    messages: [...task.messages, { role: 'assistant', text: detail }]
                } : task));
            }
        } finally {
            setIsGenerating(false);
        }
    };

    const handleWorkflowChatSubmit = useCallback(() => {
        const prompt = chatInput.trim();
        if (!prompt || !activeTaskId) return;

        const messageText = prompt.toLowerCase();
        updateActiveTaskMessages(prev => [...prev, { role: 'user', text: prompt }]);
        setChatInput('');

        const selected = selectedNodeId ? nodes.find(node => node.id === selectedNodeId) : nodes[nodes.length - 1];
        const triggerNode = nodes.find(node => node.type === 'trigger') || nodes[0];

        const matchesTemplate = (label: string, fragments: string[]) =>
            fragments.some(fragment => label.toLowerCase().includes(fragment));

        try {
            if (messageText.includes('rename') || messageText.includes('change name') || messageText.includes('call it')) {
                const nextLabel = prompt.replace(/^(rename|change name|call it)/i, '').trim();
                if (selected && nextLabel) {
                    setNodes(prev => prev.map(node => node.id === selected.id ? { ...node, data: { ...node.data, label: nextLabel } } : node));
                    updateActiveTaskMessages(prev => [...prev, { role: 'assistant', text: `Updated the selected step to “${nextLabel}”.` }]);
                    return;
                }
            }

            if (messageText.includes('delete') || messageText.includes('remove') || messageText.includes('remove last')) {
                if (selected) {
                    setNodes(prev => prev.filter(node => node.id !== selected.id));
                    setEdges(prev => prev.filter(edge => edge.source !== selected.id && edge.target !== selected.id));
                    updateActiveTaskMessages(prev => [...prev, { role: 'assistant', text: `Removed the selected node and its connected edges.` }]);
                    return;
                }
            }

            if (messageText.includes('clear') || messageText.includes('reset')) {
                setNodes([]);
                setEdges([]);
                updateActiveTaskMessages(prev => [...prev, { role: 'assistant', text: 'The canvas was cleared. Start a new workflow from the trigger node.' }]);
                return;
            }

            let template: ReusableNodeTemplate | undefined = reusableHelperNodes.find(item =>
                matchesTemplate(item.label, ['approval', 'approve', 'human', 'review']) ||
                matchesTemplate(item.label, ['validation', 'check']) ||
                matchesTemplate(item.label, ['wait', 'delay', 'pause']) ||
                matchesTemplate(item.label, ['condition', 'branch', 'if']) ||
                matchesTemplate(item.label, ['summary', 'output'])
            );

            if (!template) {
                const toolTemplate = reusableToolNodes.find(item =>
                    item.label.toLowerCase().includes('gmail') && (messageText.includes('email') || messageText.includes('gmail')) ||
                    item.label.toLowerCase().includes('slack') && messageText.includes('slack') ||
                    item.label.toLowerCase().includes('sheet') && (messageText.includes('sheet') || messageText.includes('spreadsheet')) ||
                    item.label.toLowerCase().includes('whatsapp') && messageText.includes('whatsapp') ||
                    item.label.toLowerCase().includes('drive') && messageText.includes('drive')
                );

                template = toolTemplate || reusableHelperNodes.find(item => item.label.toLowerCase().includes('validation') || item.label.toLowerCase().includes('set variable')) || reusableHelperNodes[0];
            }

            if (!template) {
                updateActiveTaskMessages(prev => [...prev, { role: 'assistant', text: 'No reusable step template is available to apply that change.' }]);
                return;
            }

            const newId = createNodeId(template.label || 'node');
            const targetNode = selected || triggerNode;
            const newNode: Node = {
                id: newId,
                type: template.nodeType === NodeType.TOOL ? 'tool' : template.nodeType === NodeType.LOGIC ? 'logic' : template.nodeType === NodeType.OUTPUT ? 'output' : 'ai_agent',
                position: targetNode ? { x: targetNode.position.x + 220, y: targetNode.position.y + 100 } : { x: 420, y: 220 },
                data: {
                    label: template.label,
                    type: template.nodeType,
                    description: template.description,
                    ...(template.toolId ? { toolId: template.toolId } : {}),
                    ...(template.toolAction ? { toolAction: template.toolAction } : {}),
                    stateContract: template.stateContract || { inputKeys: [], outputKeys: ['result'] }
                }
            };

            setNodes(prev => [...prev, newNode]);
            if (targetNode) {
                setEdges(prev => [...prev, {
                    id: `edge_${targetNode.id}_${newId}`,
                    source: targetNode.id,
                    target: newId,
                    animated: true,
                    style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
                    markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' }
                } as Edge]);
            }

            setSelectedNodeId(newId);
            updateActiveTaskMessages(prev => [...prev, { role: 'assistant', text: `Added “${template.label}” to the workflow and connected it to the active step.` }]);
        } catch (error) {
            updateActiveTaskMessages(prev => [...prev, { role: 'assistant', text: 'I could not apply that change. Try a simpler instruction like “Add approval before sending email”.' }]);
            console.error('Workflow chat edit failed:', error);
        }
    }, [activeTaskId, chatInput, nodes, reusableHelperNodes, reusableToolNodes, selectedNodeId, setNodes, setEdges, updateActiveTaskMessages]);

    /**
     * Put the reviewed graph on the canvas.
     *
     * The argument is the draft as the user LEFT it in the preview — renamed
     * steps, deleted steps, filled-in values and all — not the plan as generated.
     * Nothing is re-derived here: what the preview showed is what lands.
     */
    const handleCommitPlan = async (reviewed: Workflow) => {
        const formattedNodes = reviewed.nodes.map(node => ({
            ...node,
            position: { x: node.position.x + 300, y: node.position.y + 150 }
        }));

        const formattedEdges = reviewed.edges.map(edge => ({
            ...edge,
            animated: true,
            style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' }
        }));

        setIsCommittingPlan(true);
        setPlanStep(0);

        // Streamed one at a time purely so the user can see what arrived. There
        // is no model call in this loop — node data came from the validated plan
        // step via `buildNodeFromPlanStep`.
        for (let i = 0; i < formattedNodes.length; i++) {
            const node = formattedNodes[i];
            setGenerationStatuses(prev => ({ ...prev, [node.id]: 'generating' }));
            await new Promise(resolve => setTimeout(resolve, 120));
            setNodes(prev => [...prev, node as Node]);
            setGenerationStatuses(prev => ({ ...prev, [node.id]: 'done' }));
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

        nodes.forEach(node => {
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
            .map(toolId => toolStatuses.find(t => t.id === toolId))
            .filter(tool => tool && !tool.authenticated);

        return {
            allAuthenticated: missingTools.length === 0,
            missingTools: missingTools.filter(t => t !== undefined)
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
                stateContract: { inputKeys: [], outputKeys: ['trigger_data'] }
            }
        };

        setNodes([triggerNode]);
        setEdges([]);
        setSelectedNodeId(triggerNode.id);
    };

    const insertReusableNodeBetween = useCallback((template: {
        label: string;
        description: string;
        nodeType: NodeType;
        toolId?: string;
        toolAction?: string;
        stateContract?: { inputKeys: string[]; outputKeys: string[] };
    }, source: string, target?: string) => {
        if (!source) return;

        const newNodeId = createNodeId(template.label);

        const sourceNode = nodes.find(n => n.id === source);
        const targetNode = target ? nodes.find(n => n.id === target) : undefined;
        const insertPosition = sourceNode && targetNode
            ? {
                x: (sourceNode.position.x + targetNode.position.x) / 2,
                y: (sourceNode.position.y + targetNode.position.y) / 2 + 120
            }
            : sourceNode
                ? { x: sourceNode.position.x + 220, y: sourceNode.position.y + 150 }
                : { x: 500, y: 220 };

        const newNode: Node = {
            id: newNodeId,
            type: template.nodeType === NodeType.TOOL ? 'tool' : template.nodeType === NodeType.LOGIC ? 'logic' : template.nodeType === NodeType.OUTPUT ? 'output' : 'ai_agent',
            position: insertPosition,
            data: {
                label: template.label,
                type: template.nodeType,
                description: template.description,
                ...(template.toolId && template.toolAction ? { toolId: template.toolId, toolAction: template.toolAction } : {}),
                stateContract: template.stateContract || { inputKeys: [], outputKeys: ['result'] }
            }
        };

        const firstEdge = {
            id: `edge_${source}_${newNodeId}`,
            source,
            target: newNodeId,
            animated: true,
            style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' }
        };

        const finalEdges: Edge[] = target
            ? [
                { id: `edge_${newNodeId}_${target}`, source: newNodeId, target, animated: true, style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' } } as Edge
            ]
            : [];

        setNodes(prev => [...prev, newNode]);
        setEdges(prev => {
            const filtered = target
                ? prev.filter(edge => !(edge.source === source && edge.target === target))
                : prev.filter(edge => edge.source !== source || edge.target !== newNodeId);

            return [
                ...filtered,
                firstEdge as Edge,
                ...finalEdges
            ];
        });
        setConnectionSuggestion(null);
    }, [nodes, setNodes, setEdges]);

    const addReusableNode = useCallback((template: {
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
            type: template.nodeType === NodeType.TOOL ? 'tool' : template.nodeType === NodeType.LOGIC ? 'logic' : template.nodeType === NodeType.OUTPUT ? 'output' : 'ai_agent',
            position: {
                x: 300 + (existingCount % 4) * 260,
                y: 180 + Math.floor(existingCount / 4) * 180
            },
            data: {
                label: template.label,
                type: template.nodeType,
                description: template.description,
                ...(template.toolId && template.toolAction ? { toolId: template.toolId, toolAction: template.toolAction } : {}),
                stateContract: template.stateContract || { inputKeys: [], outputKeys: ['result'] }
            }
        };

        setNodes(prev => [...prev, baseNode]);
    }, [nodes, setNodes]);

    const validateWorkflowForExecution = useCallback(() => {
        if (nodes.length === 0) {
            return { valid: false, message: 'Add at least one workflow node before running.' };
        }

        const triggerNodes = nodes.filter(node => node.type === 'trigger');
        if (triggerNodes.length === 0) {
            return { valid: false, message: 'Every workflow needs a trigger node before execution.' };
        }

        const invalidNodes = nodes.filter(node => {
            if (!node.data || (!node.data.toolId && !node.data.toolAction)) return false;
            return !node.data.toolId || !node.data.toolAction;
        });

        if (invalidNodes.length > 0) {
            return { valid: false, message: `Some tool nodes are incomplete: ${invalidNodes.map(n => n.data.label || n.id).join(', ')}` };
        }

        const missingToolDefinitions = nodes.filter(node => node.data.toolId && !getTool(node.data.toolId));
        if (missingToolDefinitions.length > 0) {
            return { valid: false, message: `Tool registry is missing definitions for: ${missingToolDefinitions.map(n => n.data.toolId).join(', ')}` };
        }

        const orphanNodes = nodes.filter(node => {
            const nodeHasSource = edges.some(edge => edge.source === node.id);
            const nodeHasTarget = edges.some(edge => edge.target === node.id);
            return node.type !== 'trigger' && !nodeHasSource && !nodeHasTarget;
        });

        if (orphanNodes.length > 0) {
            return {
                valid: false,
                message: `These workflow nodes are disconnected: ${orphanNodes.map(n => n.data.label || n.id).join(', ')}`
            };
        }

        // Validate edge conditions before the run rather than discovering a bad
        // one mid-execution. At run time an undecidable condition fails closed,
        // which silently drops a branch — surfacing it here explains why instead.
        const badConditions = (edges as FlowEdge[])
            .map(edge => ({ edge, error: validateCondition(edge.condition ?? '') }))
            .filter((entry): entry is { edge: FlowEdge; error: string } => entry.error !== null);

        if (badConditions.length > 0) {
            const details = badConditions
                .map(({ edge, error }) => {
                    const from = nodes.find(n => n.id === edge.source)?.data.label || edge.source;
                    const to = nodes.find(n => n.id === edge.target)?.data.label || edge.target;
                    return `"${from}" to "${to}": ${error}`;
                })
                .join('\n');
            return {
                valid: false,
                message: `Some branch conditions are not valid, so those paths could never be taken:\n\n${details}`
            };
        }

        return { valid: true, message: 'Workflow ready' };
    }, [nodes, edges]);

    const collectRequiredInputsBeforeExecution = useCallback(() => {
        const requiredInputs = new Map<string, string>();
        const producedKeys = new Set<string>();
        const genericDerivedKeys = new Set([
            'input', 'query', 'context', 'result', 'raw_data', 'categorized_results',
            'message', 'text', 'body', 'data', 'rows', 'values', 'summary'
        ]);

        nodes.forEach(node => {
            const outputKeys = Array.isArray(node.data?.stateContract?.outputKeys)
                ? node.data.stateContract.outputKeys
                : [];
            outputKeys.forEach((key: string) => producedKeys.add(key));
        });

        nodes.forEach(node => {
            const contract = node.data?.stateContract || {};
            if (node.data?.toolId === 'google_sheets' && getDefaultSpreadsheetId()) return;
            const declaredKeys = Array.isArray(contract.externalInputKeys)
                ? contract.externalInputKeys
                : node.data?.toolId === 'google_sheets'
                    ? ['spreadsheetId']
                    : (Array.isArray(contract.inputKeys) ? contract.inputKeys : []);
            const inputKeys = declaredKeys.filter((key: string) => {
                if (producedKeys.has(key) || genericDerivedKeys.has(key)) return false;
                if (key === 'page_url' && declaredKeys.includes('source_url')) return false;
                return true;
            });
            inputKeys.forEach((key: string) => {
                if (!requiredInputs.has(key)) {
                    const existingValue = node.data?.initialState?.[key];
                    requiredInputs.set(key, existingValue ?? '');
                }
            });
        });

        const missingKeys = Array.from(requiredInputs.entries())
            .filter(([, value]) => !value || String(value).trim() === '')
            .map(([key]) => key);

        if (missingKeys.length === 0) {
            return true;
        }

        const updatedInitialState: Record<string, string> = {};

        for (const key of missingKeys) {
            const label = key.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
            const answer = window.prompt(`This workflow needs a value for "${label || key}". Enter it to continue:`, '');
            if (answer === null) {
                return false;
            }
            if (!answer.trim()) {
                alert(`"${label || key}" is required before running this workflow.`);
                return false;
            }
            updatedInitialState[key] = answer.trim();
        }

        setNodes(prev => prev.map(node => {
            const contract = node.data?.stateContract || {};
            const contractKeys = Array.isArray(contract.externalInputKeys)
                ? contract.externalInputKeys
                : node.data?.toolId === 'google_sheets'
                    ? ['spreadsheetId']
                    : (Array.isArray(contract.inputKeys) ? contract.inputKeys : []);
            if (contractKeys.length === 0) return node;

            const mergedInitial = {
                ...(node.data?.initialState || {}),
                ...Object.fromEntries(
                    Object.entries(updatedInitialState).filter(([key]) => contractKeys.includes(key))
                )
            };

            return {
                ...node,
                data: {
                    ...node.data,
                    initialState: mergedInitial
                }
            };
        }));

        return true;
    }, [nodes, setNodes]);

    const handleExecuteFlow = async () => {
        const hasAllInputs = collectRequiredInputsBeforeExecution();
        if (!hasAllInputs) {
            return;
        }

        const validation = validateWorkflowForExecution();
        if (!validation.valid) {
            alert(validation.message);
            return;
        }

        // Check if all required tools are authenticated
        const { allAuthenticated, missingTools } = checkRequiredAuthentication();

        if (!allAuthenticated && missingTools.length > 0) {
            // Show authentication prompt
            const toolNames = missingTools.map(t => t.name).join(', ');
            const shouldProceed = window.confirm(
                `This workflow requires authentication for: ${toolNames}\n\n` +
                `Would you like to authenticate now? Click OK to authenticate, Cancel to abort.`
            );

            if (!shouldProceed) {
                return; // User cancelled
            }

            // Trigger authentication for each missing tool
            for (const tool of missingTools) {
                console.log(`[Auth] Authenticating ${tool.name} before execution...`);
                await authenticate(tool.id);
            }

            // Re-check after authentication
            const recheckResult = checkRequiredAuthentication();
            if (!recheckResult.allAuthenticated) {
                alert('Authentication failed or was cancelled. Workflow execution aborted.');
                return;
            }
        }

        try {
            setAuthReconnect(null);
            setIsTesting(true);
            setShowChatPanel(true);
            if (activeTaskId) {
                setTaskSessions(prev => prev.map(task => task.id === activeTaskId ? {
                    ...task,
                    messages: [...task.messages, { role: 'assistant', text: 'Running the current workflow and streaming execution updates here.' }]
                } : task));
            }
            await executeFlow();
            if (activeTaskId) {
                setTaskSessions(prev => prev.map(task => task.id === activeTaskId ? {
                    ...task,
                    messages: [...task.messages, { role: 'assistant', text: 'Execution completed successfully.' }]
                } : task));
            }
            if (activeWorkflowName) {
                const { recordWorkflowRun } = await import('@features/workflow/services/workflowStorage');
                await recordWorkflowRun(activeWorkflowName, effectiveModel, 'completed');
            }
        } catch (err) {
            const errorText = String(err || 'Workflow execution failed');
            const lower = errorText.toLowerCase();
            const isAuthIssue = lower.includes('auth') || lower.includes('expired') || lower.includes('not authenticated') || lower.includes('connect it first');

            if (activeTaskId) {
                setTaskSessions(prev => prev.map(task => task.id === activeTaskId ? {
                    ...task,
                    messages: [...task.messages, { role: 'assistant', text: `Execution failed: ${errorText}` }]
                } : task));
            }

            if (isAuthIssue) {
                const toolId = toolStatuses.find(t => lower.includes(t.name.toLowerCase()) || lower.includes(t.id.toLowerCase()))?.id || 'gmail';
                const toolName = toolStatuses.find(t => t.id === toolId)?.name || 'Gmail';
                setAuthReconnect({ toolId, toolName, message: errorText });
                setIsTesting(false);
                if (activeWorkflowName) {
                    const { recordWorkflowRun } = await import('@features/workflow/services/workflowStorage');
                    await recordWorkflowRun(activeWorkflowName, effectiveModel, 'failed');
                }
                return;
            }

            if (activeWorkflowName) {
                const { recordWorkflowRun } = await import('@features/workflow/services/workflowStorage');
                await recordWorkflowRun(activeWorkflowName, effectiveModel, 'failed');
            }
            alert(`Workflow execution failed:\n${errorText}`);
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
                message: `Reconnect failed for ${authReconnect.toolName}: ${message}`
            });
        }
    };

    const downloadOutput = (content: string, filename: string) => {
        const blob = new Blob([content], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename + ".txt";
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
                        <p className="text-xs text-white/70 mb-2">Node: <span className="font-semibold text-white">{approvalRequest.nodeLabel}</span></p>
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
                        <button onClick={() => setSidebarOpen(false)} className="p-1 rounded-full hover:bg-white/5 text-white/40 hover:text-white">
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                        <span className="font-bold text-sm tracking-tight text-white/90">AutoAgent</span>
                    </div>
                </div>

                <div className="px-5 mb-4">
                    <div className="p-4 bg-white/[0.03] border border-white/5 rounded-2xl">
                        <p className="text-[11px] font-bold text-white/30 uppercase tracking-widest mb-4">Connected Tools</p>
                        <div className="space-y-3">
                            {toolStatuses.map(tool => (
                                <button
                                    key={tool.id}
                                    onClick={() => {
                                        console.log(`🔑 [Auth] Attempting to ${tool.authenticated ? 're-' : ''}authenticate ${tool.name}...`);
                                        authenticate(tool.id);
                                    }}
                                    disabled={authInProgress === tool.id}
                                    className="w-full flex items-center justify-between group hover:bg-white/5 rounded-lg px-2 py-1.5 transition-all -mx-2"
                                >
                                    <div className="flex items-center gap-2">
                                        <Mail className="w-3.5 h-3.5" style={{ color: tool.color }} />
                                        <span className="text-[11px] font-medium text-white/60 group-hover:text-white/80">{tool.name}</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        {authInProgress === tool.id && (
                                            <Loader2 className="w-3 h-3 animate-spin text-white/40" />
                                        )}
                                        <div className={`w-1.5 h-1.5 rounded-full transition-all ${tool.authenticated
                                            ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]'
                                            : 'bg-white/20'
                                            }`} />
                                        {tool.authenticated && (
                                            <span className="text-[9px] text-white/30 opacity-0 group-hover:opacity-100 transition-opacity">refresh</span>
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
                            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/35">Task Sessions</div>
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
                                <div key={task.id} className={`flex items-center gap-2 rounded-xl border transition-all ${activeTaskId === task.id ? 'border-bolt-accent/40 bg-bolt-accent/10 text-white' : 'border-white/5 bg-white/[0.02] text-white/60 hover:bg-white/[0.04]'}`}>
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
                                        <div className="text-[9px] text-white/35 mt-1">{task.messages.length} messages</div>
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
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${activeView === 'graph' ? 'bg-white/5 text-white' : 'text-white/40 hover:text-white hover:bg-white/5'
                            }`}
                    >
                        <Box className="w-4 h-4 text-bolt-accent" />
                        <span className="text-xs font-semibold">Graph View</span>
                    </button>
                    <button
                        onClick={() => setActiveView(activeView === 'execution' ? 'graph' : 'execution')}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all ${activeView === 'execution' ? 'bg-white/5 text-white' : 'text-white/40 hover:text-white hover:bg-white/5'
                            }`}
                    >
                        <TerminalIcon className="w-4 h-4" />
                        <span className="text-xs font-semibold">Execution Hub</span>
                    </button>

                    <div className="pt-2 border-t border-white/5 mt-2">
                        <p className="px-2 text-[10px] font-bold uppercase tracking-widest text-white/30 mb-2">Reusable Nodes</p>
                        <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
                            {reusableNodes.map((template) => (
                                <button
                                    key={template.id || `${template.toolId}-${template.toolAction}`}
                                    onClick={() => addReusableNode({
                                        label: template.label,
                                        description: template.description,
                                        nodeType: template.nodeType,
                                        ...(template.toolId ? { toolId: template.toolId } : {}),
                                        ...(template.toolAction ? { toolAction: template.toolAction } : {}),
                                        ...(template.stateContract ? { stateContract: template.stateContract } : {})
                                    })}
                                    className="w-full rounded-lg border border-white/5 bg-white/[0.02] px-2 py-1.5 text-left transition hover:bg-white/5"
                                    title={template.description}
                                >
                                    <div className="text-[10px] font-medium text-white/75 truncate">{template.label}</div>
                                    <div className="text-[9px] text-white/35 truncate">{template.toolName || 'Logic / Helper'}</div>
                                </button>
                            ))}
                        </div>
                    </div>

                    {savedList.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-white/5">
                            <p className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 px-3">My Workflows</p>
                            {savedList.map(w => (
                                <div key={w.name} className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-white/5 transition-all group">
                                    <button onClick={() => handleLoad(w.name)} className="flex-1 text-left text-xs text-white/60 hover:text-white truncate">
                                        {w.name}
                                    </button>
                                    <button onClick={() => handleDelete(w.name)} className="opacity-0 group-hover:opacity-100 p-1 hover:text-red-400 transition-all">
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
                            Each node reads/writes to a shared state object. Click "Run Flow" to execute the graph.
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
                                        <button onClick={handleBlankAgent} className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-white/60 hover:bg-white/10 transition-all flex items-center gap-2">
                                            <Plus className="w-3.5 h-3.5" />
                                            Blank
                                        </button>
                                    </div>

                                    <div className="flex items-center gap-2 ml-auto">
                                        <div className="flex items-center gap-2 rounded-xl border border-white/10 bg-[#0d0d0d] px-2 py-1.5 shadow-inner shadow-black/30">
                                            <label className="text-[11px] text-white/45 font-medium">Model:</label>
                                            <select
                                                value={selectedModel}
                                                onChange={e => setSelectedModel(e.target.value)}
                                                className="appearance-none bg-[#0d0d0d] text-white text-xs font-medium border-0 outline-none rounded-md pr-6 cursor-pointer min-w-[200px]"
                                                style={{
                                                    backgroundImage: "linear-gradient(45deg, transparent 50%, rgba(255,255,255,0.7) 50%), linear-gradient(135deg, rgba(255,255,255,0.7) 50%, transparent 50%)",
                                                    backgroundPosition: "calc(100% - 14px) calc(50% - 2px), calc(100% - 9px) calc(50% - 2px)",
                                                    backgroundSize: "5px 5px, 5px 5px",
                                                    backgroundRepeat: "no-repeat",
                                                    colorScheme: 'dark'
                                                }}
                                            >
                                                <option value="auto" className="bg-[#111] text-white">Auto best fit</option>
                                                <option value={AI_CONFIG.openRouterModel} className="bg-[#111] text-white">OpenRouter: {AI_CONFIG.openRouterModel}</option>
                                                <option value={AI_CONFIG.geminiModel} className="bg-[#111] text-white">Gemini: {AI_CONFIG.geminiModel}</option>
                                                <option value={AI_CONFIG.ollamaModel} className="bg-[#111] text-white">Ollama: {AI_CONFIG.ollamaModel}</option>
                                            </select>
                                        </div>

                                        <button onClick={handleMagicGenerate} disabled={!getActivePrompt() || isGenerating} className="p-4 bg-white/10 hover:bg-bolt-accent hover:text-black rounded-2xl transition-all disabled:opacity-20 shadow-lg group">
                                            {isGenerating ? <Loader2 className="w-6 h-6 animate-spin" /> : <ChevronRight className="w-6 h-6 group-hover:translate-x-1 transition-transform" />}
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
                                    <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Choose reusable node</p>
                                    <h3 className="text-sm font-semibold text-white">Build from a starting block</h3>
                                </div>
                                <button onClick={() => setNodes([])} className="rounded-full p-1.5 text-white/40 hover:bg-white/5 hover:text-white">
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
                                                type: template.nodeType === NodeType.TOOL ? 'tool' : template.nodeType === NodeType.LOGIC ? 'logic' : template.nodeType === NodeType.OUTPUT ? 'output' : 'ai_agent',
                                                position: { x: 520, y: 250 },
                                                data: {
                                                    label: template.label,
                                                    type: template.nodeType,
                                                    description: template.description,
                                                    ...(template.toolId ? { toolId: template.toolId } : {}),
                                                    ...(template.toolAction ? { toolAction: template.toolAction } : {}),
                                                    stateContract: template.stateContract || { inputKeys: [], outputKeys: ['result'] }
                                                }
                                            };
                                            const edge = {
                                                id: `edge_${nodes[0].id}_${nextId}`,
                                                source: nodes[0].id,
                                                target: nextId,
                                                animated: true,
                                                style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
                                                markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' }
                                            };
                                            setNodes(prev => [...prev, newNode]);
                                            setEdges(prev => [...prev, edge as Edge]);
                                        }}
                                        className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/5"
                                    >
                                        <div className="text-[10px] font-medium text-white/80">{template.label}</div>
                                        <div className="text-[9px] text-white/35 mt-1">{template.toolName || 'Logic / helper'}</div>
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
                            transform: 'translate(-50%, -50%)'
                        }}
                    >
                        <div className="pointer-events-auto w-[360px] rounded-2xl border border-white/10 bg-[#0d0d0d]/95 p-3 shadow-2xl backdrop-blur-sm">
                            <div className="flex items-center justify-between mb-2">
                                <div>
                                    <p className="text-[10px] uppercase tracking-[0.18em] text-white/35">Suggested reusable node</p>
                                    <h3 className="text-sm font-semibold text-white">Insert between these nodes</h3>
                                </div>
                                <button onClick={() => setConnectionSuggestion(null)} className="rounded-full p-1.5 text-white/40 hover:bg-white/5 hover:text-white">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                                {reusableNodes.map((template) => (
                                    <button
                                        key={template.id || `${template.toolId}-${template.toolAction}`}
                                        onClick={() => insertReusableNodeBetween(template, connectionSuggestion.source, connectionSuggestion.target)}
                                        className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2 text-left transition hover:bg-white/5"
                                    >
                                        <div className="text-[10px] font-medium text-white/80">{template.label}</div>
                                        <div className="text-[9px] text-white/35 mt-1">{template.toolName || 'Logic / helper'}</div>
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
                                        setEdges(prev => addEdge({
                                            id: `edge_${connectionSuggestion.source}_${directTarget}`,
                                            source: connectionSuggestion.source,
                                            target: directTarget,
                                            animated: true,
                                            style: { strokeWidth: 2, stroke: '#2dd4bf', strokeDasharray: '4,4' },
                                            markerEnd: { type: MarkerType.ArrowClosed, color: '#2dd4bf' }
                                        }, prev));
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
                    <div className="absolute inset-0 z-50 flex items-center justify-center p-6 bg-[#050505]/80 backdrop-blur-md" onClick={() => setShowTemplatesModal(false)}>
                        <div className="bg-[#0a0a0a] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
                            <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between">
                                <h3 className="font-bold text-sm text-white">Saved Workflows</h3>
                                <button onClick={() => setShowTemplatesModal(false)} className="p-1.5 hover:bg-white/5 rounded-full text-white/40 hover:text-white transition-colors">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <div className="p-2 max-h-[60vh] overflow-y-auto">
                                {workflowTemplates.length > 0 && (
                                    <div className="mb-4 border-b border-white/10 pb-4">
                                        <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-[0.15em] text-white/35">Starter templates</p>
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
                                                        <p className="text-sm font-medium text-white/90 group-hover:text-white">{w.name}</p>
                                                        <p className="text-[10px] text-white/40 mt-0.5">{new Date(w.savedAt).toLocaleDateString()}</p>
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

                {/* 10-Framework Workflow Code Export Modal */}
                <ExportModal
                    isVisible={showExportModal}
                    onClose={() => setShowExportModal(false)}
                    nodes={nodes}
                    edges={edges}
                    workflowName={workflowName || activeTask?.name}
                    prompt={getActivePrompt()}
                />

                <header className="absolute top-0 right-0 z-30 px-5 py-4 shrink-0">
                    <div className="flex items-center gap-2">
                        <button onClick={() => setShowChatPanel(!showChatPanel)} className="px-3 py-2 text-white/60 hover:text-white transition-colors text-[10px] font-bold uppercase tracking-[0.2em] border border-white/10 rounded-xl bg-[#0d0d0d]/70 backdrop-blur-sm">
                            Chat
                        </button>
                        {!sidebarOpen && (
                            <button onClick={() => setSidebarOpen(true)} className="px-3 py-2 text-white/60 hover:text-white transition-colors text-[10px] font-bold uppercase tracking-[0.2em] border border-white/10 rounded-xl bg-[#0d0d0d]/70 backdrop-blur-sm">
                                Tasks
                            </button>
                        )}
                        <button onClick={handleClear} className="px-3 py-2 text-white/40 hover:text-white transition-colors text-[10px] font-bold uppercase tracking-[0.2em] border border-white/10 rounded-xl bg-[#0d0d0d]/70 backdrop-blur-sm">Clear</button>
                        <div className="flex items-center gap-1 border-r border-white/10 pr-3">
                            <button onClick={undo} disabled={!canUndo} title="Undo (⌘Z)" className="p-1.5 text-white/30 hover:text-white disabled:opacity-20 transition-all">
                                <Undo2 className="w-3.5 h-3.5" />
                            </button>
                            <button onClick={redo} disabled={!canRedo} title="Redo (⌘⇧Z)" className="p-1.5 text-white/30 hover:text-white disabled:opacity-20 transition-all">
                                <Redo2 className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        {showSaveDialog ? (
                            <div className="flex items-center gap-2">
                                <input
                                    type="text"
                                    value={workflowName}
                                    onChange={e => setWorkflowName(e.target.value)}
                                    placeholder="Workflow name…"
                                    className="bg-white/5 border border-white/10 rounded-lg px-3 py-1.5 text-xs text-white outline-none focus:border-bolt-accent/40 w-40"
                                    onKeyDown={e => e.key === 'Enter' && handleSave()}
                                    autoFocus
                                />
                                <button onClick={handleSave} disabled={!workflowName.trim()} className="p-2 bg-emerald-500/20 text-emerald-400 rounded-lg hover:bg-emerald-500/30 transition-all disabled:opacity-30">
                                    <Save className="w-3.5 h-3.5" />
                                </button>
                                <button onClick={() => setShowSaveDialog(false)} className="p-2 text-white/40 hover:text-white">
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        ) : (
                            <button onClick={() => setShowSaveDialog(true)} disabled={nodes.length === 0} className="flex items-center gap-1.5 px-3 py-2 text-white/40 hover:text-white transition-colors text-xs font-bold disabled:opacity-20">
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
                                <button onClick={pauseExecution} className="px-3 py-2 border border-white/10 bg-white/5 text-white/80 rounded-xl text-[10px] font-bold hover:bg-white/10">
                                    Pause
                                </button>
                                <button onClick={resumeExecution} className="px-3 py-2 border border-white/10 bg-white/5 text-white/80 rounded-xl text-[10px] font-bold hover:bg-white/10">
                                    Resume
                                </button>
                                <button onClick={cancelExecution} className="px-3 py-2 border border-red-500/30 bg-red-500/10 text-red-300 rounded-xl text-[10px] font-bold hover:bg-red-500/20">
                                    Cancel
                                </button>
                            </div>
                        )}
                        <button onClick={handleExecuteFlow} disabled={nodes.length === 0 || isExecuting} className="flex items-center gap-2 px-5 py-2.5 bg-bolt-accent text-black rounded-xl text-xs font-bold shadow-2xl hover:bg-bolt-accent/90 transition-all">
                            {isExecuting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5 fill-black" />}
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
                                    case 'trigger': return '#f59e0b';
                                    case 'ai_agent': return '#8b5cf6';
                                    case 'tool': return '#3b82f6';
                                    case 'logic': return '#ec4899';
                                    case 'output': return '#10b981';
                                    default: return '#6b7280';
                                }
                            }}
                            maskColor="rgba(0,0,0,0.7)"
                            className="!bg-[#0a0a0a] !border-white/5"
                            position="bottom-left"
                        />
                        <Panel position="bottom-center" className="mb-6 pointer-events-auto">
                            <Controls showInteractive={false} className="!static !shadow-none !border-white/5 !bg-[#111]" />
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
                                        The AI is creating your workflow. This may take a few seconds depending on the model.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* STATE GRAPH MONITOR */}
                        <Panel position="bottom-right" className={`mr-6 mb-6 transition-all duration-500 transform ${(isTesting || activeView === 'execution') ? 'translate-y-0 opacity-100' : 'translate-y-10 opacity-0 pointer-events-none'}`}>
                            <ExecutionMonitor
                                isVisible={isTesting || activeView === 'execution'}
                                isExecuting={isExecuting}
                                currentNodeLabel={currentNodeLabel}
                                executionLogs={executionLogs}
                                workflowNodes={nodes}
                                graphState={graphState}
                                onClose={() => { setIsTesting(false); setActiveView('graph'); }}
                                onDownload={downloadOutput}
                            />
                        </Panel>

                        {authReconnect && (
                            <div className="absolute inset-0 z-[80] flex items-center justify-center bg-[#050505]/80 backdrop-blur-sm">
                                <div className="w-full max-w-md rounded-3xl border border-white/10 bg-[#101010] p-6 shadow-2xl">
                                    <div className="flex items-start justify-between gap-3">
                                        <div>
                                            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-amber-400">Reconnect required</p>
                                            <h3 className="mt-2 text-2xl font-bold text-white">{authReconnect.toolName}</h3>
                                        </div>
                                        <button onClick={() => setAuthReconnect(null)} className="rounded-full p-1.5 text-white/50 hover:bg-white/5 hover:text-white">
                                            <X className="w-4 h-4" />
                                        </button>
                                    </div>

                                    <p className="mt-4 text-sm leading-relaxed text-white/70">
                                        {authReconnect.message || 'This tool disconnected while the workflow was running.'}
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
                                <div className="glass-panel rounded-3xl shadow-2xl border-white/10 overflow-hidden" style={{ maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
                                    <div className="px-6 py-5 border-b border-white/10 flex items-center justify-between shrink-0">
                                        <h3 className="font-bold text-sm">Node Settings</h3>
                                        <button onClick={() => setSelectedNodeId(null)} className="p-1.5 hover:bg-white/5 rounded-full"><X className="w-4 h-4" /></button>
                                    </div>
                                    <div className="p-6 space-y-5 overflow-y-auto flex-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.1) transparent' }}>
                                        <div>
                                            <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 block">Node Label</label>
                                            <input type="text" value={selectedNode.data.label} onChange={(e) => setNodes(nds => nds.map(n => n.id === selectedNodeId ? { ...n, data: { ...n.data, label: e.target.value } } : n))} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-bolt-accent/30" />
                                        </div>
                                        <div>
                                            <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 block">Instructions</label>
                                            <textarea value={selectedNode.data.description || ''} onChange={(e) => setNodes(nds => nds.map(n => n.id === selectedNodeId ? { ...n, data: { ...n.data, description: e.target.value } } : n))} className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-xs min-h-[100px] outline-none focus:border-bolt-accent/30 resize-none" />
                                        </div>

                                        {/* Initial State Editor (Workflow Inputs) */}
                                        {selectedNode.id === 'root' && (
                                            <div className="pt-3 border-t border-white/5">
                                                <div className="flex justify-between items-center mb-2">
                                                    <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest block">Workflow Inputs</label>
                                                    <button
                                                        onClick={() => {
                                                            const key = prompt('Enter new input name (e.g., custom_id):');
                                                            if (key) {
                                                                setNodes(nds => nds.map(n => n.id === 'root' ? {
                                                                    ...n, data: { ...n.data, initialState: { ...(n.data.initialState || {}), [key]: '' } }
                                                                } : n));
                                                            }
                                                        }}
                                                        className="p-1 hover:bg-white/10 rounded text-white/40 hover:text-white transition-colors"
                                                        title="Add Input"
                                                    >
                                                        <Plus className="w-3 h-3" />
                                                    </button>
                                                </div>

                                                {availableWorkflowKeys.length === 0 ? (
                                                    <p className="text-[10px] text-white/30 italic">No inputs detected. Add tools or custom inputs.</p>
                                                ) : (
                                                    <div className="space-y-3">
                                                        {availableWorkflowKeys.map(key => {
                                                            const rawValue = selectedNode.data.initialState?.[key];
                                                            const value = (rawValue === null || rawValue === undefined) ? '' : String(rawValue);
                                                            const isInState = selectedNode.data.initialState ? (key in selectedNode.data.initialState) : false;
                                                            return (
                                                                <div key={key}>
                                                                    <div className="flex items-center justify-between mb-1">
                                                                        <label className="text-[9px] text-white/50 font-mono flex items-center gap-1.5">
                                                                            {key}
                                                                            {!isInState && (
                                                                                <span className="text-[8px] text-bolt-accent/50 font-sans">(from tool)</span>
                                                                            )}
                                                                        </label>
                                                                        <button
                                                                            onClick={() => {
                                                                                setNodes(nds => nds.map(n => {
                                                                                    if (n.id === 'root' && n.data.initialState) {
                                                                                        const { [key]: _, ...rest } = n.data.initialState;
                                                                                        return { ...n, data: { ...n.data, initialState: rest } };
                                                                                    }
                                                                                    return n;
                                                                                }));
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
                                                                        placeholder={isInState ? "(empty)" : "Click to set value…"}
                                                                        onChange={(e) => {
                                                                            const newVal = e.target.value;
                                                                            setNodes(nds => nds.map(n => {
                                                                                if (n.id === 'root') {
                                                                                    return {
                                                                                        ...n,
                                                                                        data: {
                                                                                            ...n.data,
                                                                                            initialState: {
                                                                                                ...(n.data.initialState || {}),
                                                                                                [key]: newVal
                                                                                            }
                                                                                        }
                                                                                    };
                                                                                }
                                                                                return n;
                                                                            }));
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
                                        {selectedNode.data.toolId === 'gmail' && selectedNode.data.toolAction === 'send_email' && (
                                            <div className="pt-3 border-t border-white/5">
                                                <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest mb-2 block">Email Recipient</label>
                                                <input
                                                    type="email"
                                                    value={selectedNode.data.configuredRecipient || ''}
                                                    onChange={(e) => setNodes(nds => nds.map(n => n.id === selectedNodeId ? { ...n, data: { ...n.data, configuredRecipient: e.target.value } } : n))}
                                                    placeholder="recipient@example.com (optional)"
                                                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm outline-none focus:border-bolt-accent/30 placeholder:text-white/20"
                                                />
                                                <p className="text-[9px] text-white/30 mt-2">Overrides state keys if set. Leave empty to use state.</p>
                                            </div>
                                        )}
                                        {selectedNode.data.stateContract && (
                                            <div className="pt-3 border-t border-white/5 space-y-3">
                                                <label className="text-[10px] font-bold text-white/30 uppercase tracking-widest block">State Contract</label>
                                                <div className="space-y-2">
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[9px] text-blue-400 font-bold w-14">Reads:</span>
                                                        <span className="text-[9px] text-white/50">{selectedNode.data.stateContract.inputKeys?.join(', ') || 'none'}</span>
                                                    </div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="text-[9px] text-emerald-400 font-bold w-14">Writes:</span>
                                                        <span className="text-[9px] text-white/50">{selectedNode.data.stateContract.outputKeys?.join(', ') || 'none'}</span>
                                                    </div>
                                                    {selectedNode.data.stateContract.reducer && (
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-[9px] text-amber-400 font-bold w-14">Reducer:</span>
                                                            <span className="text-[9px] text-white/50">{selectedNode.data.stateContract.reducer}</span>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}
                                        {selectedNode.data.output && (
                                            <div className="pt-4 border-t border-white/5">
                                                <label className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest mb-2 block">Last Output</label>
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
                            <h3 className="text-sm font-semibold text-white">{activeTask?.name || 'Task session'}</h3>
                        </div>
                        <button onClick={() => setShowChatPanel(false)} className="p-1.5 hover:bg-white/5 rounded-full text-white/40 hover:text-white">
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex-1 overflow-y-auto px-3 py-3">
                        <div className="space-y-4">
                            {chatMessages.map((message, index) => (
                                <div key={`${activeTaskId}-${message.role}-${index}`} className={`flex gap-2 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    {message.role === 'assistant' && (
                                        <div className="mt-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[9px] font-bold text-white/70">
                                            AI
                                        </div>
                                    )}
                                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-[11px] leading-5 ${message.role === 'user' ? 'bg-bolt-accent text-black font-medium' : 'bg-white/[0.04] text-white/80 border border-white/5'}`}>
                                        {message.text}
                                    </div>
                                    {message.role === 'user' && (
                                        <div className="mt-1 flex h-6 w-6 items-center justify-center rounded-full border border-white/10 bg-white/5 text-[9px] font-bold text-white/70">
                                            U
                                        </div>
                                    )}
                                </div>
                            ))}

                            {isGenerating && (
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
                        </div>
                    </div>

                    <div className="border-t border-white/10 p-3">
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
                            <div className="text-[9px] text-white/35 uppercase tracking-[0.2em]">Prompt edit</div>
                            <button onClick={handleWorkflowChatSubmit} className="px-3 py-2 rounded-xl bg-bolt-accent text-black text-[10px] font-bold uppercase tracking-[0.18em] hover:bg-bolt-accent/90">
                                Send
                            </button>
                        </div>
                    </div>
                </aside>
            )}
        </div>
    );
}
