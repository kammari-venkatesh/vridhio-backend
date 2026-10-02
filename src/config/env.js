const MIN_JWT_SECRET_LENGTH = 32;

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 8000),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  mongoUri: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET_KEY,
  adminSessionTtlSeconds: 8 * 60 * 60,
  adminCookieName: 'vridhio_admin_session',
};

export const isProduction = env.nodeEnv === 'production';
export const isTest = env.nodeEnv === 'test';

/** Returns a list of configuration problems; never includes secret values. */
export const getEnvErrors = (config = env) => {
  const errors = [];

  if (!config.mongoUri) errors.push('MONGO_URI is not set.');
  if (!config.jwtSecret) {
    errors.push('JWT_SECRET_KEY is not set.');
  } else if (config.jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(`JWT_SECRET_KEY must be at least ${MIN_JWT_SECRET_LENGTH} characters.`);
  }
  if (config.corsOrigins.includes('*')) {
    errors.push('CORS_ORIGINS must list explicit origins; "*" is not allowed with credentials.');
  }

  return errors;
};
