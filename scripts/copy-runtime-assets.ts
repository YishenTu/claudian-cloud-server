import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const source = resolve(
  repositoryRoot,
  'src/coordination/postgres/migrations',
);
const destination = resolve(
  repositoryRoot,
  'dist/coordination/postgres/migrations',
);

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
