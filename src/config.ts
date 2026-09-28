const MEBIBYTE = 1024 * 1024;
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface UploadLimits {
  maxFileBytes: number;
  maxRequestBytes: number;
}

export interface ServerTimeouts {
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
}

export interface AppConfig extends UploadLimits, ServerTimeouts {
  host: string;
  port: number;
}

export const DEFAULT_UPLOAD_LIMITS: Readonly<UploadLimits> = {
  maxFileBytes: 100 * MEBIBYTE,
  maxRequestBytes: 100 * MEBIBYTE + MULTIPART_OVERHEAD_BYTES,
};

export const DEFAULT_SERVER_TIMEOUTS: Readonly<ServerTimeouts> = {
  requestTimeoutMs: 120_000,
  headersTimeoutMs: 30_000,
  idleTimeoutMs: 30_000,
};

function positiveInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}.`);
  }
  return parsed;
}

/** Read configuration once, failing before listening rather than during an upload. */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const host = env['HOST'] ?? '127.0.0.1';
  if (host.length === 0 || /\s|\//.test(host)) {
    throw new Error(
      'HOST must be a hostname or IP address without whitespace.',
    );
  }
  const maxFileBytes = positiveInteger(
    'MAX_UPLOAD_BYTES',
    env['MAX_UPLOAD_BYTES'],
    DEFAULT_UPLOAD_LIMITS.maxFileBytes,
    Number.MAX_SAFE_INTEGER - MULTIPART_OVERHEAD_BYTES,
  );
  const requestTimeoutMs = positiveInteger(
    'REQUEST_TIMEOUT_MS',
    env['REQUEST_TIMEOUT_MS'],
    DEFAULT_SERVER_TIMEOUTS.requestTimeoutMs,
    2_147_483_647,
  );
  return {
    host,
    port: positiveInteger('PORT', env['PORT'], 3000, 65_535),
    maxFileBytes,
    maxRequestBytes: maxFileBytes + MULTIPART_OVERHEAD_BYTES,
    requestTimeoutMs,
    // Node requires the header deadline to be no greater than the request deadline.
    headersTimeoutMs: Math.min(
      DEFAULT_SERVER_TIMEOUTS.headersTimeoutMs,
      requestTimeoutMs,
    ),
    idleTimeoutMs: DEFAULT_SERVER_TIMEOUTS.idleTimeoutMs,
  };
}
