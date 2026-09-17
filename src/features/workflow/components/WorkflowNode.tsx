import React, { memo } from 'react';
import { Handle, Position } from 'reactflow';
import { NodeType } from '@/shared/types';
import { NodeData } from '@features/workflow/types';
import * as LucideIcons from 'lucide-react';

/**
 * Resolves the best Lucide icon + color for a node based on its data.
 * Priority: toolId → toolAction keyword → label keyword → node type fallback.
 */
function resolveIconAndColor(data: NodeData): {
  Icon: React.ElementType;
  color: string;
  bg: string;
  border: string;
} {
  const { type, toolId, toolAction, label } = data;
  const lbl = (label || '').toLowerCase();
  const action = (toolAction || '').toLowerCase();

  // ── Tool-specific icons ──
  if (toolId === 'gmail' || lbl.includes('email') || lbl.includes('gmail')) {
    if (action.includes('read') || action.includes('inbox'))
      return {
        Icon: LucideIcons.Inbox,
        color: 'text-red-400',
        bg: 'bg-red-500/10',
        border: 'border-red-500/20',
      };
    return {
      Icon: LucideIcons.Mail,
      color: 'text-red-400',
      bg: 'bg-red-500/10',
      border: 'border-red-500/20',
    };
  }
  if (toolId === 'google_sheets' || lbl.includes('sheet'))
    return {
      Icon: LucideIcons.Sheet,
      color: 'text-green-400',
      bg: 'bg-green-500/10',
      border: 'border-green-500/20',
    };
  if (toolId === 'google_drive' || lbl.includes('drive'))
    return {
      Icon: LucideIcons.HardDrive,
      color: 'text-yellow-400',
      bg: 'bg-yellow-500/10',
      border: 'border-yellow-500/20',
    };
  if (toolId === 'slack' || lbl.includes('slack'))
    return {
      Icon: LucideIcons.Hash,
      color: 'text-purple-400',
      bg: 'bg-purple-500/10',
      border: 'border-purple-500/20',
    };

  // ── Node type icons ──
  if (type === NodeType.TRIGGER) {
    if (lbl.includes('schedule') || lbl.includes('cron') || lbl.includes('timer'))
      return {
        Icon: LucideIcons.Clock,
        color: 'text-amber-500',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
      };
    if (lbl.includes('webhook') || lbl.includes('http'))
      return {
        Icon: LucideIcons.Radio,
        color: 'text-amber-500',
        bg: 'bg-amber-500/10',
        border: 'border-amber-500/20',
      };
    return {
      Icon: LucideIcons.Zap,
      color: 'text-amber-500',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
    };
  }
  if (type === NodeType.AI_AGENT) {
    if (lbl.includes('image') || lbl.includes('generate image'))
      return {
        Icon: LucideIcons.Wand2,
        color: 'text-violet-400',
        bg: 'bg-violet-500/10',
        border: 'border-violet-500/20',
      };
    if (lbl.includes('transcri') || lbl.includes('whisper') || lbl.includes('audio'))
      return {
        Icon: LucideIcons.Mic,
        color: 'text-violet-400',
        bg: 'bg-violet-500/10',
        border: 'border-violet-500/20',
      };
    return {
      Icon: LucideIcons.Brain,
      color: 'text-violet-400',
      bg: 'bg-white/5',
      border: 'border-white/10',
    };
  }
  if (type === NodeType.LOGIC) {
    if (lbl.includes('router') || lbl.includes('switch') || lbl.includes('route'))
      return {
        Icon: LucideIcons.Route,
        color: 'text-pink-400',
        bg: 'bg-pink-500/10',
        border: 'border-pink-500/20',
      };
    if (lbl.includes('loop') || lbl.includes('repeat') || lbl.includes('iterate'))
      return {
        Icon: LucideIcons.Repeat,
        color: 'text-pink-400',
        bg: 'bg-pink-500/10',
        border: 'border-pink-500/20',
      };
    return {
      Icon: LucideIcons.GitBranch,
      color: 'text-pink-400',
      bg: 'bg-pink-500/10',
      border: 'border-pink-500/20',
    };
  }
  if (type === NodeType.OUTPUT)
    return {
      Icon: LucideIcons.CheckCircle2,
      color: 'text-emerald-500',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/20',
    };
  if (type === NodeType.MEMORY)
    return {
      Icon: LucideIcons.Database,
      color: 'text-blue-400',
      bg: 'bg-blue-500/10',
      border: 'border-blue-500/20',
    };
  if (type === NodeType.RETRIEVAL)
    return {
      Icon: LucideIcons.Search,
      color: 'text-cyan-400',
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/20',
    };
  if (type === NodeType.VALIDATION)
    return {
      Icon: LucideIcons.ShieldCheck,
      color: 'text-orange-400',
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/20',
    };
  if (type === NodeType.APPROVAL)
    return {
      Icon: LucideIcons.CheckCheck,
      color: 'text-amber-400',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/20',
    };
  if (type === NodeType.MCP)
    return {
      Icon: LucideIcons.Cable,
      color: 'text-fuchsia-400',
      bg: 'bg-fuchsia-500/10',
      border: 'border-fuchsia-500/20',
    };
  if (type === NodeType.TOOL) {
    if (lbl.includes('filter'))
      return {
        Icon: LucideIcons.Filter,
        color: 'text-cyan-500',
        bg: 'bg-cyan-500/10',
        border: 'border-cyan-500/20',
      };
    if (lbl.includes('transform') || lbl.includes('map'))
      return {
        Icon: LucideIcons.Shuffle,
        color: 'text-cyan-500',
        bg: 'bg-cyan-500/10',
        border: 'border-cyan-500/20',
      };
    if (lbl.includes('api') || lbl.includes('request') || lbl.includes('fetch'))
      return {
        Icon: LucideIcons.Globe,
        color: 'text-cyan-500',
        bg: 'bg-cyan-500/10',
        border: 'border-cyan-500/20',
      };
    return {
      Icon: LucideIcons.Wrench,
      color: 'text-cyan-500',
      bg: 'bg-cyan-500/10',
      border: 'border-cyan-500/20',
    };
  }

  return {
    Icon: LucideIcons.Box,
    color: 'text-white/40',
    bg: 'bg-white/5',
    border: 'border-white/5',
  };
}

