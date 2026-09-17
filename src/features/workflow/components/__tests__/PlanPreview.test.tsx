import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@features/tools/connectors';
import { NodeType } from '@/shared/types';
import { PlanPreview } from '../PlanPreview';
import {
  planToWorkflow,
  type WorkflowPlan,
  type PlanStep,
} from '@features/ai/services/workflowPlanGenerator';
import { getToolStatuses } from '@features/tools/toolRegistry';
import type { Workflow } from '@features/workflow/types';

/**
 * Task 9 tests.
 *
 * The preview this replaces was dishonest in three specific ways, and each one
 * gets an assertion here:
 *
 *  1. It never showed which tool a step was bound to, so the reported defect
 *     ("Save results to Google Sheets" for a prompt that never said sheets) was
 *     invisible until after the graph was on the canvas.
 *  2. It never showed steps the planner could not satisfy, so a plan with a hole
 *     looked identical to a complete one.
 *  3. Its only control, "Use this capability", reordered a display array and
 *     changed nothing — it looked like it did something.
 *
 * And it was not editable: the user's only options were accept or close.
 */

function step(overrides: Partial<PlanStep> & { id: string; label: string }): PlanStep {
  return {
    order: 1,
    type: 'process',
    description: '',
    toolId: null,
    toolAction: null,
    unsupported: false,
    unsupportedReason: null,
    inputs: [],
    outputs: [],
    externalInputs: [],
    ...overrides,
  };
}

function plan(steps: PlanStep[]): WorkflowPlan {
  return {
    title: 'Scrape a page to a downloadable Markdown file',
    description: 'Fetch a page, format it as Markdown and download it.',
    estimatedTime: 'Fast',
    steps: steps.map((s, index) => ({ ...s, order: index + 1 })),
    requiredTools: [...new Set(steps.map((s) => s.toolId).filter((id): id is string => !!id))],
    unsupportedCapabilities: steps
      .filter((s) => s.unsupported)
      .map((s) => s.unsupportedReason ?? ''),
    capabilityMatches: [],
  };
}

const SCRAPE_PLAN = plan([
  step({ id: 'start', label: 'Start', type: 'trigger', outputs: ['source_url'] }),
  step({
    id: 'fetch',
    label: 'Fetch the page',
    type: 'tool',
    toolId: 'web',
    toolAction: 'fetch_page',
    externalInputs: ['source_url'],
  }),
  step({
    id: 'markdown',
    label: 'Summarise as Markdown',
    type: 'tool',
    toolId: 'content',
    toolAction: 'to_markdown',
  }),
  step({
    id: 'download',
    label: 'Download the file',
    type: 'tool',
    toolId: 'files',
    toolAction: 'download_file',
  }),
]);

interface Rendered {
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
}

function renderPreview(source: WorkflowPlan, options: { isCommitting?: boolean } = {}): Rendered {
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  render(
    <PlanPreview
      plan={source}
      draft={planToWorkflow(source)}
      toolStatuses={getToolStatuses()}
      onCancel={onCancel}
      onCommit={onCommit}
      isCommitting={options.isCommitting}
    />,
  );
  return { onCommit, onCancel };
}

/** The graph handed back on commit. */
function committed(onCommit: ReturnType<typeof vi.fn>): Workflow {
  expect(onCommit).toHaveBeenCalledTimes(1);
  return onCommit.mock.calls[0][0] as Workflow;
}

