import JSZip from 'jszip';
import { getTool } from '../toolRegistry';
import '../connectors';

/**
 * The capability the app used to REFUSE ("we do not have a tool to convert to
 * DOCX"). It is now a real built-in tool: content.to_docx produces a Word
 * document, and files.download_file delivers it as a binary download.
 *
 * This runs the two real actions in sequence, the way the engine does, and
 * asserts a valid .docx comes out the other end — not a text file with a .docx
 * name.
 */

async function runAction(toolId: string, actionName: string, input: Record<string, unknown>) {
  const action = getTool(toolId)?.actions.find((a) => a.name === actionName);
  if (!action) throw new Error(`${toolId}.${actionName} is not registered`);
  return action.execute(input);
}

describe('convert to DOCX and download', () => {
  let clicked: Array<{ download: string }>;

  beforeEach(() => {
    clicked = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:mock'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push({ download: this.download });
    });
  });

  it('is a registered tool action, not a refusal', () => {
    const action = getTool('content')?.actions.find((a) => a.name === 'to_docx');
    expect(action).toBeDefined();
    expect(action?.description.toLowerCase()).toContain('docx');
  });

  it('download_file declares the keys converters emit, so the engine passes them through', () => {
    // The engine slices state to a node's declared inputKeys before running it.
    // If download_file only declared "content", the markdown/docx output was
    // sliced away and the file came out empty ("no content to download").
    const download = getTool('files')?.actions.find((a) => a.name === 'download_file');
    expect(download?.inputKeys).toContain('markdown');
    expect(download?.inputKeys).toContain('docx_base64');
    expect(download?.inputKeys).toContain('file_base64');
  });

  it('produces a valid .docx and downloads it', async () => {
    const doc = await runAction('content', 'to_docx', {
      title: 'Scraped Article',
      extracted_text: '# Intro\nThe article body.\n\nMore text.',
    });

    expect(String(doc.suggested_filename)).toMatch(/\.docx$/);
    expect(String(doc.docx_base64).length).toBeGreaterThan(0);

    // The base64 is a real OOXML package.
    const zip = await JSZip.loadAsync(String(doc.docx_base64), { base64: true });
    expect(zip.file('word/document.xml')).not.toBeNull();
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('Scraped Article');
    expect(xml).toContain('The article body.');

    // Download delivers it as a binary .docx.
    const downloaded = await runAction('files', 'download_file', {
      docx_base64: doc.docx_base64,
      suggested_filename: doc.suggested_filename,
    });

    expect(downloaded.downloaded).toBe(true);
    expect(String(downloaded.saved_filename)).toMatch(/\.docx$/);
    expect(Number(downloaded.bytes)).toBeGreaterThan(0);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toMatch(/\.docx$/);
  });

  it('reports nothing to convert rather than emitting an empty file', async () => {
    const doc = await runAction('content', 'to_docx', { title: '', extracted_text: '' });
    expect(String(doc.error)).toMatch(/no content/i);
    expect(doc.docx_base64).toBe('');
  });

  it('uses an upstream summary over the raw extracted text', async () => {
    // A Summarize step ran before the converter, so BOTH the full article and
    // the summary are in state. The document must contain the SUMMARY, not the
    // full article the user asked to condense.
    const doc = await runAction('content', 'to_docx', {
      title: 'Report',
      extracted_text: 'THE FULL ARTICLE that is very long and unsummarised.',
      summary: 'SHORT SUMMARY of the article.',
    });
    const zip = await JSZip.loadAsync(String(doc.docx_base64), { base64: true });
    const xml = await zip.file('word/document.xml')!.async('string');
    expect(xml).toContain('SHORT SUMMARY');
    expect(xml).not.toContain('THE FULL ARTICLE');
  });

  it('the content tool declares summary/result inputs so the engine forwards them', () => {
    // The engine slices state to a node's inputKeys; without these declared, a
    // summary would be sliced away before the converter runs.
    for (const actionName of ['to_markdown', 'to_docx']) {
      const action = getTool('content')?.actions.find((a) => a.name === actionName);
      expect(action?.inputKeys).toContain('summary');
      expect(action?.inputKeys).toContain('result');
    }
  });

  it('picks the right file per branch when markdown AND docx are both in state', async () => {
    // Parallel branches merge into one state, so the download nodes see BOTH
    // `markdown` and `docx_base64`. Each must produce ITS OWN format — the bug
    // was both saving as .docx. The node label disambiguates them.
    const merged = {
      markdown: '# Title\nbody text',
      docx_base64: await runAction('content', 'to_docx', {
        title: 'Title',
        extracted_text: 'body text',
      }).then((d) => d.docx_base64),
      suggested_filename: 'title.docx', // the docx branch's suggestion, in shared state
      title: 'Title',
    };

    // The Markdown download node — identified by its label — must save .md
    // (text), NOT .docx, even though docx_base64 is present in state.
    const md = await runAction('files', 'download_file', {
      ...merged,
      label: 'Download Markdown File',
    });
    expect(String(md.saved_filename)).toMatch(/\.md$/);

    // The DOCX download node must save .docx (binary) — and it must deliver the
    // DOCX bytes, not the markdown text renamed. Its size matches the decoded
    // base64, which is far larger than the tiny markdown string.
    const docx = await runAction('files', 'download_file', {
      ...merged,
      label: 'Download DOCX File',
    });
    expect(String(docx.saved_filename)).toMatch(/\.docx$/);
    expect(Number(docx.bytes)).toBeGreaterThan(String(merged.markdown).length);
  });

  it('saves .txt when the label asks for a Text File, even with a .md suggestion in state', async () => {
    // The reported case: "Download Emails as Text File" reads a formatted list
    // and an upstream `suggested_filename` of "emails.md". The label says TEXT,
    // so the file must be .txt with text/plain content — not .md. Before the
    // fix the label hint had no "text"/"txt" case and the node fell back to .md.
    const result = await runAction('files', 'download_file', {
      content: 'Sender: Google\nSubject: Security alert\n',
      suggested_filename: 'emails.md',
      title: 'Emails',
      label: 'Download Emails as Text File',
    });

    expect(result.downloaded).toBe(true);
    expect(String(result.saved_filename)).toMatch(/\.txt$/);
    expect(String(result.saved_filename)).not.toMatch(/\.md$/);
    expect(clicked[0].download).toMatch(/\.txt$/);
  });

  it('detectExtensionFromLabel keeps more specific formats over plain "text"', async () => {
    // "Word text" is a docx request, not a plain-text one; the specific rules
    // run before the "text" fallback so a mislabel does not downgrade a binary.
    const wordDoc = await runAction('content', 'to_docx', {
      title: 'Doc',
      extracted_text: 'body',
    });
    const asWord = await runAction('files', 'download_file', {
      docx_base64: wordDoc.docx_base64,
      suggested_filename: wordDoc.suggested_filename,
      label: 'Download Word text document',
    });
    expect(String(asWord.saved_filename)).toMatch(/\.docx$/);
  });
});
