package com.example.perfetto.lockcontention;

import android.app.Activity;
import android.os.Bundle;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

public class LockActivity extends Activity {

    /** Single global mutex. Holds the lock for the entire compute step. */
    static final Object LOCK = new Object();
    static long state;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("LockDemo (buggy)");
        root.addView(t);
        setContentView(root);

        ExecutorService pool = Executors.newFixedThreadPool(16);
        AtomicLong ops = new AtomicLong();
        for (int w = 0; w < 16; w++) {
            pool.submit(() -> {
                long until = System.currentTimeMillis() + 6000;
                while (System.currentTimeMillis() < until) {
                    Trace.beginSection("BadCache.compute");
                    try {
                        // The bug: the entire 5 ms compute runs inside the
                        // critical section, so 16 threads serialize behind
                        // a single mutex.
                        synchronized (LOCK) {
                            long h = state;
                            for (int i = 0; i < 200_000; i++) {
                                h = h * 1103515245L + 12345L;
                            }
                            state = h;
                        }
                    } finally { Trace.endSection(); }
                    ops.incrementAndGet();
                }
            });
        }
        pool.shutdown();
    }
}
