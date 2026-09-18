import type { FailureKind } from './nodeFailure';

/**
 * A suggested way to fix a failed run, ready to show as a button in the chat.
 *
 * A `prompt` is a canned chat-edit instruction that will be run through the same
 * generate+apply patch pipeline the user's own typing uses. `kind: 'custom'` has
 * no prompt: it focuses the chat input so the user can write their own.
 */
export interface FixSuggestion {
  /** Discriminates the button's behaviour. */
  kind: 'patch' | 'reconnect' | 'change_input' | 'retry' | 'custom';
  /** Short button label. */
  label: string;
  /** One line explaining what this will do. */
  detail: string;
  /** The canned chat-edit instruction, for `kind: 'patch'`. */
  prompt?: string;
}

/** What a failed step looks like to the suggester — a slice of ExecutionLog. */
export interface FailedStepInfo {
  /** The failed node's label, e.g. "Fetch Webpage". */
  node: string;
  failureKind?: FailureKind;
  /** Other `toolId.action` pairs that provide the same capability. */
  alternatives?: string[];
  /** The failure message/output, used to spot a JS-shell/empty-content case. */
  output?: string;
}

/** Does the failure text look like an empty page a browser render could fix? */
function looksLikeEmptyPage(output: string): boolean {
  const text = output.toLowerCase();
  return (
    text.includes('no content') ||
    text.includes('empty') ||
    text.includes('nothing to') ||
    text.includes('extracted_text') ||
    text.includes('shell')
  );
}

/** Is this a web-fetch style node, i.e. one where render_mode applies? */
function looksLikeWebFetch(node: string): boolean {
  const text = node.toLowerCase();
  return (
    text.includes('fetch') ||
    text.includes('webpage') ||
    text.includes('web') ||
    text.includes('scrape')
  );
}

/**
 * Produce a short, TARGETED list of fixes for a failed step — not one giant
 * catch-all, and not a single option. The list is ordered most-likely-first,
 * de-duplicated, capped, and ALWAYS ends with a "write my own" custom option so
 * the user is never boxed in.
 *
 * Every suggestion names the failing node explicitly so the resulting patch
 * targets that one step and leaves the rest of the workflow alone.
 */
export function suggestFixes(step: FailedStepInfo): FixSuggestion[] {
  const suggestions: FixSuggestion[] = [];
  const node = step.node || 'the failed step';
  const output = String(step.output ?? '');

  switch (step.failureKind) {
    case 'auth':
      suggestions.push({
        kind: 'reconnect',
        label: 'Reconnect the tool',
        detail: `“${node}” failed because its tool is not connected or the login expired. Reconnect it, then re-run.`,
      });
      break;

    case 'invalid_input':
      // A bad web URL that came back empty is really a rendering problem — offer
      // the render fix first, then the change-value fallback.
      if (looksLikeWebFetch(node) && looksLikeEmptyPage(output)) {
        suggestions.push({
          kind: 'patch',
          label: 'Render the page with a browser',
          detail: `“${node}” got an empty page — likely JavaScript-rendered. Set it to render with a headless browser before extracting.`,
          prompt: `Update the "${node}" node: set its render_mode input to "always" so it renders the page with a headless browser before extracting. Do not change any other node.`,
        });
      }
      suggestions.push({
        kind: 'change_input',
        label: 'Try a different value',
        detail: `“${node}” rejected the value it was given. Enter a different one and re-run.`,
      });
      break;

    case 'unsupported':
      // Offer to swap in each alternative tool that provides the same capability.
      for (const alt of (step.alternatives ?? []).slice(0, 2)) {
        const [toolId, action] = alt.split('.');
        suggestions.push({
          kind: 'patch',
          label: `Use ${toolId} instead`,
          detail: `Replace “${node}” with ${toolId} (${action}), which can do the same thing.`,
          prompt: `Replace the "${node}" node with the ${toolId} tool's ${action} action. Keep the rest of the workflow the same.`,
        });
      }
      if ((step.alternatives ?? []).length === 0) {
        suggestions.push({
          kind: 'patch',
          label: 'Remove this step',
          detail: `No connected tool can do what “${node}” needs. Remove it so the rest of the workflow can run.`,
          prompt: `Remove the "${node}" node from the workflow. Keep every other step and reconnect around it.`,
        });
      }
      break;

    case 'rate_limit':
    case 'transient':
      suggestions.push({
        kind: 'retry',
        label: 'Run it again',
        detail:
          step.failureKind === 'rate_limit'
            ? 'The service was throttling us. Waiting a moment and re-running usually works.'
            : 'This looked temporary. Re-running may work.',
      });
      break;

    case 'permanent':
    default:
      // Nothing specific to suggest; still offer a targeted look at the step and
      // the alternatives, if any.
      for (const alt of (step.alternatives ?? []).slice(0, 2)) {
        const [toolId, action] = alt.split('.');
        suggestions.push({
          kind: 'patch',
          label: `Try ${toolId} instead`,
          detail: `Swap “${node}” for ${toolId} (${action}) and re-run.`,
          prompt: `Replace the "${node}" node with the ${toolId} tool's ${action} action. Keep the rest of the workflow the same.`,
        });
      }
      break;
  }

  // De-duplicate by label (an alternative might coincide with another branch).
  const seen = new Set<string>();
  const unique = suggestions.filter((s) => {
    if (seen.has(s.label)) return false;
    seen.add(s.label);
    return true;
  });

  // Always let the user take over.
  unique.push({
    kind: 'custom',
    label: 'Write my own fix',
    detail: 'Describe the change yourself and I will apply it.',
  });

  // Keep the list short: at most three targeted options plus the custom one.
  const targeted = unique.filter((s) => s.kind !== 'custom').slice(0, 3);
  return [...targeted, unique[unique.length - 1]];
}
