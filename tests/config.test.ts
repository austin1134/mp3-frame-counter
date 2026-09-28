import { describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';

describe('startup configuration', () => {
  it('uses loopback binding and explicit byte/time limits by default', () => {
    expect(readConfig({})).toEqual({
      host: '127.0.0.1',
      port: 3000,
      maxFileBytes: 104_857_600,
      maxRequestBytes: 104_923_136,
      requestTimeoutMs: 120_000,
      headersTimeoutMs: 30_000,
      idleTimeoutMs: 30_000,
    });
  });

  it('accepts explicit settings and keeps headers within the request deadline', () => {
    expect(
      readConfig({
        HOST: '::1',
        PORT: '8080',
        MAX_UPLOAD_BYTES: '1024',
        REQUEST_TIMEOUT_MS: '5000',
      }),
    ).toMatchObject({
      host: '::1',
      port: 8080,
      maxFileBytes: 1024,
      maxRequestBytes: 66_560,
      requestTimeoutMs: 5000,
      headersTimeoutMs: 5000,
    });
  });

  it.each(['', '0', '-1', '1.5', '12ms', ' 3000', '3e3', '03000'])(
    'rejects ambiguous/non-positive port %j before listening',
    (PORT) => {
      expect(() => readConfig({ PORT })).toThrow('PORT');
    },
  );

  it.each([
    { PORT: '65536' },
    { MAX_UPLOAD_BYTES: '9007199254740992' },
    { MAX_UPLOAD_BYTES: String(Number.MAX_SAFE_INTEGER) },
    { REQUEST_TIMEOUT_MS: '2147483648' },
  ])('rejects values beyond supported numeric limits: %j', (env) => {
    expect(() => readConfig(env)).toThrow('must not exceed');
  });

  it.each(['', 'bad host', 'http://localhost', '\nlocalhost'])(
    'rejects invalid host %j',
    (HOST) => {
      expect(() => readConfig({ HOST })).toThrow('HOST');
    },
  );
});
