package com.example.perfetto.mainio;

import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainIOActivity extends Activity {
    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("MainIODemo (buggy)");
        root.addView(t);
        setContentView(root);

        // Simulate the user toggling 50 setting tiles in quick succession.
        final SharedPreferences prefs = getSharedPreferences("settings", MODE_PRIVATE);
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable[] todo = new Runnable[50];
        for (int i = 0; i < 50; i++) {
            final int n = i;
            todo[i] = () -> {
                Trace.beginSection("toggle#" + n);
                try {
                    // The bug: commit() is synchronous fsync on the UI thread.
                    prefs.edit().putBoolean("k" + n, n % 2 == 0).commit();
                } finally { Trace.endSection(); }
            };
        }
        for (int i = 0; i < 50; i++) h.postDelayed(todo[i], 100L + i * 80L);
    }
}
