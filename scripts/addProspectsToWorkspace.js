/**
 * Adds Lead Finder prospects discovered before automatic adding existed to the Lead
 * Workspace as AI_DISCOVERY sales leads. Prospects that already have a lead are skipped,
 * and a prospect matching an existing lead is linked to it instead of duplicated.
 * Nothing is deleted or overwritten.
 *
 * Usage:
 *   npm run leads:add-prospects                       # dry run: report only, no changes
 *   npm run leads:add-prospects -- --apply            # add every missing prospect
 *   npm run leads:add-prospects -- --apply --skip-test-data
 *                                                     # leave built-in test data out
 */
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Prospect } from '../src/models/prospect.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';
import { addProspectsToWorkspace } from '../src/services/leadWorkspace/salesLead.service.js';

const apply = process.argv.includes('--apply');
const skipTestData = process.argv.includes('--skip-test-data');
const BATCH = 100;

await connectDB();
try {
  const linked = await SalesLead.distinct('prospectId', { prospectId: { $type: 'objectId' } });
  const filter = { _id: { $nin: linked }, ...(skipTestData && { source: { $ne: 'fake' } }) };
  const missing = await Prospect.aggregate([{ $match: filter }, { $group: { _id: '$source', count: { $sum: 1 } } }]);

  console.log('Prospects without a sales lead, by provider:');
  if (missing.length === 0) console.log('  (none)');
  for (const { _id, count } of missing) {
    console.log(`  ${String(_id).padEnd(10)} ${count}${_id === 'fake' ? '  (built-in test data, tagged "test-data")' : ''}`);
  }

  if (!apply) {
    console.log('\nDry run: no data was changed. Re-run with --apply to add them.');
  } else {
    let created = 0;
    let matched = 0;
    for (let skip = 0; ; skip += BATCH) {
      const prospects = await Prospect.find(filter).sort({ _id: 1 }).skip(skip).limit(BATCH);
      if (prospects.length === 0) break;
      const result = await addProspectsToWorkspace(prospects, null);
      created += result.created;
      matched += result.linked;
    }
    console.log(`\nAdded ${created} new leads; linked ${matched} prospects to leads that already existed.`);
  }
} finally {
  await disconnectDB();
}
