import type { NodeData } from '@features/workflow/types';

/**
 * Per-node version history.
 *
 * Each node keeps its OWN list of versions of its configuration, so a single
 * step can be rolled back without touching the rest of the workflow. A version
 * is captured whenever a chat patch changes the node: the first patch records
 * the node's pre-patch config as v1 and the new config as v2, so there is always
 * something to switch back to.
 *
 * Versions live on the node's data under `__versions` (the index signature on
 * NodeData allows it), so they persist and round-trip with the saved workflow.
 * Transient run state (isRunning / lastSuccess / output) and `__versions` itself
 * are excluded from a snapshot: a version is CONFIG, not run state, and a
 * version must never nest older versions inside itself.
 */

export const NODE_VERSION_KEY = '__versions';

/** Fields that are run state, not configuration, and must not be versioned. */
const TRANSIENT_KEYS = new Set(['isRunning', 'lastSuccess', 'output', 'cachedOutput']);

/** One captured version of a node's configuration. */
export interface NodeVersion {
  /** Short label, e.g. "v2". */
  label: string;
  /** When it was captured. */
  at: string;
  /** The node's config at that point (no run state, no nested versions). */
  config: Partial<NodeData>;
}

/** Data with the version history attached (a convenience shape). */
type Versioned = NodeData & { [NODE_VERSION_KEY]?: NodeVersion[] };

/** The configuration subset of a node's data — everything except run state. */
export function configSubsetOf(data: NodeData): Partial<NodeData> {
  const subset: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === NODE_VERSION_KEY) continue;
    if (TRANSIENT_KEYS.has(key)) continue;
    subset[key] = value;
  }
  return subset as Partial<NodeData>;
}

/** The versions recorded on a node, oldest first. Empty when none. */
export function listNodeVersions(data: NodeData): NodeVersion[] {
  const versions = (data as Versioned)[NODE_VERSION_KEY];
  return Array.isArray(versions) ? versions : [];
}

/**
 * Which version the node's CURRENT config matches, or -1 if it matches none
 * (an unversioned or manually-edited-away config). Compared by value so a
 * restore lands on the right entry.
 */
export function currentNodeVersionIndex(data: NodeData): number {
  const versions = listNodeVersions(data);
  const current = JSON.stringify(configSubsetOf(data));
  for (let i = versions.length - 1; i >= 0; i -= 1) {
    if (JSON.stringify(versions[i].config) === current) return i;
  }
  return -1;
}

/**
 * Record the node's current config as a new version, returning new data.
 *
 * No-op (returns the same data) when the config is identical to the latest
 * version — a patch that changed nothing should not spawn a version. The FIRST
 * time a node is versioned, its current config becomes the baseline v1 before
 * anything else is appended, so history always starts from a restorable point.
 *
 * Pure: never mutates the input.
 */
export function pushNodeVersion(data: NodeData): NodeData {
  const existing = listNodeVersions(data);
  const config = configSubsetOf(data);
  const configKey = JSON.stringify(config);

  // Already the newest version: nothing changed, so nothing to record.
  if (existing.length > 0 && JSON.stringify(existing[existing.length - 1].config) === configKey) {
    return data;
  }

  const next: NodeVersion = {
    label: `v${existing.length + 1}`,
    at: new Date().toISOString(),
    config,
  };

  return {
    ...data,
    [NODE_VERSION_KEY]: [...existing, next],
  };
}

/**
 * Restore a node to one of its recorded versions, returning new data. Keeps the
 * version history and any transient run state; only the CONFIG fields are
 * replaced. Out-of-range index returns the data unchanged.
 *
 * Pure: never mutates the input.
 */
export function restoreNodeVersion(data: NodeData, index: number): NodeData {
  const versions = listNodeVersions(data);
  if (index < 0 || index >= versions.length) return data;

  // Start from the run-state fields we keep, drop every current config field,
  // then lay the chosen version's config on top.
  const kept: Record<string, unknown> = { [NODE_VERSION_KEY]: versions };
  for (const key of TRANSIENT_KEYS) {
    if (key in data) kept[key] = (data as Record<string, unknown>)[key];
  }
  return { ...kept, ...versions[index].config } as NodeData;
}
