import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateClasses, type ClassFile } from './backend/codegen.ts';
import { compileSourceToHir } from './frontend/compile-file.ts';
import { createDefaultRegistry } from './frontend/type-registry.ts';
import { lowerHirToLir } from './middle/lower-hir-to-lir.ts';

export type { ClassFile };

export interface CompileOptions {
    fileName: string;
    /** JVM internal name of the generated class, e.g. `app/Main`. Defaults to `Main`. */
    className?: string;
}

/**
 * TypeScript source -> class files: `Main` (or `opts.className`) holds the top-level functions as static
 * methods, and every TS class becomes its own class file.
 */
export function compileSourceToClasses(source: string, opts: CompileOptions): ClassFile[] {
    const hir = compileSourceToHir(source, { registry: createDefaultRegistry(), fileName: opts.fileName });
    const lir = lowerHirToLir(hir, { className: opts.className ?? 'Main' });
    return generateClasses(lir, { sourceFile: opts.fileName.split(/[\\/]/).pop()! });
}

/** Writes each class to `<outDir>/<name>.class` and returns the paths. */
export function writeClassFiles(files: ClassFile[], outDir: string): string[] {
    return files.map((f) => {
        const path = join(outDir, `${f.name}.class`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.bytes);
        return path;
    });
}

export function compileFileToClasses(filePath: string, className?: string): ClassFile[] {
    return compileSourceToClasses(
        readFileSync(filePath, 'utf8'),
        className === undefined ? { fileName: filePath } : { fileName: filePath, className },
    );
}
