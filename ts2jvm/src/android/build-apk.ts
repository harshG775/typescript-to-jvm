import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Acc, ClassWriter } from '../classfile/index.ts';
import { compileFileToClasses, writeClassFiles } from '../compile.ts';
import { d8, findAndroidSdk, run } from './sdk.ts';

export interface ApkOptions {
    /** TypeScript file. It must define `function main(): void`, which runs when the activity opens. */
    tsFile: string;
    outFile: string;
    /** Android application id. */
    packageName?: string;
}

const ACTIVITY = 'android/app/Activity';
const TEXT_VIEW = 'android/widget/TextView';

/**
 * Builds the one class Android needs that TypeScript can't express yet: an Activity whose onCreate
 * calls the compiled `Main.main()` and shows a line of text.
 */
function buildActivity(className: string): Uint8Array {
    const cw = new ClassWriter(className, { superName: ACTIVITY });
    cw.addMethod(Acc.PUBLIC, '<init>', '()V', (c) => {
        c.load('a', 0);
        c.invokespecial(ACTIVITY, '<init>', '()V');
        c.op('return');
    });
    cw.addMethod(Acc.PUBLIC, 'onCreate', '(Landroid/os/Bundle;)V', (c) => {
        c.load('a', 0);
        c.load('a', 1);
        c.invokespecial(ACTIVITY, 'onCreate', '(Landroid/os/Bundle;)V');
        c.invokestatic('Main', 'main', '()V');

        const view = c.newLocal('a');
        c.newObject(TEXT_VIEW);
        c.op('dup');
        c.load('a', 0);
        c.invokespecial(TEXT_VIEW, '<init>', '(Landroid/content/Context;)V');
        c.store('a', view);
        c.load('a', view);
        c.pushString('main() ran: TypeScript compiled to JVM bytecode, no JS runtime');
        c.invokevirtual(TEXT_VIEW, 'setText', '(Ljava/lang/CharSequence;)V');
        c.load('a', 0);
        c.load('a', view);
        c.invokevirtual(ACTIVITY, 'setContentView', '(Landroid/view/View;)V');
        c.op('return');
    });
    return cw.toBytes();
}

function manifest(pkg: string): string {
    return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${pkg}">
  <application android:label="ts2jvm">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`;
}

/** TypeScript file -> signed, installable debug APK. Throws if the Android SDK isn't found. */
export function buildApk(opts: ApkOptions): void {
    const sdk = findAndroidSdk();
    if (!sdk) throw new Error('Android SDK not found: set ANDROID_HOME (needs build-tools and a platform)');
    const pkg = opts.packageName ?? 'com.example.ts2jvm';
    const work = mkdtempSync(join(tmpdir(), 'ts2jvm-apk-'));
    const classes = join(work, 'classes');
    const activityPath = `${pkg.replaceAll('.', '/')}/MainActivity`;

    // 1. TypeScript -> Main.class (+ one class per TS class), plus the Activity stub.
    const files = writeClassFiles(compileFileToClasses(opts.tsFile, 'Main'), classes);
    files.push(...writeClassFiles([{ name: activityPath, bytes: buildActivity(activityPath) }], classes));

    // 2. D8: class files -> classes.dex.
    const dex = join(work, 'dex');
    mkdirSync(dex);
    d8(sdk, files, dex);

    // 3. aapt2: manifest -> APK skeleton, then add the dex.
    const manifestPath = join(work, 'AndroidManifest.xml');
    writeFileSync(manifestPath, manifest(pkg));
    const unsigned = join(work, 'unsigned.apk');
    run(sdk.aapt2, [
        'link',
        '-o',
        unsigned,
        '-I',
        sdk.androidJar,
        '--manifest',
        manifestPath,
        '--min-sdk-version',
        '24',
        '--target-sdk-version',
        '34',
    ]);
    run('jar', ['--update', '--file', unsigned, '-C', dex, 'classes.dex']);

    // 4. zipalign + sign with the Android Studio debug key (created if missing).
    const aligned = join(work, 'aligned.apk');
    run(sdk.zipalign, ['-f', '4', unsigned, aligned]);
    const keystore = debugKeystore(work);
    mkdirSync(dirname(opts.outFile), { recursive: true });
    run('java', [
        '-jar',
        sdk.apksignerJar,
        'sign',
        '--ks',
        keystore,
        '--ks-pass',
        'pass:android',
        '--key-pass',
        'pass:android',
        '--out',
        opts.outFile,
        aligned,
    ]);
    run('java', ['-jar', sdk.apksignerJar, 'verify', opts.outFile]);
}

function debugKeystore(work: string): string {
    const existing = join(homedir(), '.android', 'debug.keystore');
    if (existsSync(existing)) return existing;
    const created = join(work, 'debug.keystore');
    run('keytool', [
        '-genkeypair',
        '-keystore',
        created,
        '-storepass',
        'android',
        '-keypass',
        'android',
        '-alias',
        'androiddebugkey',
        '-keyalg',
        'RSA',
        '-keysize',
        '2048',
        '-validity',
        '10000',
        '-dname',
        'CN=Android Debug,O=Android,C=US',
    ]);
    return created;
}
