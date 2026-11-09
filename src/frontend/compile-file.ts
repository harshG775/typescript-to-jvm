import { readFileSync } from 'node:fs';
import type { HirProgram } from './hir.ts';
import { compileSourceToHir } from './lower-ts-to-hir.ts';
import type { ForeignClassInfo } from './type-registry.ts';

export { compileSourceToHir };

export function compileFileToHir(filePath: string, registry: Map<string, ForeignClassInfo>): HirProgram {
  return compileSourceToHir(readFileSync(filePath, 'utf8'), { registry, fileName: filePath });
}
