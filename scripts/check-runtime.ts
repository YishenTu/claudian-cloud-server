import process from 'node:process';

import { assertSupportedNodeVersion } from '../src/config/RuntimeVersion.js';

try {
  assertSupportedNodeVersion();
} catch {
  process.stderr.write('Node.js 24 is required; activate the version in .node-version.\n');
  process.exitCode = 1;
}
