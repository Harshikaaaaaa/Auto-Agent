import { act, renderHook } from '@testing-library/react';
import type { Edge, Node } from 'reactflow';
import { useWorkflowVersions } from '../useWorkflowVersions';

/**
 * The version store is explicit, not observed: the canvas calls snapshot() when
 * a chat patch changes the graph, and goTo() to restore a chosen version. These
 * tests drive those calls directly.
 */

function node(id: string): Node {
  return { id, type: 'tool', position: { x: 0, y: 0 }, data: { label: id } };
}
const EDGES: Edge[] = [];

describe('useWorkflowVersions', () => {
  it('starts empty with nothing to switch to', () => {
    const { result } = renderHook(() => useWorkflowVersions());
    expect(result.current.versions).toHaveLength(0);
    expect(result.current.currentIndex).toBe(-1);
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(false);
  });

  it('labels versions v1, v2, … and makes the newest current', () => {
    const { result } = renderHook(() => useWorkflowVersions());

    act(() => void result.current.snapshot([node('a')], EDGES, 'first'));
    act(() => void result.current.snapshot([node('a'), node('b')], EDGES, 'second'));

    expect(result.current.versions.map((v) => v.label)).toEqual(['v1', 'v2']);
    expect(result.current.versions[1].summary).toBe('second');
    expect(result.current.currentIndex).toBe(1);
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
  });

  it('restores a chosen version through the apply callback', () => {
    const { result } = renderHook(() => useWorkflowVersions());
    act(() => void result.current.snapshot([node('a')], EDGES, 'first'));
    act(() => void result.current.snapshot([node('a'), node('b')], EDGES, 'second'));

    let restoredNodes: Node[] = [];
    act(() => {
      result.current.goTo(0, (nodes) => {
        restoredNodes = nodes;
      });
    });

    // The v1 graph (single node) came back, as an independent clone.
    expect(restoredNodes.map((n) => n.id)).toEqual(['a']);
    expect(result.current.currentIndex).toBe(0);
    expect(result.current.canGoBack).toBe(false);
    expect(result.current.canGoForward).toBe(true);
  });

  it('trims forward versions when a new snapshot is taken after stepping back', () => {
    const { result } = renderHook(() => useWorkflowVersions());
    act(() => void result.current.snapshot([node('a')], EDGES, 'v1'));
    act(() => void result.current.snapshot([node('b')], EDGES, 'v2'));
    act(() => void result.current.snapshot([node('c')], EDGES, 'v3'));

    // Step back to v1, then make a new change: v2/v3 must be discarded.
    act(() => result.current.goTo(0, () => {}));
    act(() => void result.current.snapshot([node('d')], EDGES, 'v4'));

    // The new snapshot appended after v1, and the old forward branch is gone.
    expect(result.current.versions.map((v) => v.summary)).toEqual(['v1', 'v4']);
    expect(result.current.currentIndex).toBe(1);
  });

  it('keeps stored versions independent of later canvas mutations', () => {
    const { result } = renderHook(() => useWorkflowVersions());
    const live = [node('a')];
    act(() => void result.current.snapshot(live, EDGES, 'first'));

    // Mutate the array we passed in; the stored version must not change.
    live.push(node('b'));

    expect(result.current.versions[0].nodes.map((n) => n.id)).toEqual(['a']);
  });
});
