import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  collabCloudCapabilityDocument,
  matchCollabCloudRoute,
  type CollabCloudCapability,
  type CollabCloudCapabilityDocument,
  type CollabCloudCapabilityLimits,
} from '@claudian/collab-protocol';

export interface CloudCapabilitiesRouteOptions {
  readonly enabledCapabilities: ReadonlySet<CollabCloudCapability>;
  readonly limits: CollabCloudCapabilityLimits;
}

export class CloudCapabilitiesRoute {
  readonly #document: CollabCloudCapabilityDocument;

  constructor(options: CloudCapabilitiesRouteOptions) {
    this.#document = collabCloudCapabilityDocument(
      [...options.enabledCapabilities],
      options.limits,
    );
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const match = matchCollabCloudRoute(
      request.method ?? '',
      request.url ?? '',
    );
    if (match?.kind !== 'capabilities') return false;
    const encoded = JSON.stringify(this.#document);
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(encoded),
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(encoded);
    return true;
  }
}
