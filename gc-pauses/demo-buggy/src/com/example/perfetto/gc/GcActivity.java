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
        t.setText("GcDemo (buggy)");
        root.addView(t);
        setContentView(root);

        // Sustained allocation: every 16 ms, build a 10,000-character message
        // by + concatenation. Each + allocates a fresh String + char array.
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("buildLogLine");
                try {
                    String s = "log";
                    for (int i = 0; i < 10000; i++) {
                        // Each iteration: alloc StringBuilder, alloc String, discard.
                        s = s + (char) ('A' + (i % 26));
                    }
                    if ((n & 31) == 0) t.setText("len=" + s.length() + " n=" + n);
                } finally { Trace.endSection(); }
                if (++n < 600) h.postDelayed(this, 16);
            }
        };
        h.post(tick);
    }
}