describe('showing what the workflow will actually do', () => {
  it('names the tool and action every bound step will call', () => {
    renderPreview(SCRAPE_PLAN);

    // Verbatim, so a substituted tool is visible before the graph is accepted.
    expect(screen.getByText('web.fetch_page')).toBeInTheDocument();
    expect(screen.getByText('content.to_markdown')).toBeInTheDocument();
    expect(screen.getByText('files.download_file')).toBeInTheDocument();
  });

  it('says plainly when a step calls no tool', () => {
    renderPreview(SCRAPE_PLAN);

    const trigger = screen.getByTestId('plan-step-start');
    expect(within(trigger).getByText('no tool call')).toBeInTheDocument();
  });

  it('marks the steps that will pause for approval', () => {
    renderPreview(
      plan([
        step({ id: 'start', label: 'Start', type: 'trigger' }),
        step({
          id: 'send',
          label: 'Email the summary',
          type: 'tool',
          toolId: 'gmail',
          toolAction: 'send_email',
        }),
      ]),
    );

    const send = screen.getByTestId('plan-step-send');
    expect(within(send).getByText('asks approval')).toBeInTheDocument();
    // A read-only fetch is not gated, so the badge must not be everywhere.
    expect(screen.getAllByText('asks approval')).toHaveLength(1);
  });

  it('lists the values the user still has to supply', () => {
    renderPreview(SCRAPE_PLAN);

    expect(screen.getByText(/1 value is still needed/i)).toBeInTheDocument();
    expect(screen.getByLabelText('source_url for Fetch the page')).toHaveValue('');
  });

  it('flags a bound tool that is not connected yet', () => {
    renderPreview(
      plan([
        step({ id: 'start', label: 'Start', type: 'trigger' }),
        step({
          id: 'send',
          label: 'Email the summary',
          type: 'tool',
          toolId: 'gmail',
          toolAction: 'send_email',
        }),
      ]),
    );

    // Gmail has no token in a test environment, so it reports unauthenticated.
    expect(screen.getByText('Not connected yet')).toBeInTheDocument();
    expect(screen.getByText(/Gmail/)).toBeInTheDocument();
  });
});

describe('honest gaps', () => {
  const WITH_GAP = plan([
    step({ id: 'start', label: 'Start', type: 'trigger' }),
    step({
      id: 'sms',
      label: 'Text the customer',
      unsupported: true,
      unsupportedReason: 'No connected tool can send SMS.',
    }),
  ]);

  it('states the gap and its reason above everything else', () => {
    renderPreview(WITH_GAP);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('1 step has no tool behind it');
    expect(alert).toHaveTextContent('No connected tool can send SMS.');
    // The consequence, not just the fact.
    expect(alert).toHaveTextContent(/A run will stop at the first of these/i);
  });

  it('counts unresolved gaps in the footer', () => {
    renderPreview(WITH_GAP);
    expect(screen.getByText('1 unresolved gap')).toBeInTheDocument();
  });

  it('reports the plan as ready when there is no gap', () => {
    renderPreview(SCRAPE_PLAN);
    expect(screen.getByText('4 steps ready')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the warning once the gap step is deleted', async () => {
    const user = userEvent.setup();
    renderPreview(WITH_GAP);

    await user.click(screen.getByLabelText('Delete step Text the customer'));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('1 step ready')).toBeInTheDocument();
  });
});

