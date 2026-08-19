import type {
  IncomingMessage,
  ServerResponse,
} from 'node:http';

export interface HealthRoutesOptions {
  readonly isReady: () => boolean;
}

export class HealthRoutes {
  readonly #isReady: () => boolean;

  constructor(options: HealthRoutesOptions) {
    this.#isReady = options.isReady;
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const path = request.url?.split('?', 1)[0];
    if (request.method === 'GET' && path === '/livez') {
      this.#sendJson(response, 200, { status: 'alive' });
      return true;
    }
    if (request.method === 'GET' && path === '/readyz') {
      const ready = this.#isReady();
      this.#sendJson(response, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not-ready',
      });
      return true;
    }
    return false;
  }

  #sendJson(
    response: ServerResponse,
    statusCode: number,
    body: Readonly<Record<string, string>>,
  ): void {
    const encoded = JSON.stringify(body);
    response.writeHead(statusCode, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(encoded),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
  }
}
