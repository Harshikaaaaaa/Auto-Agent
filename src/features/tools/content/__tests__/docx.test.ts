import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { buildDocxBase64 } from '../docx';

/**
 * A .docx is an Office Open XML zip. These tests assert we emit a REAL package
 * Word can open — the required parts are present and the content lands in the
 * document — rather than a text file with a .docx name.
 */
describe('buildDocxBase64', () => {
  async function unzip(base64: string) {
    const zip = await JSZip.loadAsync(base64, { base64: true });
    return zip;
  }

  it('produces a zip with the four parts Word requires', async () => {
    const base64 = await buildDocxBase64('Title', 'Hello world.');
    const zip = await unzip(base64);
    expect(zip.file('[Content_Types].xml')).not.toBeNull();
    expect(zip.file('_rels/.rels')).not.toBeNull();
    expect(zip.file('word/document.xml')).not.toBeNull();
    expect(zip.file('word/_rels/document.xml.rels')).not.toBeNull();
  });

  it('puts the title and body text into the document', async () => {
    const base64 = await buildDocxBase64('My Report', 'The first paragraph.\n\nThe second.');
    const zip = await unzip(base64);
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('My Report');
    expect(doc).toContain('The first paragraph.');
    expect(doc).toContain('The second.');
  });

  it('renders a Markdown heading as a Word heading paragraph', async () => {
    const base64 = await buildDocxBase64('', '# Section One\nbody');
    const zip = await unzip(base64);
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('Heading1');
    expect(doc).toContain('Section One');
    // The '#' marker itself must not leak into the rendered text.
    expect(doc).not.toContain('# Section One');
  });

  it('escapes XML-special characters so content cannot break the document', async () => {
    const base64 = await buildDocxBase64('A & B', 'x < y > z "q"');
    const zip = await unzip(base64);
    const doc = await zip.file('word/document.xml')!.async('string');
    expect(doc).toContain('A &amp; B');
    expect(doc).toContain('&lt; y &gt;');
    // And the raw, unescaped form is absent.
    expect(doc).not.toContain('A & B');
  });

  it('reports nothing to convert as an error, handled by the connector', async () => {
    // Empty-in still produces a valid (empty) doc; the connector guards the
    // "no content" case before calling this.
    const base64 = await buildDocxBase64('', '');
    const zip = await unzip(base64);
    expect(zip.file('word/document.xml')).not.toBeNull();
  });
});
