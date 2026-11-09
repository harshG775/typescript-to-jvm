// Editor/tsc declarations for the Android and Java classes ts2jvm programs can import.
// Hand-written for now and deliberately small; the compiler itself reads the real classes from android.jar,
// so anything that exists there can be imported even if it isn't declared here yet.
// Numbers are `number` everywhere: ts2jvm converts to and from Java int/float/long at each call.

declare module 'android.content' {
    export class Context {}
}

declare module 'android.os' {
    export class Bundle {}
}

declare module 'android.util' {
    export class Log {
        static d(tag: string, msg: string): number;
        static e(tag: string, msg: string): number;
        static i(tag: string, msg: string): number;
        static w(tag: string, msg: string): number;
    }
}

declare module 'android.view' {
    import { Context } from 'android.content';

    export class View {
        constructor(context: Context);
        setId(id: number): void;
    }
}

declare module 'android.widget' {
    import { Context } from 'android.content';
    import { View } from 'android.view';

    export class TextView extends View {
        constructor(context: Context);
        setText(text: string): void;
        setTextSize(size: number): void;
    }
}

declare module 'android.app' {
    import { Context } from 'android.content';
    import { Bundle } from 'android.os';
    import { View } from 'android.view';

    export class Activity extends Context {
        protected onCreate(savedInstanceState: Bundle | null): void;
        setContentView(view: View): void;
        setTitle(title: string): void;
    }
}

declare module 'java.lang' {
    export class Integer {
        static parseInt(s: string): number;
        static toHexString(i: number): string;
    }
    export class StringBuilder {
        constructor();
        append(value: string | number | boolean): StringBuilder;
        toString(): string;
    }
}
