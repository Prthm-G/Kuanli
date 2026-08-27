/**
 * Minimal XLSX reader — just enough of the format to read the office's
 * admission workbook, with no third-party dependency.
 *
 * An .xlsx is a ZIP of XML parts, and Node's built-in `zlib` inflates the
 * deflate streams, so the whole reader is ~200 lines. This is deliberate:
 * the maintained npm option (SheetJS `xlsx`) is stale on the registry with
 * known advisories, and this code sits directly in the path of real student
 * PII. Server-side only — never imported into a client bundle.
 *
 * Supports what Excel actually emits for this workbook: stored/deflated ZIP
 * entries, shared strings (including rich-text runs), inline strings, and
 * numeric cells. ZIP64 is detected and rejected loudly rather than misread.
 */

import { inflateRawSync } from 'node:zlib';

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** One decompressed ZIP entry, keyed by its path inside the archive. */
type ZipEntries = Map<string, Buffer>;

/** Locate the End Of Central Directory record, scanning back over any comment. */
function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory record)');
}

/** Read every entry out of a ZIP archive. */
export function unzip(buf: Buffer): ZipEntries {
  const eocd = findEocd(buf);
  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported by this reader');
  }

  const out: ZipEntries = new Map();
  let p = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error(`Corrupt .xlsx: bad central directory entry at ${p}`);
    }
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) {
      throw new Error(`Corrupt .xlsx: bad local header for ${name}`);
    }
    // The local header repeats name/extra with its own lengths — the extra
    // field commonly differs from the central copy, so read it from here.
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      out.set(name, Buffer.from(raw));
    } else if (method === 8) {
      out.set(name, inflateRawSync(raw));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** Decode the five XML entities Excel emits, plus numeric character refs. */
export function decodeXmlText(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Concatenate every <t> in a fragment — a shared string may be rich text runs. */
function joinTextNodes(xml: string): string {
  let out = '';
  const re = /<t\b[^>]*?(\/>|>([\s\S]*?)<\/t>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (m[1] !== '/>') out += decodeXmlText(m[2] ?? '');
  }
  return out;
}

/** xl/sharedStrings.xml → ordinal-indexed string table. */
export function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<si\b[^>]*?(\/>|>([\s\S]*?)<\/si>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1] === '/>' ? '' : joinTextNodes(m[2] ?? ''));
  }
  return out;
}

/** "BC12" → "BC". Column letters identify a cell independently of row length. */
export function columnOf(ref: string): string {
  const m = /^([A-Z]+)/.exec(ref);
  return m ? m[1] : '';
}

/** A worksheet as row objects keyed by column letter. Blank cells are absent. */
export type SheetRows = Array<Record<string, string>>;

/** xl/worksheets/sheetN.xml → rows of {columnLetter: value}. */
export function parseSheet(xml: string, shared: string[]): SheetRows {
  const rows: SheetRows = [];
  const rowRe = /<row\b[^>]*?(\/>|>([\s\S]*?)<\/row>)/g;
  let rm: RegExpExecArray | null;

  while ((rm = rowRe.exec(xml)) !== null) {
    if (rm[1] === '/>') {
      rows.push({});
      continue;
    }
    const cells: Record<string, string> = {};
    const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm: RegExpExecArray | null;

    while ((cm = cellRe.exec(rm[2] ?? '')) !== null) {
      const attrs = cm[1] ?? '';
      const body = cm[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      if (!ref) continue;
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];

      let value = '';
      if (type === 's') {
        const idx = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (idx !== undefined) value = shared[Number(idx)] ?? '';
      } else if (type === 'inlineStr') {
        value = joinTextNodes(body);
      } else {
        // Numbers, dates-as-serials, booleans and formula results all land in <v>.
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) value = decodeXmlText(v);
      }
      if (value !== '') cells[columnOf(ref)] = value;
    }
    rows.push(cells);
  }
  return rows;
}

export interface Workbook {
  /** Sheet names in workbook order. */
  sheetNames: string[];
  /** Read one sheet by its display name (as shown on the tab). */
  sheet(name: string): SheetRows;
}

/** Parse an .xlsx buffer into a lazily-read workbook. */
export function readWorkbook(buf: Buffer): Workbook {
  const entries = unzip(buf);
  const text = (p: string) => entries.get(p)?.toString('utf8');

  const wbXml = text('xl/workbook.xml');
  if (!wbXml) throw new Error('Not a valid .xlsx file (missing xl/workbook.xml)');
  const relsXml = text('xl/_rels/workbook.xml.rels') ?? '';

  // rId -> part path. Targets may be absolute ("/xl/worksheets/…") or relative.
  const relTargets = new Map<string, string>();
  const relRe = /<Relationship\b([^>]*)\/>/g;
  let rm: RegExpExecArray | null;
  while ((rm = relRe.exec(relsXml)) !== null) {
    const id = /\bId="([^"]+)"/.exec(rm[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(rm[1])?.[1];
    if (id && target) {
      relTargets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
    }
  }

  const sheetNames: string[] = [];
  const pathByName = new Map<string, string>();
  const sheetRe = /<sheet\b([^>]*)\/>/g;
  let sm: RegExpExecArray | null;
  while ((sm = sheetRe.exec(wbXml)) !== null) {
    const name = /\bname="([^"]*)"/.exec(sm[1])?.[1];
    const rid = /\br:id="([^"]+)"/.exec(sm[1])?.[1];
    if (!name || !rid) continue;
    const decoded = decodeXmlText(name);
    sheetNames.push(decoded);
    const path = relTargets.get(rid);
    if (path) pathByName.set(decoded, path);
  }

  const shared = parseSharedStrings(text('xl/sharedStrings.xml'));

  return {
    sheetNames,
    sheet(name: string): SheetRows {
      const path = pathByName.get(name);
      if (!path) throw new Error(`Sheet not found: ${name}`);
      const xml = text(path);
      if (!xml) throw new Error(`Sheet part missing from archive: ${path}`);
      return parseSheet(xml, shared);
    },
  };
}
