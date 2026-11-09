#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { buildApk } from './android/build-apk.ts';
import { run } from './android/sdk.ts';
import { compileFileToClasses, defaultClassResolver, writeClassFiles } from './compile.ts';
import { compileFileToHir } from './frontend/compile-file.ts';
import { FrontendError } from './frontend/errors.ts';
import { lowerHirToLir } from './middle/lower-hir-to-lir.ts';

const USAGE = `ts2jvm <command> [file.ts]      (file defaults to src/main.ts)

  compile  [--out build/classes] [--package a.b]  write one .class per TS class, plus Main for functions
  show     [--stage hir|lir]                      print an intermediate representation as JSON
  apk      [--out build/app.apk] [--package id] [--install]
                                                  build a signed debug APK; file must define main()`;

function main(argv: string[]): void {
    const { values, positionals } = parseArgs({
        args: argv,
        allowPositionals: true,
        options: {
            out: { type: 'string' },
            stage: { type: 'string' },
            package: { type: 'string' },
            install: { type: 'boolean' },
        },
    });
    const [command, file = 'src/main.ts'] = positionals;

    switch (command) {
        case 'compile': {
            const paths = writeClassFiles(
                compileFileToClasses(file, values.package ? { package: values.package } : {}),
                values.out ?? 'build/classes',
            );
            for (const p of paths) console.log(`wrote ${p}`);
            return;
        }
        case 'show': {
            const hir = compileFileToHir(file, defaultClassResolver());
            const ir = (values.stage ?? 'lir') === 'hir' ? hir : lowerHirToLir(hir, { className: 'Main' });
            console.log(JSON.stringify(ir, null, 2));
            return;
        }
        case 'apk': {
            const outFile = values.out ?? 'build/app.apk';
            buildApk({ tsFile: file, outFile, ...(values.package ? { packageName: values.package } : {}) });
            console.log(`wrote ${outFile}`);
            if (values.install) console.log(run('adb', ['install', '-r', outFile]).trim());
            return;
        }
        default:
            console.error(USAGE);
            process.exitCode = command ? 1 : 0;
    }
}

try {
    main(process.argv.slice(2));
} catch (e) {
    if (e instanceof FrontendError) {
        console.error(e.message);
        process.exit(1);
    }
    throw e;
}
