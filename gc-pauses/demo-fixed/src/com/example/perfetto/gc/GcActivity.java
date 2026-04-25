package com.example.perfetto.gc;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class GcActivity extends Activity {

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("GcDemo (fixed)");
        root.addView(t);
        setContentView(root);

        // Same workload, single reusable StringBuilder.
        final StringBuilder sb = new StringBuilder(10003);
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("buildLogLine");
                try {
                    sb.setLength(0);
                    sb.append("log");
                    for (int i = 0; i < 10000; i++) {
                        sb.append((char) ('A' + (i % 26)));
                    }
                    if ((n & 31) == 0) t.setText("len=" + sb.length() + " n=" + n);
                } finally { Trace.endSection(); }
                if (++n < 600) h.postDelayed(this, 16);
            }
        };
        h.post(tick);
    }
}
