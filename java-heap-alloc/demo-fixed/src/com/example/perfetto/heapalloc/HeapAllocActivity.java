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

    /** 1024 buffers allocated once at class load; reused on every tick. */
    private static final byte[][] REUSED;
    static {
        REUSED = new byte[1024][];
        for (int i = 0; i < REUSED.length; i++) REUSED[i] = new byte[4096];
    }

    private TextView t;

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        t = new TextView(this);
        t.setText("HeapAllocDemo (fixed)");
        root.addView(t);
        setContentView(root);

        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("onTick");
                try {
                    int total = 0;
                    for (int i = 0; i < 1024; i++) {
                        byte[] b = REUSED[i];                      // reuse, not alloc
                        b[0] = (byte) i;
                        total += b.length;
                    }
                    t.setText("tick " + n + " reused " + (total / 1024) + " KiB");
                } finally { Trace.endSection(); }
                if (++n < 12) h.postDelayed(this, 1000);
            }
        };
        h.post(tick);
    }
}
