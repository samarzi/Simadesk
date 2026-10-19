import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { transform } from 'esbuild';

async function check(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (entry.name.endsWith('.ts')) {
      await transform(await readFile(path, 'utf8'), { loader: 'ts', sourcefile: path, target: 'es2022' });
    }
  }
}
await check('backend/functions');
console.log('Edge function syntax checked');
