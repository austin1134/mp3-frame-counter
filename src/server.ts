import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Express } from 'express';
import {
  DEFAULT_SERVER_TIMEOUTS,
  readConfig,
  type ServerTimeouts,
} from './config.js';
import { createApp } from './http/app.js';

/** Import-safe server construction also lets socket tests use ephemeral ports. */
export function createHttpServer(
  app: Express,
  overrides: Partial<ServerTimeouts> = {},
): Server {
  const timeouts = { ...DEFAULT_SERVER_TIMEOUTS, ...overrides };
  const server = createServer(
    {
      requestTimeout: timeouts.requestTimeoutMs,
      headersTimeout: Math.min(
        timeouts.headersTimeoutMs,
        timeouts.requestTimeoutMs,
      ),
      // Node checks request deadlines periodically; keep short configured deadlines useful.
      connectionsCheckingInterval: Math.min(1000, timeouts.requestTimeoutMs),
    },
    app,
  );
  server.setTimeout(timeouts.idleTimeoutMs, (socket) => socket.destroy());
  return server;
}

/** Stop admission, drain active responses, and bound shutdown even for stalled clients. */
export function shutdownServer(
  server: Server,
  graceMs = 10_000,
): Promise<void> {
  return new Promise((resolveShutdown, rejectShutdown) => {
    const deadline = setTimeout(() => server.closeAllConnections(), graceMs);
    deadline.unref();
    server.close((error) => {
      clearTimeout(deadline);
      if (error) rejectShutdown(error);
      else resolveShutdown();
    });
    server.closeIdleConnections();
  });
}

function logFailure(error: unknown): void {
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'application_error',
      message: error instanceof Error ? error.message : 'Unknown failure',
      stack: error instanceof Error ? error.stack : undefined,
    }),
  );
}

function main(): void {
  try {
    const config = readConfig();
    const app = createApp(config, logFailure);
    const server = createHttpServer(app, config);
    let stopping = false;

    const stop = (): void => {
      if (stopping) return;
      stopping = true;
      console.info(JSON.stringify({ level: 'info', event: 'shutdown' }));
      void shutdownServer(server).catch((error: unknown) => {
        logFailure(error);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('error', (error) => {
      logFailure(error);
      process.exitCode = 1;
    });
    server.listen(config.port, config.host, () => {
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'listening',
          host: config.host,
          port: config.port,
        }),
      );
    });
  } catch (error: unknown) {
    logFailure(error);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  main();
}
