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

    private static final String[] CORPUS = {
        "android", "perfetto", "trace", "frame", "binder", "atrace",
        "memory", "leak", "allocation", "garbage", "collection", "kotlin"
    };

    /** Re-used across all search calls. No per-keystroke allocation. */
    private final ArrayList<String> hits = new ArrayList<>(64);
    private final StringBuilder buf = new StringBuilder(64);

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
        for (int i = 0; i < 50; i++) {
            final int n = i;
            h.postDelayed(() -> {
                Trace.beginSection("onTextChanged");
                try { search("query" + n); }
                finally { Trace.endSection(); }
            }, 100L + n * 80L);
        }
    }

    private List<String> search(String q) {
        hits.clear();
        String prefix = q.substring(0, Math.min(2, q.length()));
        for (int i = 0; i < 5000; i++) {
            String word = CORPUS[i % CORPUS.length];
            // Walk the corpus and the prefix manually; only allocate a String
            // for entries that actually match.
            if (!word.contains(prefix) && !prefix.startsWith("q")) continue;
            buf.setLength(0);
            buf.append("result ").append(i).append(": ").append(word)
               .append(" (q=").append(q).append(')');
            hits.add(buf.toString());
        }
        return hits;
    }
}
