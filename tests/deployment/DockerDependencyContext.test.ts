import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('Docker dependency context', () => {
  it('installs registry dependencies from the locked manifest in both stages', async () => {
    const dockerignore = await readFile(
      resolve(repositoryRoot, '.dockerignore'),
      'utf8',
    );
    const dockerfile = await readFile(
      resolve(repositoryRoot, 'deploy/Dockerfile'),
      'utf8',
    );

    assert.doesNotMatch(dockerignore, /^!vendor(?:\/|$)/mu);
    assert.match(dockerignore, /^!\.env\.example$/m);
    assert.match(dockerignore, /^!\.env\.migration\.example$/m);
    assert.match(
      dockerfile,
      /FROM .* AS build[\s\S]*COPY \.npmrc package-lock\.json package\.json \.\/[\s\S]*RUN npm ci/,
    );
    assert.match(
      dockerfile,
      /FROM .* AS production-dependencies[\s\S]*COPY \.npmrc package-lock\.json package\.json \.\/[\s\S]*RUN npm ci --omit=dev/,
    );
    assert.doesNotMatch(dockerfile, /^COPY vendor\b/mu);
    assert.match(
      dockerfile,
      /FROM .* AS build[\s\S]*COPY \.env\.example \.env\.migration\.example \.\//,
    );
  });

  it('installs Git in the shared runtime before dropping privileges', async () => {
    const dockerfile = await readFile(
      resolve(repositoryRoot, 'deploy/Dockerfile'),
      'utf8',
    );

    assert.match(
      dockerfile,
      /ARG GIT_PACKAGE_VERSION=1:2\.39\.5-0\+deb12u3/,
    );
    assert.match(
      dockerfile,
      /FROM .* AS runtime[\s\S]*apt-get install[^\n]*git=\$\{GIT_PACKAGE_VERSION\}[\s\S]*USER 10001:10001/,
    );
    assert.doesNotMatch(
      dockerfile,
      /USER 10001:10001[\s\S]*apt-get install/,
    );
  });
});
