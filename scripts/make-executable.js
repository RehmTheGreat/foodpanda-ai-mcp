// npm sets the executable bit from package.json "bin" on install, but a locally
// built dist/index.js is not executable on POSIX until we chmod it. Windows has
// no concept of the bit, so this is a no-op there.
import { chmodSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'index.js');

if (existsSync(entry) && process.platform !== 'win32') {
  chmodSync(entry, 0o755);
  console.log('chmod 755 dist/index.js');
} else {
  console.log(process.platform === 'win32' ? 'skipped chmod (windows)' : 'dist/index.js not found');
}
