#!/usr/bin/env node
// Cross-platform test runner. Walks a directory for `.test.ts` files and
// runs them under tsx via Node's built-in test runner. Avoids relying on
// shell glob expansion (PowerShell does not expand `*.test.ts`).

import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..', '..');
const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/test.mjs <directory>');
  process.exit(2);
}

const dir = resolve(here, target);
const files = walk(dir).filter((f) => f.endsWith('.test.ts'));
if (files.length === 0) {
  console.error(`No .test.ts files found under ${dir}`);
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' }
);
process.exit(result.status ?? 1);

function walk(d) {
  const out = [];
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
