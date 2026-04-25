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
        t.setText("MainIODemo (fixed)");
        root.addView(t);
        setContentView(root);

        final SharedPreferences prefs = getSharedPreferences("settings", MODE_PRIVATE);
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable[] todo = new Runnable[50];
        for (int i = 0; i < 50; i++) {
            final int n = i;
            todo[i] = () -> {
                Trace.beginSection("toggle#" + n);
                try {
                    // Fix: apply() returns immediately and writes the file
                    // on a background thread.
                    prefs.edit().putBoolean("k" + n, n % 2 == 0).apply();
                } finally { Trace.endSection(); }
            };
        }
        for (int i = 0; i < 50; i++) h.postDelayed(todo[i], 100L + i * 80L);
    }
}
