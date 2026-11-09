// Ambient declarations for the classes ts2jvm can call. Keep in sync with src/frontend/type-registry.ts.
// Only for the editor / `tsc`: the compiler resolves these names through its own registry.

declare const Log: {
    d(tag: string, msg: string): void;
    e(tag: string, msg: string): void;
    i(tag: string, msg: string): void;
    w(tag: string, msg: string): void;
};
