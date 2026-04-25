package com.example.perfetto.threadspam;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class ThreadSpamActivity extends Activity {

    private final ExecutorService net = Executors.newFixedThreadPool(4, r -> {
        Thread t = new Thread(r, "Net");
        t.setDaemon(true);
        return t;
    });

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("ThreadSpamDemo (fixed)");
        root.addView(t);
        setContentView(root);

        final Handler h = new Handler(Looper.getMainLooper());
        for (int i = 0; i < 200; i++) {
            final int n = i;
            h.postDelayed(() -> {
                Trace.beginSection("dispatch#" + n);
                try {
                    net.submit(() -> {
                        long deadline = System.nanoTime() + 10_000_000;
                        long x = 0;
                        while (System.nanoTime() < deadline) x += System.nanoTime();
                    });
                } finally { Trace.endSection(); }
            }, 50L + n * 25L);
        }
    }
}
