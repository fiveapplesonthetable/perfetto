package com.example.perfetto.heapalloc;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.util.LruCache;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class HeapAllocActivity extends Activity {

    /** Bounded LRU. Same insertion rate; oldest entries are evicted past 1024. */
    public static final LruCache<String, String> CACHE = new LruCache<>(1024);

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("HeapAllocDemo (fixed)");
        root.addView(t);
        setContentView(root);

        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("appendBatch");
                try {
                    for (int i = 0; i < 5000; i++) {
                        String k = "entry-" + n + "-" + i;
                        CACHE.put(k, k);
                    }
                    t.setText("CACHE size: " + CACHE.size());
                } finally { Trace.endSection(); }
                if (++n < 12) h.postDelayed(this, 1000);
            }
        };
        h.post(tick);
    }
}
