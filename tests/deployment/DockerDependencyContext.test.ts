import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '../..');

describe('Docker dependency context', () => {
  it('makes vendored package artifacts available to both npm install stages', async () => {
    const dockerignore = await readFile(
      resolve(repositoryRoot, '.dockerignore'),
      'utf8',
    );
    const dockerfile = await readFile(
      resolve(repositoryRoot, 'deploy/Dockerfile'),
      'utf8',
    );

    assert.match(dockerignore, /^!vendor\/$/m);
    assert.match(dockerignore, /^!vendor\/\*\.tgz$/m);
    assert.match(dockerignore, /^!\.env\.example$/m);
    assert.match(dockerignore, /^!\.env\.migration\.example$/m);
    assert.match(
      dockerfile,
      /FROM .* AS build[\s\S]*COPY vendor \/workspace\/vendor[\s\S]*RUN npm ci/,
    );
    assert.match(
      dockerfile,
      /FROM .* AS production-dependencies[\s\S]*COPY vendor \/app\/vendor[\s\S]*RUN npm ci --omit=dev/,
    );
    assert.match(
      dockerfile,
      /FROM .* AS build[\s\S]*COPY \.env\.example \.env\.migration\.example \.\//,
    );
  });
});
