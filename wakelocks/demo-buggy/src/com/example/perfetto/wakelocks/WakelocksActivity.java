package com.example.perfetto.wakelocks;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
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
        t.setText("WakelocksDemo (buggy)");
        root.addView(t);
        setContentView(root);

        // The bug: acquire a partial wake lock and never release it.
        // The CPU stays awake forever, even with the screen off.
        Trace.beginSection("acquireWakeLock");
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK,
                                                       "WakelocksDemo:upload");
            wl.acquire();
            // ... "upload work" ...
            // wl.release();  <-- forgotten on this code path
        } finally { Trace.endSection(); }
    }
}
