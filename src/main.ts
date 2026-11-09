// Demo: everything on this screen is TypeScript compiled to JVM bytecode. No JavaScript runtime.
import { Activity } from 'android.app';
import { Context } from 'android.content';
import { Color } from 'android.graphics';
import { Bundle } from 'android.os';
import { Log } from 'android.util';
import { LinearLayout, ScrollView, TextView } from 'android.widget';
import { Integer } from 'java.lang';

// ---- plain functions: recursion, loops, try/catch -------------------------------------------

function fib(n: number): number {
    if (n < 2) return n;
    return fib(n - 1) + fib(n - 2);
}

function countPrimes(limit: number): number {
    let count = 0;
    let n = 2;
    while (n < limit) {
        let isPrime = true;
        let d = 2;
        while (d * d <= n) {
            if (n % d == 0) {
                isPrime = false;
            }
            d = d + 1;
        }
        if (isPrime) {
            count = count + 1;
        }
        n = n + 1;
    }
    return count;
}

function safeParse(text: string): string {
    try {
        return '' + Integer.parseInt(text);
    } catch (e) {
        return 'not a number';
    }
}

// ---- classes: fields, constructors, inheritance, overriding, super ---------------------------

class Shape {
    name: string;

    constructor(name: string) {
        this.name = name;
    }

    area(): number {
        return 0;
    }

    describe(): string {
        return this.name + ' area = ' + Math.floor(this.area() * 100) / 100;
    }
}

class Circle extends Shape {
    radius: number;

    constructor(radius: number) {
        super('circle r=' + radius);
        this.radius = radius;
    }

    area(): number {
        return 3.14159265 * this.radius * this.radius;
    }
}

class Rect extends Shape {
    width: number;
    height: number;

    constructor(width: number, height: number) {
        super('rect ' + width + 'x' + height);
        this.width = width;
        this.height = height;
    }

    area(): number {
        return this.width * this.height;
    }
}

class TodoItem {
    title: string;
    done: boolean;

    constructor(title: string, done: boolean) {
        this.title = title;
        this.done = done;
    }

    label(): string {
        return (this.done ? '[x] ' : '[ ] ') + this.title;
    }
}

// ---- UI helpers: real Android views, called directly -----------------------------------------

function addText(ctx: Context, parent: LinearLayout, text: string, size: number, color: string): void {
    const view = new TextView(ctx);
    view.setText(text);
    view.setTextSize(size);
    view.setTextColor(Color.parseColor(color));
    view.setPadding(0, 10, 0, 10);
    parent.addView(view);
}

function addTodo(ctx: Context, parent: LinearLayout, item: TodoItem): void {
    addText(ctx, parent, item.label(), 17, item.done ? '#9E9E9E' : '#212121');
}

// ---- the screen ------------------------------------------------------------------------------

class MainActivity extends Activity {
    onCreate(savedInstanceState: Bundle | null): void {
        super.onCreate(savedInstanceState);

        // Saved between launches with SharedPreferences.
        const prefs = this.getSharedPreferences('demo', 0);
        const opens = Integer.parseInt(prefs.getString('opens', '0')) + 1;
        prefs
            .edit()
            .putString('opens', '' + opens)
            .apply();

        const root = new LinearLayout(this);
        root.setOrientation(1);
        root.setPadding(48, 80, 48, 80);
        root.setBackgroundColor(Color.parseColor('#F5F7FA'));

        addText(this, root, 'TypeScript to JVM to Android', 26, '#0D47A1');
        addText(this, root, 'Compiled to bytecode. No JS engine, no bridge.', 14, '#546E7A');
        addText(this, root, 'Opened ' + opens + ' times (saved in SharedPreferences)', 14, '#2E7D32');

        addText(this, root, 'Computed by compiled TypeScript', 20, '#0D47A1');
        addText(this, root, 'fib(25) = ' + fib(25), 16, '#212121');
        addText(this, root, 'primes below 200: ' + countPrimes(200), 16, '#212121');
        addText(this, root, 'parse "42": ' + safeParse('42'), 16, '#212121');
        addText(this, root, 'parse "abc": ' + safeParse('abc'), 16, '#212121');

        addText(this, root, 'Classes and inheritance', 20, '#0D47A1');
        addText(this, root, new Circle(5).describe(), 16, '#212121');
        addText(this, root, new Rect(3, 4.5).describe(), 16, '#212121');

        addText(this, root, 'Todos (from a TodoItem class)', 20, '#0D47A1');
        addTodo(this, root, new TodoItem('Write the compiler', true));
        addTodo(this, root, new TodoItem('Run it on a phone', true));
        addTodo(this, root, new TodoItem('Handle button taps', false));
        addTodo(this, root, new TodoItem('Build a real todo app', false));

        const scroll = new ScrollView(this);
        scroll.addView(root);
        this.setContentView(scroll);

        Log.d('ts2jvm', 'demo screen built, opened ' + opens + ' times');
    }
}
