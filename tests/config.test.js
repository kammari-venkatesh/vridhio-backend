import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertMongoUri } from '../src/config/db.js';
import { getEnvErrors } from '../src/config/env.js';

const validConfig = {
  mongoUri: 'mongodb+srv://user:pass@cluster.example.net/vridhio?retryWrites=true',
  jwtSecret: 'x'.repeat(64),
  corsOrigins: ['http://localhost:3000'],
};

describe('MongoDB configuration validation', () => {
  it('rejects a missing or empty MONGO_URI', () => {
    assert.throws(() => assertMongoUri(undefined), /MONGO_URI is not set/);
    assert.throws(() => assertMongoUri('   '), /MONGO_URI is not set/);
  });

  it('rejects a non-MongoDB connection string', () => {
    assert.throws(() => assertMongoUri('postgres://u:p@host/db'), /must start with mongodb/);
  });

  it('requires an explicit database name', () => {
    assert.throws(() => assertMongoUri('mongodb+srv://u:p@cluster.example.net/?retryWrites=true'), /database name/);
    assert.throws(() => assertMongoUri('mongodb+srv://u:p@cluster.example.net'), /database name/);
  });

  it('returns the database name for a valid URI', () => {
    assert.equal(assertMongoUri(validConfig.mongoUri), 'vridhio');
    assert.equal(assertMongoUri('mongodb://127.0.0.1:27017/vridhio_test'), 'vridhio_test');
  });

  it('never includes credentials in validation errors', () => {
    try {
      assertMongoUri('mongodb+srv://user:SuperSecretPass@cluster.example.net/?x=1');
      assert.fail('expected an error');
    } catch (err) {
      assert.doesNotMatch(err.message, /SuperSecretPass/);
    }
  });
});

describe('environment validation', () => {
  it('accepts a complete configuration', () => {
    assert.deepEqual(getEnvErrors(validConfig), []);
  });

  it('reports a missing MONGO_URI and JWT secret', () => {
    const errors = getEnvErrors({ ...validConfig, mongoUri: undefined, jwtSecret: undefined });
    assert.ok(errors.some((e) => e.includes('MONGO_URI')));
    assert.ok(errors.some((e) => e.includes('JWT_SECRET_KEY')));
  });

  it('rejects a weak JWT secret without echoing it', () => {
    const errors = getEnvErrors({ ...validConfig, jwtSecret: 'MY_PRIVATE_KEY' });
    assert.equal(errors.length, 1);
    assert.doesNotMatch(errors[0], /MY_PRIVATE_KEY/);
  });

  it('rejects wildcard CORS origins', () => {
    const errors = getEnvErrors({ ...validConfig, corsOrigins: ['*'] });
    assert.ok(errors.some((e) => e.includes('CORS_ORIGINS')));
  });
});
