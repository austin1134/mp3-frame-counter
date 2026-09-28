import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { createHttpServer, shutdownServer } from '../src/server.js';

describe('server lifecycle', () => {
  it('constructs without listening and applies explicit timeouts', async () => {
    const server = createHttpServer(createApp(), {
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
    const server = createHttpServer(createApp());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const request = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      method: 'POST',
      path: '/file-upload',
      headers: { 'Content-Type': 'multipart/form-data; boundary=stalled' },
    });
    // The peer intentionally keeps the body open; cleanup must not depend on its EOF.
    request.on('error', () => undefined);
    request.flushHeaders();
    const socket = (await once(request, 'socket'))[0] as Socket;
    await once(socket, 'connect');
    const closed = new Promise<void>((resolveClosed) =>
      request.once('close', () => resolveClosed()),
    );
    await shutdownServer(server, 20);
    await closed;
    expect(server.listening).toBe(false);
  });
});
