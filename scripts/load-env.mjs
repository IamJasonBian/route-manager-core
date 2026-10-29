// Side-effect import: load the project-root .env into process.env for the
// node booking/scrape scripts (which `npm run` does not auto-load).
// Mirrors scripts/loadEnv.ts but for ESM scripts and silent on success.
import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { join, dirname, parse } from 'node:path';

let dir = process.cwd();
const { root } = parse(dir);
while (dir !== root) {
  if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, '.env'))) {
    dotenv.config({ path: join(dir, '.env') });
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
