/**
 * Standalone AI qualification worker process: `npm run worker:qualification`.
 * Safe alongside the in-process worker; qualifications are claimed atomically.
 * Set QUALIFICATION_WORKER_ENABLED=false on the API to run qualifications only here.
 */
import { connectDB, disconnectDB } from '../config/db.js';
import { qualificationProviderStatus } from '../services/qualification/providers/index.js';
import { createQualificationWorker } from '../services/qualification/worker.js';

const main = async () => {
  const { provider, mode } = qualificationProviderStatus();
  if (!['live', 'test'].includes(mode)) {
    console.error(`AI qualification is ${mode}; nothing to run.`);
    process.exit(1);
  }
  try {
    const { host, dbName } = await connectDB();
    console.log(`MongoDB connected (${host}/${dbName})`);
  } catch (err) {
    console.error(`Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }

  const worker = createQualificationWorker();
  worker.start();
  console.log(`AI qualification worker ${worker.workerId} started (${provider} provider, ${mode})`);

  const shutdown = async (signal) => {
    console.log(`${signal} received, finishing the current qualification...`);
    await worker.stop();
    await disconnectDB();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main();
