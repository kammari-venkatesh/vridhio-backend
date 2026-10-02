/**
 * Standalone Lead Finder worker process: `npm run worker`.
 * Safe to run alongside the in-process worker; jobs are claimed atomically.
 * Set LEAD_FINDER_WORKER_ENABLED=false on the API to run workers only here.
 */
import { connectDB, disconnectDB } from '../config/db.js';
import { createLeadFinderWorker } from '../services/leadFinder/worker.js';

const main = async () => {
  try {
    const { host, dbName } = await connectDB();
    console.log(`MongoDB connected (${host}/${dbName})`);
  } catch (err) {
    console.error(`Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }

  const worker = createLeadFinderWorker();
  worker.start();
  console.log(`Lead Finder worker ${worker.workerId} started (providers: ${worker.providers.join(', ')})`);

  const shutdown = async (signal) => {
    console.log(`${signal} received, finishing current job...`);
    await worker.stop();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main();
