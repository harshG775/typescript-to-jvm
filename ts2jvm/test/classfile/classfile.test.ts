import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vite-plus/test';
import { Acc, ClassWriter, CodeBuilder, ConstantPool, parseMethodDescriptor } from '../../src/classfile/index.ts';
import { modifiedUtf8 } from '../../src/classfile/constant-pool.ts';

const PUB_STATIC = Acc.PUBLIC | Acc.STATIC;
const PRINTSTREAM = 'java/io/PrintStream';

/** System.out.println(<value pushed by arg>) */
function println(c: CodeBuilder, desc: string, arg: () => void): void {
    c.getstatic('java/lang/System', 'out', `L${PRINTSTREAM};`);
    arg();
    c.invokevirtual(PRINTSTREAM, 'println', `(${desc})V`);
}

function buildDemo(): ClassWriter {
    const cw = new ClassWriter('Demo', { sourceFile: 'Demo.ts' });

    cw.addMethod(PUB_STATIC, 'add', '(DD)D', (c) => {
        c.line(1);
        c.load('d', 0);
        c.load('d', 2);
        c.op('dadd');
        c.op('dreturn');
    });

    cw.addMethod(PUB_STATIC, 'fib', '(I)I', (c) => {
        const a = c.newLocal('i');
        const b = c.newLocal('i');
        const i = c.newLocal('i');
        const t = c.newLocal('i');
        c.pushInt(0);
        c.store('i', a);
        c.pushInt(1);
        c.store('i', b);
        c.pushInt(0);
        c.store('i', i);
        const loop = c.newLabel();
        const end = c.newLabel();
        c.place(loop);
        c.load('i', i);
        c.load('i', 0);
        c.jump('if_icmpge', end);
        c.load('i', a);
        c.load('i', b);
        c.op('iadd');
        c.store('i', t);
        c.load('i', b);
        c.store('i', a);
        c.load('i', t);
        c.store('i', b);
        c.iinc(i, 1);
        c.jump('goto', loop);
        c.place(end);
        c.load('i', a);
        c.op('ireturn');
    });

    cw.addMethod(PUB_STATIC, 'safeDiv', '(II)I', (c) => {
        const start = c.newLabel();
        const end = c.newLabel();
        const handler = c.newLabel();
        c.place(start);
        c.load('i', 0);
        c.load('i', 1);
        c.op('idiv');
        c.op('ireturn');
        c.place(end);
        c.tryCatch(start, end, handler, 'java/lang/ArithmeticException');
        c.placeHandler(handler);
        c.op('pop');
        c.pushInt(-1);
        c.op('ireturn');
    });

    cw.addMethod(PUB_STATIC, 'daysIn', '(I)I', (c) => {
        const [l1, l2, l3, dflt] = [c.newLabel(), c.newLabel(), c.newLabel(), c.newLabel()];
        c.load('i', 0);
        c.tableswitch(1, [l1, l2, l3], dflt);
        for (const [label, value] of [
            [l1, 31],
            [l2, 28],
            [l3, 30],
            [dflt, 0],
        ] as const) {
            c.place(label);
            c.pushInt(value);
            c.op('ireturn');
        }
    });

    cw.addMethod(PUB_STATIC, 'sparse', '(I)I', (c) => {
        const [a, b, d, dflt] = [c.newLabel(), c.newLabel(), c.newLabel(), c.newLabel()];
        c.load('i', 0);
        c.lookupswitch(
            [
                [1000, b],
                [10, a],
                [-5, d],
            ],
            dflt,
        );
        for (const [label, value] of [
            [a, 1],
            [b, 2],
            [d, 3],
            [dflt, 0],
        ] as const) {
            c.place(label);
            c.pushInt(value);
            c.op('ireturn');
        }
    });

    cw.addMethod(PUB_STATIC, 'twice', '(J)J', (c) => {
        c.load('l', 0);
        c.load('l', 0);
        c.op('ladd');
        c.op('lreturn');
    });

    // Pushes enough distinct strings that the pool index exceeds 255 (forces ldc_w).
    cw.addMethod(PUB_STATIC, 'manyStrings', '()I', (c) => {
        for (let i = 0; i < 300; i++) {
            c.pushString(`s${i}`);
            c.op('pop');
        }
        c.pushInt(300);
        c.op('ireturn');
    });

    cw.addMethod(PUB_STATIC, 'consts', '()D', (c) => {
        c.pushInt(100000);
        c.op('i2d');
        c.pushDouble(0.5);
        c.op('dadd');
        c.pushFloat(1.25);
        c.op('f2d');
        c.op('dadd');
        c.pushLong(1n << 40n);
        c.op('l2d');
        c.op('dadd');
        c.op('dreturn');
    });

    cw.addMethod(PUB_STATIC, 'sumArray', '(I)I', (c) => {
        const arr = c.newLocal('a');
        const i = c.newLocal('i');
        const sum = c.newLocal('i');
        c.load('i', 0);
        c.newarray('int');
        c.store('a', arr);
        c.pushInt(0);
        c.store('i', i);
        const fill = c.newLabel();
        const fillEnd = c.newLabel();
        c.place(fill);
        c.load('i', i);
        c.load('a', arr);
        c.op('arraylength');
        c.jump('if_icmpge', fillEnd);
        c.load('a', arr);
        c.load('i', i);
        c.load('i', i);
        c.op('iastore');
        c.iinc(i, 1);
        c.jump('goto', fill);
        c.place(fillEnd);
        c.pushInt(0);
        c.store('i', sum);
        c.pushInt(0);
        c.store('i', i);
        const sumLoop = c.newLabel();
        const sumEnd = c.newLabel();
        c.place(sumLoop);
        c.load('i', i);
        c.load('a', arr);
        c.op('arraylength');
        c.jump('if_icmpge', sumEnd);
        c.load('i', sum);
        c.load('a', arr);
        c.load('i', i);
        c.op('iaload');
        c.op('iadd');
        c.store('i', sum);
        c.iinc(i, 1);
        c.jump('goto', sumLoop);
        c.place(sumEnd);
        c.load('i', sum);
        c.op('ireturn');
    });

    cw.addMethod(PUB_STATIC, 'main', '([Ljava/lang/String;)V', (c) => {
        const counter = c.newLocal('a');
        println(c, 'D', () => {
            c.pushDouble(1.5);
            c.pushDouble(2.25);
            c.invokestatic('Demo', 'add', '(DD)D');
        });
        println(c, 'I', () => {
            c.pushInt(10);
            c.invokestatic('Demo', 'fib', '(I)I');
        });
        println(c, 'I', () => {
            c.pushInt(7);
            c.pushInt(2);
            c.invokestatic('Demo', 'safeDiv', '(II)I');
        });
        println(c, 'I', () => {
            c.pushInt(1);
            c.pushInt(0);
            c.invokestatic('Demo', 'safeDiv', '(II)I');
        });
        for (const month of [2, 9]) {
            println(c, 'I', () => {
                c.pushInt(month);
                c.invokestatic('Demo', 'daysIn', '(I)I');
            });
        }
        for (const key of [1000, -5, 7]) {
            println(c, 'I', () => {
                c.pushInt(key);
                c.invokestatic('Demo', 'sparse', '(I)I');
            });
        }
        println(c, 'J', () => {
            c.pushLong(3_000_000_000n);
            c.invokestatic('Demo', 'twice', '(J)J');
        });
        println(c, 'I', () => c.invokestatic('Demo', 'manyStrings', '()I'));
        println(c, 'D', () => c.invokestatic('Demo', 'consts', '()D'));
        println(c, 'I', () => {
            c.pushInt(5);
            c.invokestatic('Demo', 'sumArray', '(I)I');
        });
        println(c, 'Ljava/lang/String;', () => c.pushString('done'));

        c.newObject('Counter');
        c.op('dup');
        c.invokespecial('Counter', '<init>', '()V');
        c.store('a', counter);
        for (let i = 0; i < 2; i++) {
            c.load('a', counter);
            c.invokevirtual('Counter', 'inc', '()I');
            c.op('pop');
        }
        println(c, 'I', () => {
            c.load('a', counter);
            c.invokevirtual('Counter', 'inc', '()I');
        });
        c.op('return');
    });

    return cw;
}

