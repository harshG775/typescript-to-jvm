import { readFileSync } from 'node:fs';
import type { HirProgram } from './hir.ts';
import { compileSourceToHir } from './lower-ts-to-hir.ts';
import type { ClassResolver } from './type-registry.ts';

export { compileSourceToHir };

export function compileFileToHir(filePath: string, classes: ClassResolver, classPrefix?: string): HirProgram {
    return compileSourceToHir(readFileSync(filePath, 'utf8'), {
        classes,
        fileName: filePath,
        ...(classPrefix === undefined ? {} : { classPrefix }),
    });
}
