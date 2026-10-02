/**
 * Read-only summary of Lead Finder and Lead Workspace data in the configured database.
 * It never modifies or deletes anything; cleanup is always a deliberate manual step.
 *
 * Usage: npm run leads:report
 */
import { connectDB, disconnectDB } from '../src/config/db.js';
import { LeadFinderJob } from '../src/models/leadFinderJob.model.js';
import { Prospect } from '../src/models/prospect.model.js';
import { SalesLead } from '../src/models/salesLead.model.js';

const groupCount = (model, field) =>
  model.aggregate([{ $group: { _id: `$${field}`, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]);

const print = (title, rows) => {
  console.log(`\n${title}`);
  if (rows.length === 0) console.log('  (none)');
  for (const { _id, count } of rows) console.log(`  ${String(_id ?? '(unset)').padEnd(16)} ${count}`);
};

await connectDB();
try {
  console.log(`Lead Finder jobs: ${await LeadFinderJob.countDocuments()}`);
  print('Jobs by status', await groupCount(LeadFinderJob, 'status'));
  console.log(`\nProspects: ${await Prospect.countDocuments()}`);
  print('Prospects by provider', await groupCount(Prospect, 'source'));
  console.log(`\nSales leads: ${await SalesLead.countDocuments()} (archived: ${await SalesLead.countDocuments({ archived: true })})`);
  print('Sales leads by source', await groupCount(SalesLead, 'source'));
  print('Sales leads by status', await groupCount(SalesLead, 'status'));
  console.log('\nNo data was changed.');
} finally {
  await disconnectDB();
}
