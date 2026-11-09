import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { buildApk } from '../../src/android/build-apk.ts';
import { findAndroidSdk, run } from '../../src/android/sdk.ts';

const sdk = findAndroidSdk();

describe.skipIf(!sdk)('Android APK', () => {
    it('builds a signed APK from a fixture (TS -> JVM -> D8 -> aapt2 -> apksigner)', () => {
        const out = join(mkdtempSync(join(tmpdir(), 'ts2jvm-test-')), 'app.apk');
        buildApk({ tsFile: join(import.meta.dirname, 'fixtures', 'app.ts'), outFile: out });
        expect(existsSync(out)).toBe(true);

        const badging = run(sdk!.aapt2, ['dump', 'badging', out]);
        expect(badging).toContain("package: name='com.example.ts2jvm'");
        expect(badging).toContain("launchable-activity: name='com.example.ts2jvm.MainActivity'");
        expect(run('jar', ['tf', out])).toContain('classes.dex');
    }, 60_000);
});
