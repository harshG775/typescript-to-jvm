import { Activity } from 'android.app';
import { Bundle } from 'android.os';
import { Log } from 'android.util';
import { TextView } from 'android.widget';

class MainActivity extends Activity {
    taps: number = 0;

    onCreate(savedInstanceState: Bundle | null): void {
        super.onCreate(savedInstanceState);
        Log.d('ts2jvm', 'onCreate from a TypeScript Activity');

        const view = new TextView(this);
        view.setText('Hello from an Activity written in TypeScript');
        view.setTextSize(24);
        this.setContentView(view);
    }
}
