import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const source = resolve(
  repositoryRoot,
  'src/coordination/postgres/CurrentPostgresSchema.sql',
);
const destination = resolve(
  repositoryRoot,
  'dist/coordination/postgres/CurrentPostgresSchema.sql',
);

await mkdir(dirname(destination), { recursive: true });
await cp(source, destination);