describe('editing before committing', () => {
  it('commits the plan unchanged when nothing is edited', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderPreview(SCRAPE_PLAN);

    await user.click(screen.getByRole('button', { name: /add to canvas/i }));

    const graph = committed(onCommit);
    expect(graph.nodes.map((node) => node.id)).toEqual(['start', 'fetch', 'markdown', 'download']);
    expect(graph.edges).toHaveLength(3);
  });

  it('renames a step and commits the new label', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderPreview(SCRAPE_PLAN);

    const field = screen.getByLabelText('Step 2 name');
    await user.clear(field);
    await user.type(field, 'Download the review page');
    await user.click(screen.getByRole('button', { name: /add to canvas/i }));

    const graph = committed(onCommit);
    expect(graph.nodes[1].data.label).toBe('Download the review page');
  });

  it('deletes a step and closes the chain behind it', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderPreview(SCRAPE_PLAN);

    await user.click(screen.getByLabelText('Delete step Summarise as Markdown'));
    await user.click(screen.getByRole('button', { name: /add to canvas/i }));

    const graph = committed(onCommit);
    expect(graph.nodes.map((node) => node.id)).toEqual(['start', 'fetch', 'download']);
    // The gap left by the deleted node is closed, not left dangling.
    expect(graph.edges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      'start->fetch',
      'fetch->download',
    ]);
    expect(graph.edges.some((edge) => edge.target === 'markdown')).toBe(false);
  });

  it('refuses to delete the last remaining step', async () => {
    const user = userEvent.setup();
    renderPreview(plan([step({ id: 'start', label: 'Start', type: 'trigger' })]));

    const remove = screen.getByLabelText('Delete step Start');
    expect(remove).toBeDisabled();
    await user.click(remove);

    expect(screen.getByTestId('plan-step-start')).toBeInTheDocument();
  });

  it('carries a supplied external value onto the committed node', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderPreview(SCRAPE_PLAN);

    await user.type(
      screen.getByLabelText('source_url for Fetch the page'),
      'https://example.com/reviews',
    );

    // The banner disappears as soon as the value exists.
    expect(screen.queryByText(/value is still needed/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add to canvas/i }));

    const graph = committed(onCommit);
    // The executor merges non-reserved node data into the tool input, so this
    // is what makes the value reach the fetch call.
    expect(graph.nodes[1].data.source_url).toBe('https://example.com/reviews');
  });

  it('discards without committing', async () => {
    const user = userEvent.setup();
    const { onCommit, onCancel } = renderPreview(SCRAPE_PLAN);

    await user.click(screen.getByRole('button', { name: /discard/i }));

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });
});

describe('the approval gate cannot be bargained away', () => {
  const WITH_SEND = plan([
    step({ id: 'start', label: 'Start', type: 'trigger' }),
    step({
      id: 'send',
      label: 'Email the summary',
      type: 'tool',
      toolId: 'gmail',
      toolAction: 'send_email',
    }),
  ]);

  it('locks the approval checkbox on for an irreversible action', () => {
    renderPreview(WITH_SEND);

    const checkbox = screen.getByLabelText('Ask for approval before Email the summary');
    expect(checkbox).toBeChecked();
    // Sending an email cannot be undone, so the preview is not allowed to
    // turn the gate off — the registry owns that decision.
    expect(checkbox).toBeDisabled();
  });

  it('still gates the committed node even though the box is untouchable', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderPreview(WITH_SEND);

    await user.click(screen.getByRole('button', { name: /add to canvas/i }));

    const graph = committed(onCommit);
    expect(graph.nodes[1].data.requiresApproval).toBe(true);
  });

  it('lets the user opt a harmless step IN to approval', async () => {
    const user = userEvent.setup();
    const { onCommit } = renderPreview(SCRAPE_PLAN);

    const checkbox = screen.getByLabelText('Ask for approval before Fetch the page');
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toBeEnabled();

    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: /add to canvas/i }));

    const graph = committed(onCommit);
    expect(graph.nodes[1].data.requiresApproval).toBe(true);
  });
});

describe('while the graph is being added', () => {
  it('freezes editing so the canvas and the preview cannot diverge', () => {
    renderPreview(SCRAPE_PLAN, { isCommitting: true });

    expect(screen.getByLabelText('Step 1 name')).toBeDisabled();
    expect(screen.getByLabelText('Delete step Fetch the page')).toBeDisabled();
    expect(screen.getByLabelText('source_url for Fetch the page')).toBeDisabled();
    expect(screen.getByRole('button', { name: /add to canvas/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /discard/i })).toBeDisabled();
  });

  it('reports progress instead of readiness', () => {
    renderPreview(SCRAPE_PLAN, { isCommitting: true });
    expect(screen.getByText('Adding step 1 of 4')).toBeInTheDocument();
  });
});

describe('what the plan produces', () => {
  it('maps step types to node types the canvas can render', () => {
    const graph = planToWorkflow(SCRAPE_PLAN);
    expect(graph.nodes[0].type).toBe(NodeType.TRIGGER);
    expect(graph.nodes[1].type).toBe(NodeType.TOOL);
  });
});
