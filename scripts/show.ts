// Usage: node scripts/show.ts <file.ts> [hir|lir]
import { compileFileToHir } from '../src/frontend/compile-file.ts';
import { createDefaultRegistry } from '../src/frontend/type-registry.ts';
import { lowerHirToLir } from '../src/middle/lower-hir-to-lir.ts';

const [file, stage = 'lir'] = process.argv.slice(2);
if (!file) throw new Error('usage: node scripts/show.ts <file.ts> [hir|lir]');

const hir = compileFileToHir(file, createDefaultRegistry());
const out = stage === 'hir' ? hir : lowerHirToLir(hir, { className: 'Main' });
console.log(JSON.stringify(out, null, 2));
