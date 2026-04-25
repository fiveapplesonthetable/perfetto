package com.example.perfetto.heapalloc;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

public class HeapAllocActivity extends Activity {

    /** Static "cache" that's never evicted. Every tick appends; nothing ever leaves. */
    public static final List<String> CACHE = new ArrayList<>();

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("HeapAllocDemo (buggy)");
        root.addView(t);
        setContentView(root);

        // Once a second, append 5,000 fresh String objects (~250 KiB) to the
        // static cache. Over a 12 s trace this accumulates ~3 MiB of String
        // objects — visible as growing snapshots in the heap profile.
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("appendBatch");
                try {
                    for (int i = 0; i < 5000; i++) {
                        CACHE.add("entry-" + n + "-" + i);
                    }
                    t.setText("CACHE size: " + CACHE.size());
                } finally { Trace.endSection(); }
                if (++n < 12) h.postDelayed(this, 1000);
            }
        };
        h.post(tick);
    }
}
