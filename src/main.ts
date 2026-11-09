class Counter {
    count: number = 0;

    inc(): number {
        this.count = this.count + 1;
        return this.count;
    }

    describe(): string {
        return 'count = ' + this.count;
    }
}

function main(): void {
    const c = new Counter();
    c.inc();
    c.inc();
    Log.d('ts2jvm', 'Hello from TypeScript on the JVM, ' + c.describe());
}
