package com.example.perfetto.nativeheap;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class NativeHeapActivity extends Activity {
    static { System.loadLibrary("leak"); }

    public native void allocate(int kib);

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("NativeHeapDemo (PID " + Process.myPid() + ")");
        root.addView(t);
        setContentView(root);

        // Allocate 100 KiB of native memory once per 100 ms; on the buggy
        // build, every block is leaked. By the end of the trace we've
        // accumulated tens of MiB of unreleased malloc.
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("nativeAlloc");
                try { allocate(100); } finally { Trace.endSection(); }
                if (++n < 200) h.postDelayed(this, 100);
            }
        };
        h.postDelayed(tick, 1500);
    }
}
