import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AndroidSdk {
    androidJar: string;
    d8Jar: string;
    apksignerJar: string;
    aapt2: string;
    zipalign: string;
}

/** Locates the Android SDK pieces needed to turn class files into an APK, or returns undefined. */
export function findAndroidSdk(): AndroidSdk | undefined {
    const root =
        process.env['ANDROID_HOME'] ??
        process.env['ANDROID_SDK_ROOT'] ??
        (process.env['LOCALAPPDATA']
            ? join(process.env['LOCALAPPDATA'], 'Android', 'Sdk')
            : join(homedir(), 'Android', 'Sdk'));
    try {
        const exe = process.platform === 'win32' ? '.exe' : '';
        const tools = readdirSync(join(root, 'build-tools'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .reverse()
            .map((t) => join(root, 'build-tools', t));
        const platforms = readdirSync(join(root, 'platforms'))
            .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
            .reverse();

        const tool = tools.find((t) => existsSync(join(t, 'lib', 'd8.jar')) && existsSync(join(t, `aapt2${exe}`)));
        const androidJar = platforms.map((p) => join(root, 'platforms', p, 'android.jar')).find(existsSync);
        if (!tool || !androidJar) return undefined;
        return {
            androidJar,
            d8Jar: join(tool, 'lib', 'd8.jar'),
            apksignerJar: join(tool, 'lib', 'apksigner.jar'),
            aapt2: join(tool, `aapt2${exe}`),
            zipalign: join(tool, `zipalign${exe}`),
        };
    } catch {
        return undefined;
    }
}

/** Runs a command and throws an Error that includes its output on failure. */
export function run(cmd: string, args: string[], cwd?: string): string {
    try {
        return execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe', ...(cwd ? { cwd } : {}) });
    } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message: string };
        const output = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() || err.message;
        throw new Error(`${cmd} ${args.join(' ')}\n${output}`, { cause: e });
    }
}

/** Converts class files to `classes.dex` in `outDir`. */
export function d8(sdk: AndroidSdk, classFiles: string[], outDir: string): void {
    run('java', [
        '-cp',
        sdk.d8Jar,
        'com.android.tools.r8.D8',
        '--lib',
        sdk.androidJar,
        '--min-api',
        '24',
        '--output',
        outDir,
        ...classFiles,
    ]);
}
