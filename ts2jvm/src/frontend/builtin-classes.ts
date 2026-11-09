import { methodFromDescriptor, type ClassResolver, type ForeignClass, type ForeignMethod } from './type-registry.ts';

/**
 * A tiny hand-written class table. It is the fallback when no Android SDK is found, and what the front-end
 * tests use so they don't depend on one. Real compiles read android.jar instead (see android/jar.ts).
 * Method strings are `[static ]name(descriptor)`.
 */
interface Spec {
    super?: string;
    interfaces?: string[];
    interface?: true;
    ctors?: string[];
    methods?: string[];
}

const STR = 'Ljava/lang/String;';
const CHARS = 'Ljava/lang/CharSequence;';

const SPECS: Record<string, Spec> = {
    'java/lang/Object': { ctors: ['()V'] },
    'java/lang/CharSequence': { interface: true, super: 'java/lang/Object', methods: ['length()I'] },
    'java/lang/String': { super: 'java/lang/Object', interfaces: ['java/lang/CharSequence'] },
    'java/lang/Math': {
        super: 'java/lang/Object',
        methods: [
            'static abs(D)D',
            'static floor(D)D',
            'static ceil(D)D',
            'static sqrt(D)D',
            'static random()D',
            'static min(DD)D',
            'static max(DD)D',
            'static abs(I)I',
        ],
    },
    'android/util/Log': {
        super: 'java/lang/Object',
        methods: ['d', 'e', 'i', 'w'].map((n) => `static ${n}(${STR}${STR})I`),
    },
    'android/os/Bundle': { super: 'java/lang/Object', ctors: ['()V'] },
    'android/content/Context': { super: 'java/lang/Object' },
    'android/view/View': {
        super: 'java/lang/Object',
        ctors: ['(Landroid/content/Context;)V'],
        methods: ['setId(I)V'],
    },
    'android/widget/TextView': {
        super: 'android/view/View',
        ctors: ['(Landroid/content/Context;)V'],
        methods: [`setText(${CHARS})V`, 'setTextSize(F)V', `getText()${CHARS}`],
    },
    'android/app/Activity': {
        super: 'android/content/Context',
        ctors: ['()V'],
        methods: [
            'onCreate(Landroid/os/Bundle;)V',
            'setContentView(Landroid/view/View;)V',
            `setTitle(${CHARS})V`,
            'onKeyDown(ILjava/lang/Object;)Z',
        ],
    },
};

function parse(spec: string): ForeignMethod {
    const isStatic = spec.startsWith('static ');
    const body = isStatic ? spec.slice('static '.length) : spec;
    const open = body.indexOf('(');
    const m = methodFromDescriptor(body.slice(0, open), body.slice(open), isStatic);
    if (!m) throw new Error(`bad builtin method spec '${spec}'`);
    return m;
}

export function builtinResolver(): ClassResolver {
    const cache = new Map<string, ForeignClass>();
    return {
        lookup(name) {
            const hit = cache.get(name);
            if (hit) return hit;
            const spec = SPECS[name];
            if (!spec) return undefined;
            const cls: ForeignClass = {
                name,
                superName: spec.super ?? null,
                interfaces: spec.interfaces ?? [],
                isInterface: spec.interface === true,
                ctors: (spec.ctors ?? []).map((c) => ({ ...parse(`<init>${c}`), isStatic: false })),
                methods: (spec.methods ?? []).map(parse),
            };
            cache.set(name, cls);
            return cls;
        },
    };
}

/** Tries each resolver in order. */
export function chainResolvers(...resolvers: ClassResolver[]): ClassResolver {
    return { lookup: (name) => resolvers.map((r) => r.lookup(name)).find((c) => c !== undefined) };
}