function buildCounter(): ClassWriter {
    const cw = new ClassWriter('Counter');
    cw.addField(Acc.PRIVATE, 'count', 'I');
    cw.addMethod(Acc.PUBLIC, '<init>', '()V', (c) => {
        c.load('a', 0);
        c.invokespecial('java/lang/Object', '<init>', '()V');
        c.op('return');
    });
    cw.addMethod(Acc.PUBLIC, 'inc', '()I', (c) => {
        c.load('a', 0);
        c.load('a', 0);
        c.getfield('Counter', 'count', 'I');
        c.pushInt(1);
        c.op('iadd');
        c.putfield('Counter', 'count', 'I');
        c.load('a', 0);
        c.getfield('Counter', 'count', 'I');
        c.op('ireturn');
    });
    return cw;
}

function writeClasses(...classes: ClassWriter[]): { dir: string; files: string[] } {
    const dir = mkdtempSync(join(tmpdir(), 'ts2jvm-'));
    const files = classes.map((cw) => {
        const file = join(dir, `${cw.name}.class`);
        writeFileSync(file, cw.toBytes());
        return file;
    });
    return { dir, files };
}

test('generated classes verify and run on the JVM', () => {
    const { dir } = writeClasses(buildDemo(), buildCounter());
    const out = execFileSync('java', ['-cp', dir, 'Demo'], { encoding: 'utf8' });
    assert.deepEqual(out.trim().split(/\r?\n/), [
        '3.75',
        '55',
        '3',
        '-1',
        '28',
        '0',
        '2',
        '3',
        '0',
        '6000000000',
        '300',
        '1.09951172777775E12', // Java's Double.toString: 100000.5 + 1.25 + 2^40
        '10',
        'done',
        '3',
    ]);
});

