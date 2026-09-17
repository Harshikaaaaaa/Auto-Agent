import { useCallback, useEffect, useRef, useState } from 'react';
import { Node, Edge } from 'reactflow';

interface HistoryEntry {
    nodes: Node[];
    edges: Edge[];
}

const MAX_HISTORY = 50;

/**
 * Undo/redo for the workflow canvas.
 *
 * The bug this fixes: the previous version exposed a `takeSnapshot` that the
 * canvas never called, so `history` stayed empty and `canUndo` (index > 0) was
 * always false — the buttons did nothing. Rather than thread a snapshot call
 * through every one of the canvas's ~dozen mutation sites, the hook now OBSERVES
 * nodes and edges and records a snapshot whenever they change, which is exactly
 * the set of "meaningful changes" the buttons should step through.
 *
 * A change caused BY an undo or redo must not itself be recorded — that would
 * make undo un-undoable. The `isReplaying` ref suppresses the snapshot for the
 * one render an undo/redo triggers.
 */
export function useUndoRedo(
    nodes: Node[],
    edges: Edge[],
    setNodes: (nodes: Node[] | ((prev: Node[]) => Node[])) => void,
    setEdges: (edges: Edge[] | ((prev: Edge[]) => Edge[])) => void
) {
    const [history, setHistory] = useState<HistoryEntry[]>([{ nodes: [], edges: [] }]);
    const [historyIndex, setHistoryIndex] = useState(0);
    /**
     * The live index, mirrored in a ref. The observing effect trims the redo
     * future against the CURRENT position; reading `historyIndex` from the effect
     * closure lagged one render behind an undo, so a new edit made right after an
     * undo failed to discard the redo branch.
     */
    const indexRef = useRef(0);
    const isReplaying = useRef(false);
    /**
     * Cheap change detector so an unrelated re-render does not push a snapshot.
     * Seeded null and initialised to the FIRST observed graph, so mounting with
     * an already-populated graph (e.g. loading a saved workflow) does not record
     * a spurious "empty → loaded" step the user can undo into nothing.
     */
    const lastKey = useRef<string | null>(null);

    useEffect(() => {
        // A fingerprint of the graph's structure and data. Position-only drags
        // are included because a user expects to be able to undo a move; ReactFlow
        // batches drag updates, so this does not record every pixel.
        const key = JSON.stringify({
            n: nodes.map((node) => ({ id: node.id, type: node.type, data: node.data, position: node.position })),
            e: edges.map((edge) => ({ id: edge.id, s: edge.source, t: edge.target, c: (edge as { condition?: string }).condition }))
        });

        // First run establishes the baseline. Replace the seeded empty entry with
        // whatever the graph actually is on mount (it may already be populated
        // from a loaded workflow), so the first real edit has something to undo
        // back to and undo never lands on a phantom empty state.
        if (lastKey.current === null) {
            lastKey.current = key;
            setHistory([{ nodes: structuredClone(nodes), edges: structuredClone(edges) }]);
            return;
        }

        // A replay (undo/redo) is recognised and consumed FIRST, before the
        // no-change short-circuit. Otherwise, when the replayed graph happened to
        // match `lastKey`, the flag would never clear and the next real edit would
        // be wrongly skipped as "still replaying".
        if (isReplaying.current) {
            isReplaying.current = false;
            lastKey.current = key;
            return;
        }

        if (key === lastKey.current) return;
        lastKey.current = key;

        setHistory((prev) => {
            const trimmed = prev.slice(0, indexRef.current + 1);
            const next = [...trimmed, { nodes: structuredClone(nodes), edges: structuredClone(edges) }];
            if (next.length > MAX_HISTORY) next.shift();
            indexRef.current = next.length - 1;
            return next;
        });
        setHistoryIndex(() => indexRef.current);
    }, [nodes, edges]);

    const canUndo = historyIndex > 0;
    const canRedo = historyIndex < history.length - 1;

    const restore = useCallback(
        (entry: HistoryEntry) => {
            isReplaying.current = true;
            // Pre-set the fingerprint so the observing effect recognises this as
            // the replay and does not record it.
            lastKey.current = JSON.stringify({
                n: entry.nodes.map((node) => ({ id: node.id, type: node.type, data: node.data, position: node.position })),
                e: entry.edges.map((edge) => ({ id: edge.id, s: edge.source, t: edge.target, c: (edge as { condition?: string }).condition }))
            });
            setNodes(structuredClone(entry.nodes));
            setEdges(structuredClone(entry.edges));
        },
        [setNodes, setEdges]
    );

    const undo = useCallback(() => {
        if (!canUndo) return;
        indexRef.current = historyIndex - 1;
        restore(history[indexRef.current]);
        setHistoryIndex(indexRef.current);
    }, [canUndo, history, historyIndex, restore]);

    const redo = useCallback(() => {
        if (!canRedo) return;
        indexRef.current = historyIndex + 1;
        restore(history[indexRef.current]);
        setHistoryIndex(indexRef.current);
    }, [canRedo, history, historyIndex, restore]);

    return { undo, redo, canUndo, canRedo };
}
