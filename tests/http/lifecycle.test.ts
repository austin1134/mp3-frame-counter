import { once } from 'node:events';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import type { ServerTimeouts, UploadLimits } from '../../src/config.js';
import { createApp } from '../../src/http/app.js';
import { createHttpServer } from '../../src/server.js';
import { defaultFrame } from '../helpers/mp3-fixtures.js';

const boundary = 'frame-counter-test-boundary';
const fileHeader = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
);
const closingBoundary = Buffer.from(`\r\n--${boundary}--\r\n`);
const frame = (): Buffer => Buffer.from(defaultFrame());
const servers = new Set<Server>();

interface HttpResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

async function startServer(
  limits: Partial<UploadLimits> = {},
  timeouts: Partial<ServerTimeouts> = {},
): Promise<Server> {
  const server = createHttpServer(createApp(limits), timeouts);
  servers.add(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

function openUpload(
  server: Server,
  contentType = `multipart/form-data; boundary=${boundary}`,
): { upload: ClientRequest; result: Promise<HttpResult> } {
  const address = server.address() as AddressInfo;
  let upload: ClientRequest;
  const result = new Promise<HttpResult>((resolve, reject) => {
    upload = httpRequest(
      {
        host: '127.0.0.1',
        port: address.port,
        path: '/file-upload',
        method: 'POST',
        headers: { 'Content-Type': contentType },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.once('error', reject);
        response.once('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    upload.once('error', reject);
  });
  // httpRequest initializes the handle synchronously inside the executor.
  return { upload: upload!, result };
}

async function writeChunk(upload: ClientRequest, chunk: Buffer): Promise<void> {
  if (!upload.write(chunk)) await once(upload, 'drain');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function expectServerStillWorks(server: Server): Promise<void> {
  const response = await request(server)
    .post('/file-upload')
    .attach('file', frame(), 'sample.mp3');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ frameCount: 1 });
}

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
});

describe('multipart and socket lifetime', () => {
  it('waits for the complete form even after the file has ended', async () => {
    const server = await startServer();
    const exchange = openUpload(server);
    let responded = false;
    void exchange.result.then(
      () => {
        responded = true;
      },
      () => {
        responded = true;
      },
    );

    exchange.upload.write(
      Buffer.concat([fileHeader, frame(), Buffer.from(`\r\n--${boundary}`)]),
    );
    await delay(40);
    expect(responded).toBe(false);

    exchange.upload.end('--\r\n');
    const result = await exchange.result;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ frameCount: 1 });
    await expectServerStillWorks(server);
  });

  it('rejects a missing final boundary after a valid complete frame', async () => {
    const server = await startServer();
    const exchange = openUpload(server);
    exchange.upload.end(Buffer.concat([fileHeader, frame()]));

    const result = await exchange.result;
    expect(result.status).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({
      error: { code: 'INVALID_MULTIPART' },
    });
    await expectServerStillWorks(server);
  });

  it('accepts a chunked upload whose frame header crosses network writes', async () => {
    const server = await startServer();
    const exchange = openUpload(server);
    await writeChunk(exchange.upload, fileHeader);
    for (const byte of frame())
      await writeChunk(exchange.upload, Buffer.from([byte]));
    exchange.upload.end(closingBoundary);

    const result = await exchange.result;
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe(
      'application/json; charset=utf-8',
    );
    expect(JSON.parse(result.body)).toEqual({ frameCount: 1 });
  });

  it('accepts a request exactly at its total byte limit', async () => {
    const body = Buffer.concat([fileHeader, frame(), closingBoundary]);
    const server = await startServer({
      maxFileBytes: 417,
      maxRequestBytes: body.byteLength,
    });
    const exchange = openUpload(server);
    exchange.upload.end(body);

    const result = await exchange.result;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ frameCount: 1 });
  });

  it.each(['preamble', 'epilogue'])(
    'bounds oversized multipart %s on chunked requests',
    async (location) => {
      const server = await startServer({
        maxFileBytes: 417,
        maxRequestBytes: 700,
      });
      const exchange = openUpload(server);
      const body = Buffer.concat([fileHeader, frame(), closingBoundary]);
      exchange.upload.end(
        location === 'preamble'
          ? Buffer.concat([Buffer.alloc(1024, 0x61), body])
          : Buffer.concat([body, Buffer.alloc(1024, 0x61)]),
      );

      const result = await exchange.result;
      expect(result.status).toBe(413);
      expect(JSON.parse(result.body)).toMatchObject({
        error: { code: 'REQUEST_TOO_LARGE' },
      });
      await expectServerStillWorks(server);
    },
  );

  it('closes an oversized upload without waiting for the sender to finish', async () => {
    const server = await startServer({
      maxFileBytes: 417,
      maxRequestBytes: 2048,
    });
    const exchange = openUpload(server);
    exchange.upload.write(
      Buffer.concat([fileHeader, frame(), Buffer.from([0])]),
    );

    const result = await exchange.result;
    expect(result.status).toBe(413);
    expect(result.headers['connection']).toBe('close');
    expect(JSON.parse(result.body)).toMatchObject({
      error: { code: 'FILE_TOO_LARGE' },
    });
    exchange.upload.destroy();
    await expectServerStillWorks(server);
  });

  it('cleans up when the client disconnects during a file', async () => {
    const server = await startServer();
    const exchange = openUpload(server);
    const rejected = expect(exchange.result).rejects.toThrow();
    exchange.upload.write(
      Buffer.concat([fileHeader, frame().subarray(0, 100)]),
    );
    await delay(30);
    exchange.upload.destroy();

    await rejected;
    await expectServerStillWorks(server);
  });

  it('cleans up a stalled upload after the socket inactivity timeout', async () => {
    const server = await startServer({}, { idleTimeoutMs: 60 });
    const exchange = openUpload(server);
    const rejected = expect(exchange.result).rejects.toThrow();
    exchange.upload.write(
      Buffer.concat([fileHeader, frame().subarray(0, 100)]),
    );

    await rejected;
    await expectServerStillWorks(server);
  });

  it('enforces the total request deadline even while bytes keep arriving', async () => {
    const server = await startServer(
      {},
      { requestTimeoutMs: 80, headersTimeoutMs: 80, idleTimeoutMs: 1000 },
    );
    const exchange = openUpload(server);
    exchange.upload.write(
      Buffer.concat([fileHeader, frame().subarray(0, 100)]),
    );
    const keepAlive = setInterval(
      () => exchange.upload.write(Buffer.from([0])),
      15,
    );
    try {
      const outcome = await exchange.result.then(
        (result) => ({ kind: 'response' as const, status: result.status }),
        (error: unknown) => ({ kind: 'disconnect' as const, error }),
      );
      // Node owns this transport response. A sender still writing may observe
      // the connection reset before the native 408 response reaches it.
      if (outcome.kind === 'response') expect(outcome.status).toBe(408);
      else expect(outcome.error).toMatchObject({ code: 'ECONNRESET' });
    } finally {
      clearInterval(keepAlive);
      exchange.upload.destroy();
    }
    await expectServerStillWorks(server);
  });

  it('streams many frames through a backpressured client without buffering the upload in the app', async () => {
    const server = await startServer();
    const exchange = openUpload(server);
    const block = Buffer.concat(Array.from({ length: 100 }, frame));
    await writeChunk(exchange.upload, fileHeader);
    for (let index = 0; index < 100; index += 1)
      await writeChunk(exchange.upload, block);
    exchange.upload.end(closingBoundary);

    const result = await exchange.result;
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ frameCount: 10_000 });
  });
});
