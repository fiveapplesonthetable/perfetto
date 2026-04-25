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

    static final Object LOCK = new Object();
    static long state;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("LockDemo (fixed)");
        root.addView(t);
        setContentView(root);

        ExecutorService pool = Executors.newFixedThreadPool(16);
        AtomicLong ops = new AtomicLong();
        for (int w = 0; w < 16; w++) {
            pool.submit(() -> {
                long until = System.currentTimeMillis() + 6000;
                while (System.currentTimeMillis() < until) {
                    Trace.beginSection("GoodCache.compute");
                    try {
                        // Fix: do the expensive compute outside the lock,
                        // then take the lock only to publish the result.
                        long h = state;
                        for (int i = 0; i < 200_000; i++) {
                            h = h * 1103515245L + 12345L;
                        }
                        synchronized (LOCK) { state = h; }
                    } finally { Trace.endSection(); }
                    ops.incrementAndGet();
                }
            });
        }
        pool.shutdown();
    }
}
