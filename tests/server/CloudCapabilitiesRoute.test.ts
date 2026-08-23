import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import {
  COLLAB_CLOUD_BINDING_LIMITS,
  COLLAB_LIMITS,
  collabCloudCapabilityDocument,
} from '@claudian-collab/protocol';

import { CloudCapabilitiesRoute } from '../../src/server/CloudCapabilitiesRoute.js';

const servers = new Set<ReturnType<typeof createServer>>();

afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
  })));
  servers.clear();
});

const limits = {
  maxDevelopmentBootstrapGitBundleBytes: 1024,
  maxDevelopmentBootstrapManifestUtf8Bytes:
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapManifestUtf8Bytes,
  maxDevelopmentBootstrapReportUtf8Bytes:
    COLLAB_CLOUD_BINDING_LIMITS.maxDevelopmentBootstrapReportUtf8Bytes,
  maxEventReplay: COLLAB_CLOUD_BINDING_LIMITS.maxEventReplay,
  maxGitReceivePackBytes: COLLAB_CLOUD_BINDING_LIMITS.maxGitReceivePackBytes,
  maxJsonPayloadUtf8Bytes: COLLAB_LIMITS.maxJsonPayloadUtf8Bytes,
  maxRepositoryBytes: 2048,
} as const;

async function request(route: CloudCapabilitiesRoute, target: string) {
  const server = createServer((incoming, response) => {
    if (!route.handle(incoming, response)) {
      response.writeHead(404);
      response.end();
    }
  });
  servers.add(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const response = await fetch(`http://127.0.0.1:${String(address.port)}${target}`);
  const body = await response.text();
  return {
    response,
    value: body.length === 0 ? undefined : JSON.parse(body) as unknown,
  };
}

describe('CloudCapabilitiesRoute', () => {
  it('renders only the package schema and currently enabled token set', async () => {
    const disabled = new CloudCapabilitiesRoute({
      enabledCapabilities: new Set(),
      limits,
    });
    assert.deepEqual(
      (await request(disabled, '/collab/capabilities')).value,
      collabCloudCapabilityDocument([], limits),
    );

    const enabled = new CloudCapabilitiesRoute({
      enabledCapabilities: new Set(['development-bootstrap']),
      limits,
    });
    const result = await request(enabled, '/collab/capabilities');
    assert.equal(result.response.status, 200);
    assert.deepEqual(
      result.value,
      collabCloudCapabilityDocument(['development-bootstrap'], limits),
    );
  });

  it('does not accept a noncanonical path or method', async () => {
    const route = new CloudCapabilitiesRoute({
      enabledCapabilities: new Set(),
      limits,
    });
    assert.equal((await request(route, '/collab/capabilities?extra=1')).response.status, 404);
  });
});
