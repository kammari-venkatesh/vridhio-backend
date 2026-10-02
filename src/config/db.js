import mongoose from 'mongoose';
import { env } from './env.js';

const MONGO_URI_PATTERN = /^mongodb(\+srv)?:\/\/[^/]+\/([^/?]+)/;

/**
 * Validates a MongoDB connection string without ever echoing it back,
 * because it contains credentials. Returns the database name.
 */
export const assertMongoUri = (uri) => {
  if (typeof uri !== 'string' || uri.trim() === '') {
    throw new Error('MONGO_URI is not set. Add it to Backend/.env (see .env.example).');
  }
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new Error('MONGO_URI must start with mongodb:// or mongodb+srv://.');
  }
  const match = uri.match(MONGO_URI_PATTERN);
  if (!match) {
    throw new Error(
      'MONGO_URI must include an explicit database name, e.g. mongodb+srv://<user>:<pass>@<host>/vridhio?...',
    );
  }
  return decodeURIComponent(match[2]);
};

export const connectDB = async (uri = env.mongoUri) => {
  const dbName = assertMongoUri(uri);

  mongoose.connection.on('error', (err) => {
    console.error(`MongoDB connection error: ${err.message}`);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('MongoDB disconnected');
  });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  return { host: mongoose.connection.host, dbName };
};

export const disconnectDB = async () => {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
  }
};
