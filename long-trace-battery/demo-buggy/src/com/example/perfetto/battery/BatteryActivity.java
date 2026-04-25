package com.example.perfetto.battery;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class BatteryActivity extends Activity {
    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("BatteryDemo (buggy)");
        root.addView(t);
        setContentView(root);

        // The bug: a background thread wakes up the CPU every 200 ms forever
        // doing a tiny bit of work. The device cannot enter Doze.
        HandlerThread bg = new HandlerThread("BackgroundPoll"); bg.start();
        Handler h = new Handler(bg.getLooper());
        Runnable tick = new Runnable() {
            @Override public void run() {
                Trace.beginSection("backgroundPoll");
                try {
                    long x = 0;
                    long deadline = System.nanoTime() + 5_000_000;  // 5 ms of CPU
                    while (System.nanoTime() < deadline) x += System.nanoTime();
                } finally { Trace.endSection(); }
                h.postDelayed(this, 200);                            // ~5 wakes/sec, forever
            }
        };
        h.post(tick);
    }
}
