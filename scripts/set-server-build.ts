import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';

const revision = process.env.CLAUDIAN_SERVER_BUILD;

if (revision === undefined || !/^[0-9a-f]{40}$/u.test(revision)) {
  process.stderr.write('server build identity is invalid\n');
  process.exitCode = 1;
} else {
  await writeFile(
    resolve(import.meta.dirname, '../src/config/ServerBuildIdentity.ts'),
    `/** Generated from the immutable production image revision. */\nexport const SERVER_BUILD_IDENTITY = '${revision}';\n`,
    { encoding: 'utf8' },
  );
}