const NodeIcon = ({ data }: { data: NodeData }) => {
  const { Icon, color, bg, border } = resolveIconAndColor(data);
  const isAgent = data.type === NodeType.AI_AGENT;
  const size = isAgent ? 'w-12 h-12 rounded-2xl' : 'w-10 h-10 rounded-xl';
  const iconSize = isAgent ? 'w-6 h-6' : 'w-5 h-5';

  return (
    <div className={`${size} flex items-center justify-center ${bg} border ${border} shadow-lg`}>
      <Icon className={`${iconSize} ${color}`} />
    </div>
  );
};

/** Small badges showing which state keys a node reads/writes */
const StateKeyBadges = ({ stateContract }: { stateContract?: NodeData['stateContract'] }) => {
  if (!stateContract) return null;
  const { inputKeys, outputKeys } = stateContract;

  // Safely handle undefined arrays
  const inputs = inputKeys || [];
  const outputs = outputKeys || [];

  if (inputs.length === 0 && outputs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1 mt-2">
      {inputs.map((key, idx) => (
        <span
          key={`in-${idx}`}
          className="text-[8px] px-1.5 py-0.5 rounded-full font-bold bg-blue-500/15 text-blue-400 border border-blue-500/20"
        >
          ← {key}
        </span>
      ))}
      {outputs.map((key, idx) => (
        <span
          key={`out-${idx}`}
          className="text-[8px] px-1.5 py-0.5 rounded-full font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/20"
        >
          {key} →
        </span>
      ))}
    </div>
  );
};

const BaseNode = ({ data, selected }: { data: any; selected: boolean }) => {
  const { isRunning, lastSuccess, type, stateContract } = data;
  const isAgent = type === NodeType.AI_AGENT;

  // AI Agent - larger card style
  if (isAgent) {
    return (
      <div
        className={`min-w-[240px] bg-[#111] border transition-all duration-300 rounded-[20px] p-5 flex flex-col gap-3 ${selected ? 'border-white/40 shadow-[0_0_40px_rgba(255,255,255,0.1)]' : 'border-white/10 shadow-2xl'}`}
      >
        <div className="flex items-center gap-4">
          <NodeIcon data={data} />
          <div className="flex flex-col flex-1 overflow-hidden">
            <span className="font-bold text-white text-sm leading-tight truncate">
              {data.label}
            </span>
            <span className="text-[10px] font-bold text-white/30 uppercase tracking-widest mt-0.5">
              state node
            </span>
          </div>
          {isRunning && <LucideIcons.Loader2 className="w-4 h-4 text-white/40 animate-spin" />}
          {lastSuccess && !isRunning && (
            <LucideIcons.CheckCircle2 className="w-4 h-4 text-emerald-500" />
          )}
        </div>
        <StateKeyBadges stateContract={stateContract} />
        <Handle
          type="target"
          position={Position.Top}
          className="!w-3 !h-3 !bg-bolt-accent border-2 border-[#050505]"
        />
        <Handle
          type="source"
          position={Position.Bottom}
          className="!w-3 !h-3 !bg-bolt-accent border-2 border-[#050505]"
        />
      </div>
    );
  }

  // All other node types — compact card with state key badges
  return (
    <div className={`group transition-all duration-300 ${selected ? 'scale-105' : ''}`}>
      <div
        className={`min-w-[180px] bg-[#0a0a0a] border rounded-2xl p-4 transition-all ${selected ? 'border-white/30 shadow-[0_0_30px_rgba(255,255,255,0.1)]' : 'border-white/10 shadow-lg'}`}
      >
        <div className="flex items-start gap-3">
          <NodeIcon data={data} />
          <div className="flex-1 min-w-0">
            <div className="font-bold text-white text-xs leading-tight truncate">{data.label}</div>
            <div className="text-[9px] text-white/30 mt-0.5 uppercase tracking-wider font-bold">
              {type}
            </div>
          </div>
        </div>
        <StateKeyBadges stateContract={stateContract} />
        {isRunning && (
          <div className="mt-2 flex items-center gap-2">
            <LucideIcons.Loader2 className="w-3 h-3 animate-spin text-bolt-accent" />
            <span className="text-[9px] text-white/40">Processing...</span>
          </div>
        )}
        {lastSuccess && !isRunning && (
          <div className="mt-2 flex items-center gap-2">
            <LucideIcons.CheckCircle2 className="w-3 h-3 text-emerald-500" />
            <span className="text-[9px] text-emerald-500">Complete</span>
          </div>
        )}
      </div>
      <Handle
        type="target"
        position={Position.Top}
        className="!w-2.5 !h-2.5 !bg-white/20 border-2 border-[#050505]"
      />
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-2.5 !h-2.5 !bg-white/20 border-2 border-[#050505]"
      />
    </div>
  );
};

export const WorkflowNode = memo(BaseNode);
