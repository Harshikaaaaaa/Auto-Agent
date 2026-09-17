import { useState, useCallback, useRef } from 'react';
import { Node, Edge } from 'reactflow';

interface HistoryEntry {
    nodes: Node[];
    edges: Edge[];
}

const MAX_HISTORY = 50;

/**
 * Provides undo/redo capability for the workflow canvas.
 * Records snapshots of nodes & edges after each meaningful change.
 */
export function useUndoRedo(
    nodes: Node[],
    edges: Edge[],
    setNodes: (nodes: Node[] | ((prev: Node[]) => Node[])) => void,
    setEdges: (edges: Edge[] | ((prev: Edge[]) => Edge[])) => void
) {
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [historyIndex, setHistoryIndex] = useState(-1);
    const isUndoRedoAction = useRef(false);

    /** Record the current state as a snapshot */
    const takeSnapshot = useCallback(() => {
        if (isUndoRedoAction.current) {
            isUndoRedoAction.current = false;
            return;
        }

        setHistory(prev => {
            // Discard any "future" entries when a new action happens
            const trimmed = prev.slice(0, historyIndex + 1);
            const next = [...trimmed, { nodes: structuredClone(nodes), edges: structuredClone(edges) }];
            if (next.length > MAX_HISTORY) next.shift();
            return next;
        });
        setHistoryIndex(prev => Math.min(prev + 1, MAX_HISTORY - 1));
    }, [nodes, edges, historyIndex]);

    const canUndo = historyIndex > 0;
    const canRedo = historyIndex < history.length - 1;

    const undo = useCallback(() => {
        if (!canUndo) return;
        isUndoRedoAction.current = true;
        const prev = history[historyIndex - 1];
        setNodes(prev.nodes);
        setEdges(prev.edges);
        setHistoryIndex(i => i - 1);
    }, [canUndo, history, historyIndex, setNodes, setEdges]);

    const redo = useCallback(() => {
        if (!canRedo) return;
        isUndoRedoAction.current = true;
        const next = history[historyIndex + 1];
        setNodes(next.nodes);
        setEdges(next.edges);
        setHistoryIndex(i => i + 1);
    }, [canRedo, history, historyIndex, setNodes, setEdges]);

    return { undo, redo, canUndo, canRedo, takeSnapshot };
}
