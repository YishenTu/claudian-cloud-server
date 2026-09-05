import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { describe, it } from 'node:test';

import {
  PostgresSchemaError,
  PostgresSchemaInitializer,
} from '../../../src/coordination/postgres/PostgresSchemaInitializer.js';

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('connection-cancellation-did-not-settle')), 1_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function cancelled(error: unknown): boolean {
  assert.ok(error instanceof PostgresSchemaError);
  assert.equal(error.code, 'migration-failed');
  return true;
}

describe('Postgres schema connection cancellation', () => {
  for (const method of ['apply', 'preflight'] as const) {
    it(`${method} rejects cancellation during a silent startup handshake and closes its socket`, async () => {
      const sockets = new Set<Socket>();
      const server = createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });
      const controller = new AbortController();
      try {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        assert.ok(address !== null && typeof address !== 'string');
        const incoming = once(server, 'connection');
        const initializer = new PostgresSchemaInitializer({
          connectionString: `postgresql://claudian_cloud_migration@127.0.0.1:${String(address.port)}/postgres?sslmode=disable`,
        });
        const operation = initializer[method](controller.signal).then(() => undefined);
        const [socket] = await bounded(incoming) as [Socket];
        await bounded(once(socket, 'data'));
        const closed = once(socket, 'close');
        controller.abort();
        await assert.rejects(bounded(operation), cancelled);
        await bounded(closed);
        assert.equal(sockets.size, 0);
      } finally {
        controller.abort();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }

  it('rejects a pre-aborted operation without waiting for a connection', async () => {
    const controller = new AbortController();
    controller.abort();
    const initializer = new PostgresSchemaInitializer({
      connectionString: 'postgresql://claudian_cloud_migration@127.0.0.1:1/postgres?sslmode=disable',
    });
    await assert.rejects(bounded(initializer.apply(controller.signal)), cancelled);
    await assert.rejects(bounded(initializer.preflight(controller.signal)), cancelled);
  });
});
