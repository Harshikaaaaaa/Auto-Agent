import React, { useState, useMemo } from 'react';
import { Node, Edge } from 'reactflow';
import {
    X,
    Copy,
    Check,
    Terminal,
    Search,
    Code2,
    CheckCircle2,
    Archive,
    Loader2
} from 'lucide-react';
import {
    EXPORT_APPROACHES,
    exportWorkflowCode,
    WorkflowExportContext
} from '../services/workflowCodeExporter';
import { downloadFrameworkZip } from '../services/zipExporter';

interface ExportModalProps {
    isVisible: boolean;
    onClose: () => void;
    nodes: Node[];
    edges: Edge[];
    workflowName?: string;
    prompt?: string;
    initialState?: Record<string, any>;
}

export const ExportModal: React.FC<ExportModalProps> = ({
    isVisible,
    onClose,
    nodes,
    edges,
    workflowName,
    prompt,
    initialState
}) => {
    const [selectedApproachId, setSelectedApproachId] = useState<string>('langgraph');
    const [searchQuery, setSearchQuery] = useState<string>('');
    const [copiedCode, setCopiedCode] = useState<boolean>(false);
    const [copiedPip, setCopiedPip] = useState<boolean>(false);
    const [isDownloading, setIsDownloading] = useState<boolean>(false);
    const [isDownloadingAll, setIsDownloadingAll] = useState<boolean>(false);

    const exportContext: WorkflowExportContext = useMemo(() => ({
        title: workflowName || 'My Agent Workflow',
        prompt: prompt || '',
        nodes,
        edges,
        initialState
    }), [workflowName, prompt, nodes, edges, initialState]);

    const filteredApproaches = useMemo(() => {
        const q = searchQuery.toLowerCase().trim();
        if (!q) return EXPORT_APPROACHES;
        return EXPORT_APPROACHES.filter(
            a =>
                a.name.toLowerCase().includes(q) ||
                a.example.toLowerCase().includes(q) ||
                a.bestFor.toLowerCase().includes(q) ||
                a.description.toLowerCase().includes(q)
        );
    }, [searchQuery]);

    const currentExport = useMemo(() => {
        return exportWorkflowCode(selectedApproachId, exportContext);
    }, [selectedApproachId, exportContext]);

    const handleCopyCode = async () => {
        try {
            await navigator.clipboard.writeText(currentExport.code);
            setCopiedCode(true);
            setTimeout(() => setCopiedCode(false), 2000);
        } catch (err) {
            console.error('Failed to copy code:', err);
        }
    };

    const handleCopyPip = async (pipCommand: string) => {
        try {
            await navigator.clipboard.writeText(pipCommand);
            setCopiedPip(true);
            setTimeout(() => setCopiedPip(false), 2000);
        } catch (err) {
            console.error('Failed to copy pip command:', err);
        }
    };

    const handleDownloadSingle = async () => {
        if (isDownloading) return;
        setIsDownloading(true);
        try {
            const safeTitle = (exportContext.title || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '_');
            const zipFilename = `${safeTitle}_${selectedApproachId}.zip`;
            await downloadFrameworkZip(selectedApproachId, exportContext, currentExport.code, zipFilename);
        } catch (err) {
            console.error('Failed to generate ZIP:', err);
        } finally {
            setIsDownloading(false);
        }
    };

    const handleDownloadAll = async () => {
        if (isDownloadingAll) return;
        setIsDownloadingAll(true);
        try {
            for (let i = 0; i < EXPORT_APPROACHES.length; i++) {
                const approach = EXPORT_APPROACHES[i];
                const single = exportWorkflowCode(approach.id, exportContext);
                const safeTitle = (exportContext.title || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '_');
                const zipFilename = `${safeTitle}_${approach.id}.zip`;
                await downloadFrameworkZip(approach.id, exportContext, single.code, zipFilename);
                // Small delay to avoid browser blocking multiple downloads
                if (i < EXPORT_APPROACHES.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 300));
                }
            }
        } catch (err) {
            console.error('Failed to generate ZIPs:', err);
        } finally {
            setIsDownloadingAll(false);
        }
    };

    if (!isVisible) return null;

    const codeLines = currentExport.code.split('\n');

    return (
        <div
            className="fixed inset-0 z-[150] flex items-center justify-center p-4 md:p-8 bg-black/80 backdrop-blur-md animate-fade-in"
            onClick={onClose}
        >
            <div
                className="relative w-full max-w-6xl h-[88vh] bg-[#0c0c0c] border border-white/10 rounded-3xl shadow-2xl flex flex-col overflow-hidden text-white"
                onClick={e => e.stopPropagation()}
            >
                {/* Modal Header */}
                <div className="px-6 py-4 border-b border-white/10 flex items-center justify-between shrink-0 bg-[#0a0a0a]">
                    <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-bolt-accent/15 border border-bolt-accent/30 flex items-center justify-center text-bolt-accent">
                            <Code2 className="w-5 h-5" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h2 className="text-base font-bold text-white">Export Workflow Code</h2>
                                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-white/5 border border-white/10 text-white/70">
                                    {nodes.length} nodes · 10 frameworks
                                </span>
                            </div>
                            <p className="text-xs text-white/45 mt-0.5">
                                Export directly into production-ready code across 10 agent architectures
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleDownloadAll}
                            disabled={isDownloadingAll}
                            className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/10 bg-white/5 text-xs font-semibold text-white/80 hover:bg-white/10 hover:text-white transition-all disabled:opacity-50 disabled:cursor-wait"
                            title="Download all 10 framework ZIP archives"
                        >
                            {isDownloadingAll ? (
                                <>
                                    <Loader2 className="w-3.5 h-3.5 text-bolt-accent animate-spin" />
                                    Generating ZIPs...
                                </>
                            ) : (
                                <>
                                    <Archive className="w-3.5 h-3.5 text-bolt-accent" />
                                    Export All 10 (.zip)
                                </>
                            )}
                        </button>
                        <button
                            onClick={onClose}
                            className="p-2 rounded-xl text-white/40 hover:text-white hover:bg-white/5 transition-colors"
                        >
                            <X className="w-5 h-5" />
                        </button>
                    </div>
                </div>

                {/* Modal Body: Split Layout */}
                <div className="flex-1 flex min-h-0 overflow-hidden">
                    {/* Left Sidebar: 10 Approaches List */}
                    <div className="w-80 border-r border-white/10 bg-[#080808] flex flex-col shrink-0">
                        <div className="p-3 border-b border-white/10">
                            <div className="relative">
                                <Search className="w-3.5 h-3.5 text-white/40 absolute left-3 top-2.5" />
                                <input
                                    type="text"
                                    placeholder="Filter approaches..."
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-xl pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-white/30 outline-none focus:border-bolt-accent/50"
                                />
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
                            {filteredApproaches.map((approach) => {
                                const isSelected = approach.id === selectedApproachId;
                                return (
                                    <button
                                        key={approach.id}
                                        onClick={() => setSelectedApproachId(approach.id)}
                                        className={`w-full text-left p-3 rounded-2xl border transition-all ${
                                            isSelected
                                                ? 'bg-bolt-accent/10 border-bolt-accent/40 shadow-lg shadow-black/40'
                                                : 'bg-white/[0.02] border-white/5 hover:bg-white/[0.05] hover:border-white/10'
                                        }`}
                                    >
                                        <div className="flex items-start justify-between gap-2">
                                            <span className={`text-xs font-bold ${isSelected ? 'text-bolt-accent' : 'text-white'}`}>
                                                {approach.name}
                                            </span>
                                            {isSelected && (
                                                <CheckCircle2 className="w-3.5 h-3.5 text-bolt-accent shrink-0 mt-0.5" />
                                            )}
                                        </div>
                                        <div className="text-[11px] text-white/50 mt-1 line-clamp-1">
                                            {approach.example}
                                        </div>
                                        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
                                            <span className="text-[9px] font-semibold px-2 py-0.5 rounded-md bg-white/5 border border-white/10 text-white/70">
                                                Best for: {approach.bestFor}
                                            </span>
                                        </div>
                                    </button>
                                );
                            })}
                        </div>

                        <div className="p-3 border-t border-white/10 bg-[#060606] text-[10px] text-white/40 text-center">
                            AutoAgent Code Generator v1.0
                        </div>
                    </div>

                    {/* Right Panel: Code Preview & Controls */}
                    <div className="flex-1 flex flex-col min-w-0 bg-[#0c0c0c] overflow-hidden">
                        {/* Approach Details Bar */}
                        <div className="p-5 border-b border-white/10 bg-[#0d0d0d] flex flex-col gap-3 shrink-0">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <div className="flex items-center gap-2">
                                        <h3 className="text-base font-bold text-white">
                                            {currentExport.approach.name}
                                        </h3>
                                        <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                                            {currentExport.approach.example}
                                        </span>
                                    </div>
                                    <p className="text-xs text-white/60 mt-1">
                                        {currentExport.approach.description}
                                    </p>
                                </div>

                                {/* Code Actions */}
                                <div className="flex items-center gap-2 shrink-0">
                                    <button
                                        onClick={handleCopyCode}
                                        className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-xs font-semibold text-white hover:bg-white/10 transition-all"
                                    >
                                        {copiedCode ? (
                                            <>
                                                <Check className="w-3.5 h-3.5 text-emerald-400" />
                                                <span className="text-emerald-400">Copied!</span>
                                            </>
                                        ) : (
                                            <>
                                                <Copy className="w-3.5 h-3.5" />
                                                <span>Copy Code</span>
                                            </>
                                        )}
                                    </button>
                                    <button
                                        onClick={handleDownloadSingle}
                                        disabled={isDownloading}
                                        className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-bolt-accent text-black text-xs font-bold hover:bg-bolt-accent/90 transition-all shadow-lg shadow-bolt-accent/10 disabled:opacity-60 disabled:cursor-wait"
                                    >
                                        {isDownloading ? (
                                            <>
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                <span>Generating ZIP...</span>
                                            </>
                                        ) : (
                                            <>
                                                <Archive className="w-3.5 h-3.5" />
                                                <span>Download .zip</span>
                                            </>
                                        )}
                                    </button>
                                </div>
                            </div>

                            {/* Pip Install & Env Requirements Bar */}
                            <div className="flex items-center justify-between gap-3 p-2.5 rounded-xl border border-white/5 bg-black/40 text-xs">
                                <div className="flex items-center gap-2 overflow-x-auto min-w-0">
                                    <Terminal className="w-3.5 h-3.5 text-bolt-accent shrink-0" />
                                    <span className="text-[10px] font-mono text-white/70 truncate">
                                        {currentExport.approach.pipInstall}
                                    </span>
                                </div>
                                {currentExport.approach.pipInstall.startsWith('pip') && (
                                    <button
                                        onClick={() => handleCopyPip(currentExport.approach.pipInstall)}
                                        className="shrink-0 px-2 py-1 rounded-lg border border-white/10 bg-white/5 hover:bg-white/10 text-[10px] text-white/80 transition-colors flex items-center gap-1"
                                    >
                                        {copiedPip ? (
                                            <>
                                                <Check className="w-3 h-3 text-emerald-400" />
                                                <span>Copied</span>
                                            </>
                                        ) : (
                                            <>
                                                <Copy className="w-3 h-3" />
                                                <span>Copy pip</span>
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Code Viewer */}
                        <div className="flex-1 min-h-0 bg-[#050505] p-4 overflow-y-auto overflow-x-auto font-mono text-[11px] leading-relaxed select-text">
                            <div className="flex">
                                {/* Line Numbers */}
                                <div className="pr-4 select-none text-white/20 text-right shrink-0 border-r border-white/5">
                                    {codeLines.map((_, i) => (
                                        <div key={i}>{i + 1}</div>
                                    ))}
                                </div>

                                {/* Code Body */}
                                <pre className="pl-4 text-white/90 whitespace-pre overflow-x-visible flex-1">
                                    <code>{currentExport.code}</code>
                                </pre>
                            </div>
                        </div>

                        {/* Footer Bar */}
                        <div className="px-6 py-3 border-t border-white/10 bg-[#0a0a0a] flex items-center justify-between text-xs text-white/40 shrink-0">
                            <div>
                                Target: <span className="text-white/80 font-medium">Python 3.10+</span> · Export: <span className="text-bolt-accent font-medium">ZIP Archive</span>
                            </div>
                            <div className="flex items-center gap-4">
                                <span>{codeLines.length} lines of code</span>
                                <span className="flex items-center gap-1"><Archive className="w-3 h-3" /> + README + requirements.txt</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
