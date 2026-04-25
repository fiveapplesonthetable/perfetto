package com.example.perfetto.wakelocks;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.PowerManager;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class WakelocksActivity extends Activity {

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("WakelocksDemo (fixed)");
        root.addView(t);
        setContentView(root);

        // Fix: acquire-with-timeout and try/finally release. The wake lock is
        // bounded by the work it covers, never leaked.
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                                                   "WakelocksDemo:upload");
        HandlerThread hb = new HandlerThread("Upload"); hb.start();
        new Handler(hb.getLooper()).post(() -> {
            Trace.beginSection("uploadWithWakeLock");
            wl.acquire(2_000L);                     // hard cap
            try {
                try { Thread.sleep(800); } catch (InterruptedException e) {}
            } finally {
                if (wl.isHeld()) wl.release();
                Trace.endSection();
            }
        });
    }
}
