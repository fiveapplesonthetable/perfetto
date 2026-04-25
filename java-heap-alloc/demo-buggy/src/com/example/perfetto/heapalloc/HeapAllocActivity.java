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

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("HeapAllocDemo");
        root.addView(t);
        setContentView(root);

        // Simulate a search box: 50 keystrokes; each rebuilds the result list
        // from scratch and reformats every entry into a fresh String.
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
        // Bug: builds a fresh ArrayList of formatted Strings on every call.
        ArrayList<String> hits = new ArrayList<>();
        for (int i = 0; i < 5000; i++) {
            String word = CORPUS[i % CORPUS.length];
            // String concatenation allocates intermediate Strings + StringBuilder.
            String formatted = "result " + i + ": " + word + " (q=" + q + ")";
            if (formatted.contains(q.substring(0, Math.min(2, q.length())))) {
                hits.add(formatted);
            }
        }
        return hits;
    }
}
