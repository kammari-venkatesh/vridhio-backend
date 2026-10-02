import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { clearDb, createTestAdmin, loginAgent, startTestDb, stopTestDb } from './helpers/testDb.js';

const PREVIEW = '/api/admin/lead-workspace/import/preview';
const IMPORT = '/api/admin/lead-workspace/import';

const SHEET = [
  ['Business Name', 'Category', 'Phone', 'Website', 'City', 'Instagram', 'Owner'],
  ['ABC Gym', 'Gym', '98765 43210', 'abc.example', 'Hyderabad', '@abcgym', 'Ravi'],
  ['XYZ Salon', 'Salon', '91234 56789', 'xyz.example', 'Hyderabad', '', 'Meena'],
  ['Corner Cafe', 'Cafe', '', '', 'Pune', '@corner', ''],
]
  .map((r) => r.join('\t'))
  .join('\n');

before(startTestDb);
after(stopTestDb);
beforeEach(async () => {
  await clearDb();
  await createTestAdmin();
});

const preview = async (agent, body) => agent.post(PREVIEW).send({ content: SHEET, ...body });
const runImport = async (agent, body) => {
  const { mapping } = (await preview(agent, body)).body.data;
  return agent.post(IMPORT).send({ content: SHEET, mapping, ...body });
};

describe('import access control', () => {
  it('rejects unauthenticated preview and import without parsing large bodies', async () => {
    assert.equal((await request(app).post(PREVIEW).send({ content: SHEET })).status, 401);
    assert.equal((await request(app).post(IMPORT).send({ content: SHEET, mapping: [] })).status, 401);
    // The server answers before reading the upload, so the client may see the socket close mid-send.
    const huge = await request(app)
      .post(IMPORT)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ content: 'x'.repeat(5_000_000) }))
      .then((res) => res.status, (err) => err.code);
    assert.ok([401, 'EPIPE', 'ECONNRESET'].includes(huge), `unexpected result: ${huge}`);
  });
});

describe('POST /api/admin/lead-workspace/import/preview', () => {
  it('detects columns, suggests mappings and analyses rows without inserting', async () => {
    const { agent } = await loginAgent(app);
    const res = await preview(agent);

    assert.equal(res.status, 200);
    const data = res.body.data;
    assert.equal(data.delimiter, 'tab');
    assert.equal(data.hasHeader, true);
    assert.equal(data.rowCount, 3);
    assert.deepEqual(data.columns.map((c) => c.header), SHEET.split('\n')[0].split('\t'));
    assert.deepEqual(data.mapping.map((m) => m.target), ['businessName', 'category', 'phone', 'website', 'city', 'custom', 'custom']);
    assert.equal(data.analysis.newRows, 3);
    assert.deepEqual(data.analysis.rows[0].values.customFields, { Instagram: '@abcgym', Owner: 'Ravi' });
    assert.equal(await SalesLead.countDocuments(), 0);
  });

  it('reports mapping problems instead of analysing', async () => {
    const { agent } = await loginAgent(app);
    const mapping = [{ target: 'phone' }, { target: 'phone' }, { target: 'ignore' }, { target: 'ignore' }, { target: 'ignore' }, { target: 'ignore' }, { target: 'nonsense' }];
    const res = await preview(agent, { mapping });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.mappingErrors.businessName);
    assert.match(res.body.data.mappingErrors.column1, /already mapped/);
    assert.ok(res.body.data.mappingErrors.column6);
    assert.equal(res.body.data.analysis, null);
  });

  it('parses CSV through the same pipeline', async () => {
    const { agent } = await loginAgent(app);
    const csv = 'Company,Mobile,Area\n"Smith, Jones & Co",+91 90000 11111,Banjara Hills\n';
    const res = await agent.post(PREVIEW).send({ content: csv, method: 'csv' });
    assert.equal(res.body.data.delimiter, 'comma');
    assert.deepEqual(res.body.data.analysis.rows[0].values, {
      businessName: 'Smith, Jones & Co',
      phone: '+91 90000 11111',
      customFields: { Area: 'Banjara Hills' },
    });
  });

  it('rejects empty, oversized and over-long imports', async () => {
    const { agent } = await loginAgent(app);
    assert.equal((await agent.post(PREVIEW).send({ content: '   ' })).status, 400);
    assert.equal((await agent.post(PREVIEW).send({ content: 'Business Name' })).status, 400);

    const tooBig = await agent.post(PREVIEW).send({ content: 'a'.repeat(2_000_001) });
    assert.equal(tooBig.status, 400);
    assert.match(tooBig.body.details.content, /too large/);

    const manyRows = ['Business Name', ...Array.from({ length: 5001 }, (_, i) => `Shop ${i}`)].join('\n');
    const tooMany = await agent.post(PREVIEW).send({ content: manyRows });
    assert.equal(tooMany.status, 413);

    const wide = [Array.from({ length: 51 }, (_, i) => `Col${i}`).join(','), Array.from({ length: 51 }, () => 'v').join(',')].join('\n');
    assert.equal((await agent.post(PREVIEW).send({ content: wide })).status, 413);
  });

  it('rejects invalid options', async () => {
    const { agent } = await loginAgent(app);
    const res = await agent.post(PREVIEW).send({ content: SHEET, format: 'xml', hasHeader: 'maybe', mapping: 'all' });
    assert.equal(res.status, 400);
    assert.ok(res.body.details.format && res.body.details.hasHeader && res.body.details.mapping);
  });
});

