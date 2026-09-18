import { useCallback, useEffect, useRef, useState } from 'react';
import { Node, Edge } from 'reactflow';

/**
 * A labeled snapshot of the whole graph, taken when a chat patch changes it.
 */
export interface WorkflowVersion {
  /** Stable id for React keys and lookups. */
  id: string;
  /** Short human label, e.g. "v3". */
  label: string;
  /** What the patch that produced this version did, for the version list. */
  summary: string;
  /** When it was captured. */
  at: string;
  nodes: Node[];
  edges: Edge[];
}

const MAX_VERSIONS = 50;
const STORAGE_PREFIX = 'autoagent_workflow_versions:';

interface PersistedVersions {
  versions: WorkflowVersion[];
  currentIndex: number;
  counter: number;
}

/** Read persisted versions for a key, or null when none / unavailable. */
function loadPersisted(key: string | undefined): PersistedVersions | null {
  if (!key || typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedVersions;
    if (!Array.isArray(parsed.versions)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Version history for the workflow, distinct from undo/redo.
 *
 * `useUndoRedo` observes EVERY node/edge change — including a drag — and exposes
 * no way to label an entry or jump to one. Versions are different: they are the
 * named checkpoints a chat patch produces ("v3 — set render_mode = always"), and
 * the user wants to step between them explicitly and see them tagged in chat.
 * So this is a separate, explicit store: the canvas calls `snapshot()` inside
 * the one place a patch mutates the graph, and `restore()` puts a chosen version
 * back on the canvas.
 *
 * The store holds a linear list with a current index. Snapshotting after having
 * stepped back trims the forward entries, exactly like undo/redo, so history
 * never branches confusingly.
 *
 * Versions PERSIST to localStorage, keyed by `storageKey` (the active task), so
 * they survive a page refresh — the earlier in-memory-only store lost every
 * version on reload, which made the Versions control look permanently empty.
 */
export function useWorkflowVersions(storageKey?: string) {
  const [versions, setVersions] = useState<WorkflowVersion[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  /** Monotonic counter so version labels (v1, v2, …) never repeat or reuse. */
  const counter = useRef(0);
  /**
   * The live current index mirrored in a ref, so `snapshot` (which reads it to
   * trim forward history) is never a render behind after a `goTo`.
   */
  const currentIndexRef = useRef(-1);
  /** The key whose versions are currently loaded, to guard the save effect. */
  const loadedKeyRef = useRef<string | undefined>(undefined);

  // Load persisted versions when the key (task) changes, so switching tasks or
  // reloading the page restores that task's version history.
  useEffect(() => {
    loadedKeyRef.current = storageKey;
    const persisted = loadPersisted(storageKey);
    if (persisted) {
      setVersions(persisted.versions);
      setCurrentIndex(persisted.currentIndex);
      currentIndexRef.current = persisted.currentIndex;
      counter.current = persisted.counter ?? persisted.versions.length;
    } else {
      setVersions([]);
      setCurrentIndex(-1);
      currentIndexRef.current = -1;
      counter.current = 0;
    }
  }, [storageKey]);

  // Persist on every change, so a version is durable the moment it is taken.
  useEffect(() => {
    if (!storageKey || typeof localStorage === 'undefined') return;
    // Do not clobber a key's storage during the render before its load runs.
    if (loadedKeyRef.current !== storageKey) return;
    // NEVER delete on empty. On reload the key changes null -> taskId and this
    // effect can fire while `versions` is still the pre-load empty array, before
    // the load effect populates it. Deleting here would wipe the stored history
    // — the exact "versions gone after refresh" bug. Only ever WRITE, and only
    // when there is something to write; clearing is an explicit action.
    if (versions.length === 0) return;
    try {
      localStorage.setItem(
        STORAGE_PREFIX + storageKey,
        JSON.stringify({ versions, currentIndex, counter: counter.current }),
      );
    } catch {
      // Storage full or unavailable (private mode): versions stay in memory.
    }
  }, [versions, currentIndex, storageKey]);

  /**
   * Capture the current graph as a new version and make it current. Returns the
   * created version so the caller can, e.g., post its label to the chat.
   */
  const snapshot = useCallback((nodes: Node[], edges: Edge[], summary: string): WorkflowVersion => {
    counter.current += 1;
    const version: WorkflowVersion = {
      id: `ver_${Date.now()}_${counter.current}`,
      label: `v${counter.current}`,
      summary: summary || 'workflow change',
      at: new Date().toISOString(),
      nodes: structuredClone(nodes),
      edges: structuredClone(edges),
    };

    setVersions((prev) => {
      // Trim any forward history, then append and cap.
      const trimmedBase = currentIndexRef.current >= 0 ? currentIndexRef.current + 1 : prev.length;
      const trimmed = prev.slice(0, trimmedBase);
      const next = [...trimmed, version];
      if (next.length > MAX_VERSIONS) next.shift();
      currentIndexRef.current = next.length - 1;
      return next;
    });
    setCurrentIndex(() => currentIndexRef.current);
    return version;
  }, []);

  const goTo = useCallback(
    (index: number, apply: (nodes: Node[], edges: Edge[]) => void): WorkflowVersion | undefined => {
      let target: WorkflowVersion | undefined;
      setVersions((prev) => {
        if (index < 0 || index >= prev.length) return prev;
        target = prev[index];
        currentIndexRef.current = index;
        setCurrentIndex(index);
        // Restore clones so the live canvas can mutate without corrupting the
        // stored version.
        apply(structuredClone(target.nodes), structuredClone(target.edges));
        return prev;
      });
      return target;
    },
    [],
  );

  return {
    versions,
    currentIndex,
    /** True when there is a version before / after the current one. */
    canGoBack: currentIndex > 0,
    canGoForward: currentIndex >= 0 && currentIndex < versions.length - 1,
    snapshot,
    goTo,
  };
}
