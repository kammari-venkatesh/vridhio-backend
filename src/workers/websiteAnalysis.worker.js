/**
 * Standalone website analysis worker process: `npm run worker:website-analysis`.
 * Safe alongside the in-process worker; analyses are claimed atomically.
 * Set WEBSITE_ANALYSIS_WORKER_ENABLED=false on the API to run analyses only here.
 */
import { connectDB, disconnectDB } from '../config/db.js';
import { createWebsiteAnalysisWorker } from '../services/websiteAnalysis/worker.js';

const main = async () => {
  try {
    const { host, dbName } = await connectDB();
    console.log(`MongoDB connected (${host}/${dbName})`);
  } catch (err) {
    console.error(`Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }

  const worker = createWebsiteAnalysisWorker();
  worker.start();
  console.log(`Website analysis worker ${worker.workerId} started`);

  const shutdown = async (signal) => {
    console.log(`${signal} received, finishing current analyses...`);
    await worker.stop();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main();
