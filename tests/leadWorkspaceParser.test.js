import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectDelimiter,
  detectHeader,
  parseDelimited,
  parseImportContent,
  suggestMapping,
} from '../src/services/leadWorkspace/importParser.js';
import {
  computeDedupeKeys,
  normalizeCustomFields,
  normalizeFieldValue,
  phoneKey,
  websiteKey,
} from '../src/services/leadWorkspace/leadFields.js';
import { csvCell } from '../src/services/leadWorkspace/salesLead.service.js';

const TSV = 'Business Name\tCategory\tPhone\tWebsite\tCity\nABC Gym\tGym\t98765 43210\tabc.example\tHyderabad\nXYZ Salon\tSalon\t91234 56789\txyz.example\tHyderabad\n';

describe('delimiter detection and parsing', () => {
  it('parses tab-separated spreadsheet copies', () => {
    assert.equal(detectDelimiter(TSV), 'tab');
    const { rows, malformed } = parseDelimited(TSV, 'tab');
    assert.equal(malformed, false);
    assert.deepEqual(rows[1], ['ABC Gym', 'Gym', '98765 43210', 'abc.example', 'Hyderabad']);
    assert.equal(rows.length, 3);
  });

  it('parses CSV with quotes, escaped quotes, embedded commas and newlines, and CRLF', () => {
    const csv = 'Name,Notes,Phone\r\n"Smith, Jones & Co","He said ""call later""\nsecond line",123456\r\nPlain,ok,654321\r\n';
    assert.equal(detectDelimiter(csv), 'comma');
    const { rows } = parseDelimited(csv, 'comma');
    assert.deepEqual(rows[1], ['Smith, Jones & Co', 'He said "call later"\nsecond line', '123456']);
    assert.deepEqual(rows[2], ['Plain', 'ok', '654321']);
  });

  it('detects semicolon-separated files', () => {
    assert.equal(detectDelimiter('Name;Phone;City\nA;123456;X\nB;654321;Y'), 'semicolon');
  });

  it('flags unterminated quotes as malformed instead of dropping data', () => {
    const { rows, malformed } = parseDelimited('Name,Notes\nA,"never closed', 'comma');
    assert.equal(malformed, true);
    assert.deepEqual(rows[1], ['A', 'never closed']);
  });
});

describe('header detection and mapping suggestions', () => {
  it('recognises header rows by known column names', () => {
    assert.equal(detectHeader([['Business Name', 'Phone'], ['ABC', '123456']]), true);
  });

  it('treats a data-looking first row as data', () => {
    assert.equal(detectHeader([['ABC Gym', '98765 43210', 'abc.example'], ['XYZ', '91234 56789', 'xyz.example']]), false);
  });

  it('suggests standard fields and keeps unknown columns as custom fields', () => {
    const mapping = suggestMapping(['Business Name', 'Phone', 'Website', 'Instagram', 'Owner', 'Area'], true);
    assert.deepEqual(mapping.slice(0, 3), [{ target: 'businessName' }, { target: 'phone' }, { target: 'website' }]);
    assert.deepEqual(mapping.slice(3), [
      { target: 'custom', customName: 'Instagram' },
      { target: 'custom', customName: 'Owner' },
      { target: 'custom', customName: 'Area' },
    ]);
  });

  it('never maps two columns to the same standard field', () => {
    const mapping = suggestMapping(['Phone', 'Mobile'], true);
    assert.deepEqual(mapping, [{ target: 'phone' }, { target: 'custom', customName: 'Mobile' }]);
  });

  it('assumes the first column is the business name when there is no header', () => {
    const parsed = parseImportContent({ content: 'ABC Gym\t98765 43210\nXYZ Salon\t91234 56789' });
    assert.equal(parsed.hasHeader, false);
    assert.deepEqual(parsed.headers, ['Column 1', 'Column 2']);
    assert.equal(suggestMapping(parsed.headers, false)[0].target, 'businessName');
    assert.equal(parsed.rows.length, 2);
  });
});

describe('parseImportContent', () => {
  it('keeps values beyond the header width as extra columns and reports blank rows', () => {
    const parsed = parseImportContent({ content: 'Business Name,Phone\nABC,123456,extra value\n\n,\nXYZ,654321\n' });
    assert.deepEqual(parsed.headers, ['Business Name', 'Phone', 'Column 3']);
    assert.deepEqual(parsed.rows[0].cells, ['ABC', '123456', 'extra value']);
    assert.equal(parsed.rows.length, 2);
    assert.ok(parsed.warnings.some((w) => /empty row/.test(w)));
    assert.ok(parsed.warnings.some((w) => /more values than the header/.test(w)));
  });

  it('reports spreadsheet row numbers', () => {
    const parsed = parseImportContent({ content: TSV });
    assert.deepEqual(parsed.rows.map((r) => r.line), [2, 3]);
  });

  it('makes duplicate and unsafe header names usable as custom field keys', () => {
    const parsed = parseImportContent({ content: 'Name,Phone,Phone,$owner.name\nA,123456,654321,Ravi' });
    assert.deepEqual(parsed.headers, ['Name', 'Phone', 'Phone (2)', 'owner_name']);
  });
});

describe('field normalisation and duplicate keys', () => {
  it('normalises websites and matches them regardless of scheme, www and trailing slash', () => {
    assert.equal(normalizeFieldValue('website', 'abc.example').value, 'https://abc.example/');
    assert.equal(websiteKey('https://www.ABC.example/'), websiteKey('abc.example'));
    assert.ok(normalizeFieldValue('website', 'javascript:alert(1)').error);
    assert.ok(normalizeFieldValue('website', 'not a site').error);
  });

  it('matches phones on their last 10 digits', () => {
    assert.equal(phoneKey('+91 90000 00101'), phoneKey('9000000101'));
    assert.equal(phoneKey('12'), null);
  });

  it('only builds a name key when the city is known', () => {
    assert.equal(computeDedupeKeys({ businessName: 'ABC Gym' }).nameCity, null);
    assert.equal(
      computeDedupeKeys({ businessName: 'ABC  Gym!', city: 'Hyderabad' }).nameCity,
      computeDedupeKeys({ businessName: 'abc gym', city: 'hyderabad' }).nameCity,
    );
  });

  it('validates statuses, services and tags against the configured vocabulary', () => {
    assert.equal(normalizeFieldValue('status', 'contacted').value, 'CONTACTED');
    assert.ok(normalizeFieldValue('status', 'maybe').error);
    assert.deepEqual(normalizeFieldValue('potentialServices', 'seo; website redesign').value, ['SEO', 'Website Redesign']);
    assert.ok(normalizeFieldValue('potentialServices', 'Teleportation').error);
    assert.deepEqual(normalizeFieldValue('tags', 'Hot, hot , Follow Up').value, ['hot', 'follow up']);
  });

  it('limits custom field sizes', () => {
    assert.deepEqual(normalizeCustomFields({ Owner: 'Ravi', Empty: '' }).value, { Owner: 'Ravi' });
    assert.ok(normalizeCustomFields({ Big: 'x'.repeat(1001) }).error);
    assert.ok(normalizeCustomFields(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`k${i}`, 'v']))).error);
    assert.ok(normalizeCustomFields(['not', 'an', 'object']).error);
  });

  it('neutralises spreadsheet formulas in CSV exports but leaves phone numbers alone', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
    assert.equal(csvCell('+91 90000 00101'), '+91 90000 00101');
    assert.equal(csvCell('-cmd'), "'-cmd");
    assert.equal(csvCell('a,b'), '"a,b"');
  });
});
