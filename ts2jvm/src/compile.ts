import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { findAndroidSdk } from './android/sdk.ts';
import { JarClassResolver } from './android/jar.ts';
import { generateClasses, type ClassFile } from './backend/codegen.ts';
import { builtinResolver, chainResolvers } from './frontend/builtin-classes.ts';
import { compileSourceToHir } from './frontend/compile-file.ts';
import type { ClassResolver } from './frontend/type-registry.ts';
import { lowerHirToLir } from './middle/lower-hir-to-lir.ts';

export type { ClassFile };

export interface CompileOptions {
    fileName: string;
    /**
     * Java package for the generated classes, in dotted form (`com.example.app`). The top-level functions go in
     * `<package>.Main` and each TS class in `<package>.<Name>`. Defaults to the unnamed package.
     */
    package?: string;
    /** Where existing classes (java.*, android.*) come from. Defaults to the Android SDK's android.jar. */
    classes?: ClassResolver;
}

let sdkResolver: ClassResolver | undefined;

/** android.jar if an Android SDK is installed (parsed once per process), else a small built-in table. */
export function defaultClassResolver(): ClassResolver {
    if (!sdkResolver) {
        const sdk = findAndroidSdk();
        sdkResolver = sdk ? chainResolvers(new JarClassResolver(sdk.androidJar), builtinResolver()) : builtinResolver();
    }
    return sdkResolver;
}

/**
 * TypeScript source -> class files: `Main` holds the top-level functions as static methods, and every
 * TS class becomes its own class file.
 */
export function compileSourceToClasses(source: string, opts: CompileOptions): ClassFile[] {
    const prefix = opts.package ? `${opts.package.replaceAll('.', '/')}/` : '';
    const hir = compileSourceToHir(source, {
        classes: opts.classes ?? defaultClassResolver(),
        fileName: opts.fileName,
        classPrefix: prefix,
    });
    const lir = lowerHirToLir(hir, { className: `${prefix}Main` });
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

export function compileFileToClasses(filePath: string, opts: Omit<CompileOptions, 'fileName'> = {}): ClassFile[] {
    return compileSourceToClasses(readFileSync(filePath, 'utf8'), { ...opts, fileName: filePath });
}
