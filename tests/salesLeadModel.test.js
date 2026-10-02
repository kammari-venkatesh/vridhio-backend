import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { SalesLead } from '../src/models/salesLead.model.js';
import { clearDb, startTestDb, stopTestDb } from './helpers/testDb.js';

before(startTestDb);
after(stopTestDb);
beforeEach(clearDb);

describe('SalesLead model', () => {
  it('saves a valid lead with defaults and timestamps', async () => {
    const lead = await SalesLead.create({ businessName: 'ABC Gym' });
    assert.equal(lead.status, 'NEW');
    assert.equal(lead.source, 'MANUAL');
    assert.equal(lead.archived, false);
    assert.deepEqual([...lead.tags], []);
    assert.ok(lead.createdAt instanceof Date);
    assert.ok(lead.updatedAt instanceof Date);

    const createdAt = lead.createdAt;
    await new Promise((r) => setTimeout(r, 5));
    lead.status = 'CONTACTED';
    await lead.save();
    assert.equal(lead.createdAt.getTime(), createdAt.getTime());
    assert.ok(lead.updatedAt > createdAt);
  });

  it('rejects an invalid status or source', async () => {
    await assert.rejects(SalesLead.create({ businessName: 'X', status: 'MAYBE' }), mongoose.Error.ValidationError);
    await assert.rejects(SalesLead.create({ businessName: 'X', source: 'SCRAPER' }), mongoose.Error.ValidationError);
    await assert.rejects(SalesLead.create({ status: 'NEW' }), mongoose.Error.ValidationError);
  });

  it('stores arbitrary spreadsheet columns inside customFields', async () => {
    const lead = await SalesLead.create({ businessName: 'X', customFields: { Instagram: '@x', Owner: 'Ravi' } });
    const stored = await SalesLead.findById(lead._id).lean();
    assert.deepEqual(stored.customFields, { Instagram: '@x', Owner: 'Ravi' });
    assert.equal(stored.Instagram, undefined);
  });

  it('derives duplicate keys on save', async () => {
    const lead = await SalesLead.create({
      businessName: 'ABC Gym',
      city: 'Hyderabad',
      website: 'https://www.abc.example/',
      phone: '+91 98765 43210',
    });
    assert.deepEqual(lead.dedupe.toObject(), { website: 'abc.example', phone: '9876543210', nameCity: 'abcgym|hyderabad' });
  });

  it('allows only one lead per prospect', async () => {
    const prospectId = new mongoose.Types.ObjectId();
    await SalesLead.create({ businessName: 'A', prospectId });
    await assert.rejects(SalesLead.create({ businessName: 'B', prospectId }), (err) => err.code === 11000);
    await SalesLead.create({ businessName: 'C' });
    await SalesLead.create({ businessName: 'D' });
  });
});
