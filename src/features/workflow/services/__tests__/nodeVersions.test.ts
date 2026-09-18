import { describe, expect, it } from 'vitest';
import { NodeType } from '@/shared/types';
import type { NodeData } from '@features/workflow/types';
import {
  NODE_VERSION_KEY,
  configSubsetOf,
  currentNodeVersionIndex,
  listNodeVersions,
  pushNodeVersion,
  restoreNodeVersion,
} from '../nodeVersions';

function baseData(overrides: Partial<NodeData> = {}): NodeData {
  return {
    label: 'Fetch Webpage',
    type: NodeType.TOOL,
    toolId: 'web',
    toolAction: 'fetch_page',
    ...overrides,
  };
}

describe('configSubsetOf', () => {
  it('drops transient run state and the version list', () => {
    const data = baseData({
      isRunning: true,
      lastSuccess: true,
      output: 'some output',
      render_mode: 'always',
      [NODE_VERSION_KEY]: [{ label: 'v1', at: 'x', config: {} }],
    });
    const subset = configSubsetOf(data) as Record<string, unknown>;
    expect(subset.isRunning).toBeUndefined();
    expect(subset.lastSuccess).toBeUndefined();
    expect(subset.output).toBeUndefined();
    expect(subset[NODE_VERSION_KEY]).toBeUndefined();
    // Real config survives.
    expect(subset.render_mode).toBe('always');
    expect(subset.label).toBe('Fetch Webpage');
  });
});

describe('pushNodeVersion', () => {
  it('records the current config as v1 on first push', () => {
    const data = baseData({ render_mode: 'auto' });
    const next = pushNodeVersion(data);
    const versions = listNodeVersions(next);
    expect(versions).toHaveLength(1);
    expect(versions[0].label).toBe('v1');
    expect(versions[0].config.render_mode).toBe('auto');
  });

  it('appends v2 when the config actually changed', () => {
    let data = pushNodeVersion(baseData({ render_mode: 'auto' }));
    data = { ...data, render_mode: 'always' };
    data = pushNodeVersion(data);
    const versions = listNodeVersions(data);
    expect(versions.map((v) => v.label)).toEqual(['v1', 'v2']);
    expect(versions[1].config.render_mode).toBe('always');
  });

  it('is a no-op when the config is unchanged', () => {
    const first = pushNodeVersion(baseData({ render_mode: 'auto' }));
    const again = pushNodeVersion(first);
    expect(listNodeVersions(again)).toHaveLength(1);
    expect(again).toBe(first); // same reference: truly nothing recorded
  });

  it('does not mutate the input', () => {
    const data = baseData();
    pushNodeVersion(data);
    expect(data[NODE_VERSION_KEY]).toBeUndefined();
  });

  it('ignores a run-state-only change', () => {
    let data = pushNodeVersion(baseData({ render_mode: 'auto' }));
    // A run flips isRunning/output — not config, so no new version.
    data = { ...data, isRunning: true, output: 'ran' };
    data = pushNodeVersion(data);
    expect(listNodeVersions(data)).toHaveLength(1);
  });
});

describe('restoreNodeVersion', () => {
  it('restores an earlier config while keeping the version list', () => {
    let data = pushNodeVersion(baseData({ render_mode: 'auto' }));
    data = pushNodeVersion({ ...data, render_mode: 'always' });
    expect(currentNodeVersionIndex(data)).toBe(1);

    const restored = restoreNodeVersion(data, 0);
    expect(restored.render_mode).toBe('auto');
    // History is preserved so the user can go forward again.
    expect(listNodeVersions(restored)).toHaveLength(2);
    expect(currentNodeVersionIndex(restored)).toBe(0);
  });

  it('keeps transient run state across a restore', () => {
    let data = pushNodeVersion(baseData({ render_mode: 'auto' }));
    data = pushNodeVersion({ ...data, render_mode: 'always' });
    data = { ...data, output: 'last run output' };

    const restored = restoreNodeVersion(data, 0);
    expect(restored.output).toBe('last run output');
    expect(restored.render_mode).toBe('auto');
  });

  it('returns the data unchanged for an out-of-range index', () => {
    const data = pushNodeVersion(baseData());
    expect(restoreNodeVersion(data, 9)).toBe(data);
    expect(restoreNodeVersion(data, -1)).toBe(data);
  });
});

describe('currentNodeVersionIndex', () => {
  it('is -1 when the config matches no recorded version', () => {
    let data = pushNodeVersion(baseData({ render_mode: 'auto' }));
    // Manually edit away from any version.
    data = { ...data, render_mode: 'never' };
    expect(currentNodeVersionIndex(data)).toBe(-1);
  });
});
