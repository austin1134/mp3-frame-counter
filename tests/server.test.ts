import { once } from 'node:events';
import {
  request as httpRequest,
  type ClientRequest,
  type Server,
} from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerTimeouts } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { createHttpServer, shutdownServer } from '../src/server.js';
import { defaultFrame } from './helpers/mp3-fixtures.js';

const servers = new Set<Server>();
const clients = new Set<ClientRequest>();

function managedServer(timeouts: Partial<ServerTimeouts> = {}): Server {
  const server = createHttpServer(createApp(), timeouts);
  servers.add(server);
  return server;
}

afterEach(async () => {
  for (const client of clients) client.destroy();
  clients.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (
              error &&
              (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')
            )
              reject(error);
            else resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
  servers.clear();
});

describe('server lifecycle', () => {
  it('constructs without listening and applies explicit timeouts', async () => {
    const server = managedServer({
      requestTimeoutMs: 1000,
      headersTimeoutMs: 2000,
      idleTimeoutMs: 500,
    });
    expect(server.listening).toBe(false);
    expect(server.requestTimeout).toBe(1000);
    expect(server.headersTimeout).toBe(1000);
    expect(server.timeout).toBe(500);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await shutdownServer(server);
    expect(server.listening).toBe(false);
  });

  it('closes stalled connections after the shutdown grace period', async () => {
    const server = managedServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    // Observe the server accepting the request, not just the client connecting.
    const accepted = once(server, 'request');
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/file-upload',
      headers: { 'Content-Type': 'multipart/form-data; boundary=stalled' },
    });
    clients.add(request);
    // The peer intentionally keeps the body open; cleanup must not depend on its EOF.
    request.on('error', () => undefined);
    const closed = new Promise<void>((resolveClosed) =>
      request.once('close', () => resolveClosed()),
    );
    request.flushHeaders();
    await accepted;
    await shutdownServer(server, 20);
    await closed;
    expect(server.listening).toBe(false);
  });

  it('lets an accepted upload finish successfully during the shutdown grace period', async () => {
    const server = managedServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');

    const boundary = 'graceful-upload';
    const frame = Buffer.from(defaultFrame());
    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    );
    const accepted = once(server, 'request');
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/file-upload',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    });
    clients.add(request);
    const received = new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        request.once('error', reject);
        request.once('response', (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        });
      },
    );

    const drained = accepted.then(async () => {
      // Start shutdown while the HTTP body is incomplete, then finish the same
      // admitted upload. Immediate forced closure would fail its response.
      const shutdown = shutdownServer(server, 1000);
      request.end(
        Buffer.concat([
          frame.subarray(100),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
      );
      await shutdown;
    });
    request.write(Buffer.concat([header, frame.subarray(0, 100)]));

    // Observe both promises immediately so an early socket failure is handled.
    const [response] = await Promise.all([received, drained]);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body) as unknown).toEqual({ frameCount: 1 });
    expect(server.listening).toBe(false);
  });
});
