/**
 * Canonical state-key aliases — the permanent fix for the producer/consumer
 * key-mismatch class of bug.
 *
 * The execution engine keeps ONE flat shared state object, but a consumer node
 * only receives a value if the exact key name it declares is present in state.
 * When the planner/patcher adds a node, its output key ("result", "summary", …)
 * often differs from the name a downstream node reads ("extracted_text",
 * "content", …), so data silently does not flow. Until now every connector
 * coped with this by hand-written `input.a ?? input.b ?? …` chains — which only
 * fixes the cases someone thought to hard-code, and never the next new node.
 *
 * This module centralises those synonyms ONCE. Each group lists key names that
 * carry the same logical value. When a consumer asks for one key and it is not
 * in state, the engine offers the first sibling in its group that IS present.
 * A future node that writes any synonym of what a downstream node reads then
 * connects automatically, with no per-connector change.
 *
 * The groups are derived from the `??` fallback chains the connectors already
 * used (content/files/web/gmail/whatsapp/googleSheets), so this reproduces the
 * established behaviour rather than inventing new mappings.
 */

/**
 * Synonym groups. Order matters only for readability — resolution returns the
 * first PRESENT sibling. Keep each group to genuinely-interchangeable values;
 * do NOT merge distinct concepts (e.g. a subject line is not a body).
 */
export const STATE_KEY_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  // The body of text a step passes downstream: a scrape's readable text, an
  // AI step's summary/result, generic content.
  ['extracted_text', 'summary', 'result', 'text', 'content', 'markdown', 'body', 'raw_content'],
  // The URL to act on.
  ['source_url', 'url', 'page_url', 'final_url', 'link'],
  // A recipient address / phone.
  ['to', 'recipient', 'email_to', 'email_recipient', 'phone'],
  // A subject line.
  ['subject', 'email_subject', 'title', 'heading'],
  // Tabular rows.
  ['records', 'rows', 'values', 'categorized_results'],
  // A base64 binary artifact for the download node.
  ['file_base64', 'docx_base64', 'pdf_base64'],
  // A file name.
  ['filename', 'suggested_filename', 'saved_filename'],
];

/** Map from a key to the OTHER keys in its group, built once. */
const ALIASES_OF: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of STATE_KEY_ALIAS_GROUPS) {
    for (const key of group) {
      map.set(
        key,
        group.filter((other) => other !== key),
      );
    }
  }
  return map;
})();

/** The known aliases of a key (excluding itself). Empty when the key has none. */
export function aliasesOf(key: string): readonly string[] {
  return ALIASES_OF.get(key) ?? [];
}

/**
 * Resolve a value for `key` from `state`, honouring aliases.
 *
 * An EXACT match always wins — an alias is only consulted when the declared key
 * itself is absent, so a node that legitimately reads `title` keeps getting the
 * real title even though `title` shares a group with `subject`. Returns
 * `undefined` when neither the key nor any present alias holds a value.
 */
export function resolveWithAliases(
  state: Record<string, unknown>,
  key: string,
): unknown | undefined {
  if (state[key] !== undefined) return state[key];
  for (const alias of aliasesOf(key)) {
    if (state[alias] !== undefined) return state[alias];
  }
  return undefined;
}
