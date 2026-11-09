import { readFileSync } from 'node:fs';
import { generateClass } from './backend/codegen.ts';
import { compileSourceToHir } from './frontend/compile-file.ts';
import { createDefaultRegistry } from './frontend/type-registry.ts';
import { lowerHirToLir } from './middle/lower-hir-to-lir.ts';

export interface CompileOptions {
  fileName: string;
  /** JVM internal name of the generated class, e.g. `app/Main`. Defaults to `Main`. */
  className?: string;
}

/** TypeScript source -> bytes of one `.class` file whose static methods are the source's functions. */
export function compileSourceToClass(source: string, opts: CompileOptions): Uint8Array {
  const hir = compileSourceToHir(source, { registry: createDefaultRegistry(), fileName: opts.fileName });
  const lir = lowerHirToLir(hir, { className: opts.className ?? 'Main' });
  return generateClass(lir, { sourceFile: opts.fileName.split(/[\\/]/).pop()! });
}

export function compileFileToClass(filePath: string, className?: string): Uint8Array {
  return compileSourceToClass(readFileSync(filePath, 'utf8'), className === undefined ? { fileName: filePath } : { fileName: filePath, className });
}
