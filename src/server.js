import app from './app.js';
import { connectDB, disconnectDB } from './config/db.js';
import { env, getEnvErrors } from './config/env.js';
import { leadFinderConfig } from './config/leadFinder.js';
import { getProviderStatus } from './services/leadFinder/providers.js';
import { createLeadFinderWorker } from './services/leadFinder/worker.js';
import { websiteAnalysisConfig } from './config/websiteAnalysis.js';
import { createWebsiteAnalysisWorker } from './services/websiteAnalysis/worker.js';
import { qualificationConfig } from './config/qualification.js';
import { qualificationProviderStatus } from './services/qualification/providers/index.js';
import { createQualificationWorker } from './services/qualification/worker.js';

const start = async () => {
  const envErrors = getEnvErrors();
  if (envErrors.length > 0) {
    console.error(`Invalid configuration:\n- ${envErrors.join('\n- ')}`);
    process.exit(1);
  }

  try {
    const { host, dbName } = await connectDB();
    console.log(`MongoDB connected (${host}/${dbName})`);
  } catch (err) {
    console.error(`Failed to connect to MongoDB: ${err.message}`);
    process.exit(1);
  }

  const worker = leadFinderConfig.workerEnabled ? createLeadFinderWorker() : null;
  // Only processes analyses an admin queued explicitly; discovery never queues any.
  const analysisWorker = websiteAnalysisConfig.workerEnabled ? createWebsiteAnalysisWorker() : null;
  // Only processes qualifications an admin requested; idle while AI is disabled.
  const aiStatus = qualificationProviderStatus();
  const qualificationWorker =
    qualificationConfig.workerEnabled && ['live', 'test'].includes(aiStatus.mode) ? createQualificationWorker() : null;

  const server = app.listen(env.port, async (err) => {
    if (err) {
      console.error(`Failed to start server on port ${env.port}: ${err.message}`);
      await disconnectDB();
      process.exit(1);
    }
    console.log(`Server running in ${env.nodeEnv} mode on http://localhost:${env.port}`);
    if (worker) {
      worker.start();
      const real = getProviderStatus().providers.apify;
      console.log(
        `Lead Finder worker started (default: test data; real Apify: ${real.available ? 'available' : (real.unavailableReason ?? 'unavailable')})`,
      );
    }
    if (analysisWorker) {
      analysisWorker.start();
      console.log(`Website analysis worker started (concurrency ${websiteAnalysisConfig.worker.concurrency})`);
    }
    if (qualificationWorker) {
      qualificationWorker.start();
      console.log(`AI qualification worker started (${aiStatus.provider} provider, ${aiStatus.mode})`);
    } else {
      console.log(`AI qualification: ${aiStatus.mode}`);
    }
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down...`);
    server.close(async () => {
      await Promise.all([worker?.stop(), analysisWorker?.stop(), qualificationWorker?.stop()]);
      await disconnectDB();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

start();