describe('POST /api/admin/lead-workspace/import', () => {
  it('inserts rows with mapped fields, custom fields and import source', async () => {
    const { agent } = await loginAgent(app);
    const res = await runImport(agent);

    assert.equal(res.status, 200);
    assert.deepEqual(
      { ...res.body.data, errors: undefined, duplicateRows: undefined, warnings: undefined },
      { totalRows: 3, inserted: 3, updated: 0, skipped: 0, duplicates: 0, errorCount: 0, errors: undefined, duplicateRows: undefined, warnings: undefined },
    );
    const abc = await SalesLead.findOne({ businessName: 'ABC Gym' }).lean();
    assert.equal(abc.website, 'https://abc.example/');
    assert.equal(abc.city, 'Hyderabad');
    assert.equal(abc.source, 'CSV_IMPORT');
    assert.equal(abc.sourceDetail, 'Spreadsheet paste');
    assert.equal(abc.status, 'NEW');
    assert.deepEqual(abc.customFields, { Instagram: '@abcgym', Owner: 'Ravi' });
  });

  it('honours a custom mapping, renamed custom fields and ignored columns', async () => {
    const { agent } = await loginAgent(app);
    const mapping = [
      { target: 'businessName' },
      { target: 'ignore' },
      { target: 'phone' },
      { target: 'ignore' },
      { target: 'custom', customName: 'Area' },
      { target: 'custom', customName: 'IG Handle' },
      { target: 'contactName' },
    ];
    const res = await agent.post(IMPORT).send({ content: SHEET, mapping, method: 'csv', fileName: 'gyms.csv' });
    assert.equal(res.body.data.inserted, 3);
    const abc = await SalesLead.findOne({ businessName: 'ABC Gym' }).lean();
    assert.equal(abc.category, null);
    assert.equal(abc.contactName, 'Ravi');
    assert.equal(abc.sourceDetail, 'CSV file: gyms.csv');
    assert.deepEqual(abc.customFields, { Area: 'Hyderabad', 'IG Handle': '@abcgym' });
  });

  it('reports rows with a missing business name as errors and imports the rest', async () => {
    const { agent } = await loginAgent(app);
    const content = 'Business Name,Phone\nGood Shop,123456\n,654321\nAnother Shop,\n';
    const { mapping } = (await agent.post(PREVIEW).send({ content })).body.data;
    const res = await agent.post(IMPORT).send({ content, mapping });

    assert.equal(res.body.data.inserted, 2);
    assert.equal(res.body.data.errorCount, 1);
    assert.deepEqual(res.body.data.errors, [{ row: 3, message: 'Business Name is empty.' }]);
    assert.equal(await SalesLead.countDocuments(), 2);
  });

  it('keeps invalid optional values as custom fields with a warning', async () => {
    const { agent } = await loginAgent(app);
    const content = 'Business Name,Email,Website,Status\nOdd Shop,not-an-email,javascript:alert(1),maybe\n';
    const { mapping } = (await agent.post(PREVIEW).send({ content })).body.data;
    const res = await agent.post(IMPORT).send({ content, mapping });

    assert.equal(res.body.data.inserted, 1);
    assert.equal(res.body.data.warnings.length, 3);
    const lead = await SalesLead.findOne().lean();
    assert.equal(lead.email, null);
    assert.equal(lead.website, null);
    assert.equal(lead.status, 'NEW');
    assert.deepEqual(lead.customFields, { Email: 'not-an-email', Website: 'javascript:alert(1)', Status: 'maybe' });
  });

  it('skips duplicates of existing leads by website and phone and reports them', async () => {
    const { agent } = await loginAgent(app);
    await SalesLead.create({ businessName: 'ABC Fitness (old name)', website: 'https://www.abc.example' });
    await SalesLead.create({ businessName: 'XYZ', phone: '+91 91234 56789' });

    const res = await runImport(agent);
    const data = res.body.data;
    assert.equal(data.inserted, 1);
    assert.equal(data.duplicates, 2);
    assert.equal(data.skipped, 2);
    assert.deepEqual(data.duplicateRows.map((d) => [d.row, d.matchedOn, d.action]), [
      [2, 'website', 'skipped'],
      [3, 'phone', 'skipped'],
    ]);
    assert.ok(data.duplicateRows[0].existingLead.id);
    assert.equal(await SalesLead.countDocuments(), 3);
    assert.equal(data.inserted + data.updated + data.skipped + data.errorCount, data.totalRows);
  });

  it('detects duplicates within the same import', async () => {
    const { agent } = await loginAgent(app);
    const content = 'Business Name,Phone,City\nABC Gym,98765 43210,Hyderabad\nABC Gym Branch,+91 98765 43210,Hyderabad\nabc gym,,hyderabad\nABC Gym,,Pune\n';
    const { mapping } = (await agent.post(PREVIEW).send({ content })).body.data;
    const res = await agent.post(IMPORT).send({ content, mapping });

    assert.equal(res.body.data.inserted, 2, 'same name in a different city is not a duplicate');
    assert.deepEqual(res.body.data.duplicateRows.map((d) => [d.row, d.matchedOn, d.duplicateOfRow]), [
      [3, 'phone', 2],
      [4, 'businessName+city', 2],
    ]);
  });

  it('merges duplicates into existing leads when asked to update', async () => {
    const { agent } = await loginAgent(app);
    const existing = await SalesLead.create({
      businessName: 'ABC Gym',
      website: 'abc.example',
      tags: ['vip'],
      customFields: { Owner: 'Old owner', Since: '2019' },
    });

    const res = await runImport(agent, { duplicateMode: 'update' });
    assert.equal(res.body.data.inserted, 2);
    assert.equal(res.body.data.updated, 1);
    assert.equal(res.body.data.skipped, 0);
    assert.equal(res.body.data.duplicateRows[0].action, 'updated');

    const merged = await SalesLead.findById(existing._id).lean();
    assert.equal(merged.phone, '98765 43210');
    assert.equal(merged.source, 'MANUAL', 'origin is preserved');
    assert.deepEqual(merged.tags, ['vip']);
    assert.deepEqual(merged.customFields, { Owner: 'Ravi', Since: '2019', Instagram: '@abcgym' });
  });

  it('requires a valid mapping', async () => {
    const { agent } = await loginAgent(app);
    assert.equal((await agent.post(IMPORT).send({ content: SHEET })).status, 400);
    const res = await agent.post(IMPORT).send({ content: SHEET, mapping: [{ target: 'businessName' }] });
    assert.equal(res.status, 400);
    assert.match(res.body.details.mapping, /each of the 7 columns/);
    assert.equal(await SalesLead.countDocuments(), 0);
  });

  it('rejects cells longer than the limit as row errors', async () => {
    const { agent } = await loginAgent(app);
    const content = `Business Name,Notes\nShort,ok\nLong,${'x'.repeat(2001)}\n`;
    const { mapping } = (await agent.post(PREVIEW).send({ content })).body.data;
    const res = await agent.post(IMPORT).send({ content, mapping });
    assert.equal(res.body.data.inserted, 1);
    assert.match(res.body.data.errors[0].message, /longer than 2000/);
  });
});
