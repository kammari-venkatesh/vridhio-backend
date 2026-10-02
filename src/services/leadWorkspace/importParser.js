import { aliasKey, LEAD_FIELDS, sanitizeCustomFieldKey } from './leadFields.js';

/**
 * Pure parsing for pasted spreadsheet data and CSV files. No database access, so
 * paste and upload share exactly the same pipeline.
 */

export const DELIMITERS = { tab: '\t', comma: ',', semicolon: ';' };
const DELIMITER_NAMES = Object.fromEntries(Object.entries(DELIMITERS).map(([name, char]) => [char, name]));

/** Counts delimiter candidates outside quotes on the first few lines. */
export const detectDelimiter = (text) => {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  if (lines.length === 0) return 'comma';

  const counts = (line) => {
    const result = { '\t': 0, ',': 0, ';': 0 };
    let quoted = false;
    for (const ch of line) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && ch in result) result[ch] += 1;
    }
    return result;
  };
  const perLine = lines.map(counts);

  // Spreadsheet copies are tab-separated; a tab in the header row is decisive.
  if (perLine[0]['\t'] > 0) return 'tab';
  let best = 'comma';
  let bestScore = 0;
  for (const char of [',', ';']) {
    const first = perLine[0][char];
    if (first === 0) continue;
    const consistent = perLine.filter((c) => c[char] === first).length;
    const score = consistent * 1000 + first;
    if (score > bestScore) {
      best = DELIMITER_NAMES[char];
      bestScore = score;
    }
  }
  return best;
};

/**
 * RFC 4180-style parser: quoted fields, "" escapes, delimiters and newlines inside
 * quotes, CRLF line endings. Returns { rows, malformed } where malformed means an
 * unterminated quote was found.
 */
export const parseDelimited = (text, delimiterName) => {
  const delimiter = DELIMITERS[delimiterName] ?? ',';
  const source = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let cellStarted = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && !cellStarted) {
      quoted = true;
      cellStarted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
      cellStarted = false;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      cellStarted = false;
    } else {
      cell += ch;
      if (ch !== ' ') cellStarted = true;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { rows: rows.map((r) => r.map((c) => c.trim())), malformed: quoted };
};

const ALIAS_TO_FIELD = new Map(LEAD_FIELDS.flatMap((f) => f.aliases.map((a) => [aliasKey(a), f.key])));
const looksLikeData = (cell) =>
  /^[+\d][\d\s()+-]{5,}$/.test(cell) || // phone or number
  /^\d+(\.\d+)?$/.test(cell) ||
  /@/.test(cell) ||
  /^(https?:\/\/|www\.)/i.test(cell) ||
  /\.[a-z]{2,}(\/|$)/i.test(cell); // bare domain

/** The first row is a header if it names a known field, or contains only label-like text. */
export const detectHeader = (rows) => {
  const [first] = rows;
  if (!first || first.length === 0) return false;
  if (first.some((c) => ALIAS_TO_FIELD.has(aliasKey(c)))) return true;
  const nonEmpty = first.filter(Boolean);
  if (nonEmpty.length !== first.length || rows.length < 2) return false;
  const unique = new Set(nonEmpty.map((c) => c.toLowerCase())).size === nonEmpty.length;
  return unique && !nonEmpty.some(looksLikeData) && nonEmpty.every((c) => c.length <= 60);
};

/** Unique, non-empty column names; duplicates become "Phone (2)". */
export const buildHeaders = (headerRow, width) => {
  const seen = new Map();
  return Array.from({ length: width }, (_, i) => {
    const base = sanitizeCustomFieldKey(headerRow?.[i] ?? '') || `Column ${i + 1}`;
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base} (${count})`;
  });
};

/**
 * Suggests a target for every column: a standard field (each used once) or a custom field.
 * Without a header row, the first column is assumed to be the business name.
 */
export const suggestMapping = (headers, hasHeader) => {
  const used = new Set();
  return headers.map((header, i) => {
    const field = hasHeader ? ALIAS_TO_FIELD.get(aliasKey(header)) : i === 0 ? 'businessName' : null;
    if (field && !used.has(field)) {
      used.add(field);
      return { target: field };
    }
    return { target: 'custom', customName: header };
  });
};

/**
 * Parses raw pasted or uploaded content into headers and data rows.
 * Rows wider than the header gain extra "Column N" columns so no value is dropped.
 */
export const parseImportContent = ({ content, format = 'auto', hasHeader = 'auto' }) => {
  const delimiter = format === 'auto' ? detectDelimiter(content) : format;
  const { rows: allRows, malformed } = parseDelimited(content, delimiter);
  const nonBlank = allRows
    .map((cells, index) => ({ cells, line: index + 1 }))
    .filter(({ cells }) => cells.some((c) => c !== ''));
  const blankRows = allRows.length - nonBlank.length;

  const header = hasHeader === 'auto' ? detectHeader(nonBlank.map((r) => r.cells)) : Boolean(hasHeader);
  const headerRow = header ? nonBlank[0]?.cells : null;
  const dataRows = header ? nonBlank.slice(1) : nonBlank;
  const width = Math.max(headerRow?.length ?? 0, ...dataRows.map((r) => r.cells.length), 0);
  const headers = buildHeaders(headerRow, width);

  const warnings = [];
  if (malformed) warnings.push('A quoted value is never closed; the last row may be incomplete.');
  if (blankRows > 0) warnings.push(`${blankRows} empty row${blankRows === 1 ? '' : 's'} ignored.`);
  if (headerRow && headerRow.length < width) {
    warnings.push(`Some rows have more values than the header; extra values were added as new columns.`);
  }

  return {
    delimiter,
    hasHeader: header,
    headers,
    rows: dataRows.map(({ cells, line }) => ({
      line,
      cells: Array.from({ length: width }, (_, i) => cells[i] ?? ''),
    })),
    warnings,
  };
};
