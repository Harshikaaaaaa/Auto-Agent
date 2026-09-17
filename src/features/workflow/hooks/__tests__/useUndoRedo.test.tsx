import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { Edge, Node } from 'reactflow';
import { useUndoRedo } from '../useUndoRedo';

/**
 * useUndoRedo used to expose a takeSnapshot that WorkflowCanvas never called, so
 * history stayed empty and canUndo was always false — the buttons did nothing.
 * The hook now observes nodes/edges itself. These tests drive it through a tiny
 * host component that owns the node/edge state, the way the canvas does.
 */

function node(id: string): Node {
    return { id, type: 'tool', position: { x: 0, y: 0 }, data: { label: id } };
}

/** Host that wires real setNodes/setEdges into the hook, like the canvas. */
function useHarness() {
    const [nodes, setNodes] = useState<Node[]>([]);
    const [edges, setEdges] = useState<Edge[]>([]);
    const history = useUndoRedo(nodes, edges, setNodes, setEdges);
    return { nodes, edges, setNodes, setEdges, ...history };
}

describe('useUndoRedo', () => {
    it('starts with nothing to undo or redo', () => {
        const { result } = renderHook(useHarness);
        expect(result.current.canUndo).toBe(false);
        expect(result.current.canRedo).toBe(false);
    });

    it('enables undo once a change is made', () => {
        const { result } = renderHook(useHarness);

        act(() => result.current.setNodes([node('a')]));

        // The observing effect must have recorded the change — this is the exact
        // property that was broken (canUndo stuck false).
        expect(result.current.canUndo).toBe(true);
    });

    it('undoes a node addition', () => {
        const { result } = renderHook(useHarness);

        act(() => result.current.setNodes([node('a')]));
        act(() => result.current.setNodes([node('a'), node('b')]));
        expect(result.current.nodes).toHaveLength(2);

        act(() => result.current.undo());
        expect(result.current.nodes.map((n) => n.id)).toEqual(['a']);
    });

    it('redoes what was undone', () => {
        const { result } = renderHook(useHarness);

        act(() => result.current.setNodes([node('a')]));
        act(() => result.current.setNodes([node('a'), node('b')]));
        act(() => result.current.undo());
        expect(result.current.nodes).toHaveLength(1);

        act(() => result.current.redo());
        expect(result.current.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    });

    it('does not record the undo itself as a new change', () => {
        const { result } = renderHook(useHarness);

        act(() => result.current.setNodes([node('a')]));
        act(() => result.current.setNodes([node('a'), node('b')]));
        act(() => result.current.undo()); // back to [a]
        act(() => result.current.undo()); // back to []

        expect(result.current.nodes).toEqual([]);
        expect(result.current.canUndo).toBe(false);
    });

    it('discards the redo future when a new change is made after an undo', () => {
        const { result } = renderHook(useHarness);

        act(() => result.current.setNodes([node('a')]));
        act(() => result.current.setNodes([node('a'), node('b')]));
        act(() => result.current.undo()); // back to [a], redo available
        expect(result.current.canRedo).toBe(true);

        act(() => result.current.setNodes([node('a'), node('c')])); // new branch
        expect(result.current.canRedo).toBe(false);

        act(() => result.current.undo());
        expect(result.current.nodes.map((n) => n.id)).toEqual(['a']);
    });

    it('tracks edges too', () => {
        const { result } = renderHook(useHarness);

        act(() => result.current.setNodes([node('a'), node('b')]));
        act(() =>
            result.current.setEdges([{ id: 'e1', source: 'a', target: 'b' } as Edge])
        );
        expect(result.current.edges).toHaveLength(1);

        act(() => result.current.undo());
        expect(result.current.edges).toHaveLength(0);
    });
});
