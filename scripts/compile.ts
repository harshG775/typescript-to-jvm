// Usage: node scripts/compile.ts <file.ts> <outDir> [ClassName]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compileFileToClass } from '../src/compile.ts';
import { FrontendError } from '../src/frontend/errors.ts';

const [file, outDir, className = 'Main'] = process.argv.slice(2);
if (!file || !outDir) throw new Error('usage: node scripts/compile.ts <file.ts> <outDir> [ClassName]');

try {
  const out = join(outDir, `${className}.class`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, compileFileToClass(file, className));
  console.log(`wrote ${out}`);
} catch (e) {
  if (e instanceof FrontendError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}
