import JSZip from 'jszip';

/**
 * Build a minimal but VALID Microsoft Word .docx from plain text / light
 * Markdown, returned as base64 so it can travel through the workflow's
 * string-typed state and be handed to the browser download node.
 *
 * A .docx is an Office Open XML package — a zip of a few XML parts. We assemble
 * the four parts Word requires (content types, package rels, the document, and
 * the document rels) rather than depend on a heavy document library, since the
 * project already bundles JSZip for the code exporter.
 *
 * Formatting is deliberately simple and predictable: Markdown headings (`#`..)
 * become Word heading paragraphs, blank lines separate paragraphs, everything
 * else is body text. This covers the "convert the scraped article to DOCX"
 * case without pretending to be a full Markdown-to-Word renderer.
 */

/** XML-escape a run of text so content can never break the document XML. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** One Word paragraph, optionally styled as a heading (level 1–6). */
function paragraphXml(text: string, headingLevel = 0): string {
  const runs = escapeXml(text);
  const style =
    headingLevel > 0
      ? `<w:pPr><w:pStyle w:val="Heading${Math.min(headingLevel, 6)}"/></w:pPr>`
      : '';
  // xml:space=preserve keeps leading/trailing spaces the author intended.
  return `<w:p>${style}<w:r><w:t xml:space="preserve">${runs}</w:t></w:r></w:p>`;
}

/** Turn plain text / light Markdown into the sequence of Word paragraphs. */
function bodyXml(title: string, text: string): string {
  const paragraphs: string[] = [];
  if (title.trim()) paragraphs.push(paragraphXml(title.trim(), 1));

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.trim().length === 0) {
      // Blank line → an empty paragraph, preserving the visual gap.
      paragraphs.push('<w:p/>');
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      paragraphs.push(paragraphXml(heading[2], heading[1].length));
    } else {
      paragraphs.push(paragraphXml(line));
    }
  }

  if (paragraphs.length === 0) paragraphs.push('<w:p/>');
  return paragraphs.join('');
}

const CONTENT_TYPES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

/**
 * Assemble the .docx package and return it base64-encoded.
 *
 * @param title Optional document heading, rendered as Heading 1.
 * @param text  Body text (plain or light Markdown).
 */
export async function buildDocxBase64(title: string, text: string): Promise<string> {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${bodyXml(title, text)}
    <w:sectPr/>
  </w:body>
</w:document>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES_XML);
  zip.folder('_rels')?.file('.rels', ROOT_RELS_XML);
  const word = zip.folder('word');
  word?.file('document.xml', documentXml);
  word?.folder('_rels')?.file('document.xml.rels', DOCUMENT_RELS_XML);

  return zip.generateAsync({ type: 'base64', compression: 'DEFLATE' });
}
