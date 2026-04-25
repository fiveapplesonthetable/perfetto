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
        t.setText("BatteryDemo (fixed)");
        root.addView(t);
        setContentView(root);

        // Fix: don't run a background poll at all. If the work is genuinely
        // periodic, schedule it via WorkManager (battery- and Doze-aware) at
        // the longest acceptable cadence — e.g. every 15 minutes.
    }
}