test('D8 accepts the generated classes', { skip: !findD8() }, () => {
    const d8 = findD8()!;
    const { dir, files } = writeClasses(buildDemo(), buildCounter());
    execFileSync(
        'java',
        ['-cp', d8.jar, 'com.android.tools.r8.D8', '--lib', d8.androidJar, '--output', dir, ...files],
        {
            encoding: 'utf8',
        },
    );
    assert.ok(readdirSync(dir).includes('classes.dex'));
});

function findD8(): { jar: string; androidJar: string } | undefined {
    const sdk = process.env['ANDROID_HOME'] ?? process.env['ANDROID_SDK_ROOT'];
    if (!sdk) return undefined;
    try {
        const tools = readdirSync(join(sdk, 'build-tools')).sort().reverse();
        const platforms = readdirSync(join(sdk, 'platforms')).sort().reverse();
        const jar = tools.map((t) => join(sdk, 'build-tools', t, 'lib', 'd8.jar')).find(existsSync);
        const androidJar = platforms.map((p) => join(sdk, 'platforms', p, 'android.jar')).find(existsSync);
        return jar && androidJar ? { jar, androidJar } : undefined;
    } catch {
        return undefined;
    }
}

test('stack underflow is caught at assembly time', () => {
    const cw = new ClassWriter('Bad');
    assert.throws(
        () =>
            cw.addMethod(PUB_STATIC, 'f', '()V', (c) => {
                c.op('iadd');
                c.op('return');
            }),
        /Bad\.f\(\)V: Operand stack underflow/,
    );
});

test('missing return is caught at assembly time', () => {
    const cw = new ClassWriter('Bad');
    assert.throws(() => cw.addMethod(PUB_STATIC, 'f', '()V', (c) => c.op('nop')), /falls off the end/);
});

test('inconsistent stack depth at a join is caught', () => {
    const cw = new ClassWriter('Bad');
    assert.throws(
        () =>
            cw.addMethod(PUB_STATIC, 'f', '(I)V', (c) => {
                const join = c.newLabel();
                c.load('i', 0);
                c.jump('ifeq', join);
                c.pushInt(1);
                c.place(join);
                c.op('return');
            }),
        /Stack depth mismatch/,
    );
});

test('abstract methods reject a body and concrete methods require one', () => {
    const cw = new ClassWriter('X', { access: Acc.PUBLIC | Acc.ABSTRACT });
    assert.throws(
        () => cw.addMethod(Acc.PUBLIC | Acc.ABSTRACT, 'f', '()V', (c) => c.op('return')),
        /must not have a body/,
    );
    assert.throws(() => cw.addMethod(Acc.PUBLIC, 'g', '()V'), /needs a body/);
});

test('modified UTF-8 encodes NUL and supplementary characters the JVM way', () => {
    assert.deepEqual([...modifiedUtf8('\u0000')], [0xc0, 0x80]);
    assert.deepEqual([...modifiedUtf8('é')], [0xc3, 0xa9]);
    // U+1F600 is a surrogate pair: two 3-byte sequences, not one 4-byte one.
    assert.equal(modifiedUtf8('😀').length, 6);
});

test('constant pool deduplicates and long/double take two slots', () => {
    const cp = new ConstantPool();
    assert.equal(cp.utf8('a'), cp.utf8('a'));
    const l = cp.long(5n);
    assert.equal(cp.integer(1), l + 2);
    assert.equal(cp.float(-0), cp.float(-0));
    assert.notEqual(cp.float(0), cp.float(-0));
});

test('method descriptors are parsed into slots', () => {
    const m = parseMethodDescriptor('(I[JLjava/lang/String;D[[Ljava/util/List;)J');
    assert.deepEqual(m.params, ['I', '[J', 'Ljava/lang/String;', 'D', '[[Ljava/util/List;']);
    assert.equal(m.argSlots, 1 + 1 + 1 + 2 + 1);
    assert.equal(m.retSlots, 2);
});
