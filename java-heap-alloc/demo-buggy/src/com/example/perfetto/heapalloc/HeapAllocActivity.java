package com.example.perfetto.heapalloc;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class HeapAllocActivity extends Activity {

    private TextView t;

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        t = new TextView(this);
        t.setText("HeapAllocDemo (buggy)");
        root.addView(t);
        setContentView(root);

        // Once a second, allocate 1024 fresh 4 KiB byte[] (~4 MiB) and
        // discard. 12 ticks = ~50 MiB of short-lived garbage attributed to
        // onTick. Small individual allocations stay in ART's TLAB path so
        // heapprofd's sampling catches them.
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("onTick");
                try {
                    int total = 0;
                    for (int i = 0; i < 1024; i++) {
                        byte[] b = new byte[4096];                // 4 KiB
                        b[0] = (byte) i;
                        total += b.length;
                    }
                    t.setText("tick " + n + " allocated " + (total / 1024) + " KiB");
                } finally { Trace.endSection(); }
                if (++n < 12) h.postDelayed(this, 1000);
            }
        };
        h.post(tick);
    }
}
