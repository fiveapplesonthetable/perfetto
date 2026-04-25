package com.example.perfetto.cpuspin;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class CpuSpinActivity extends Activity {

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("CpuSpinDemo (fixed)");
        root.addView(t);
        setContentView(root);

        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 2000; i++) b.append("k").append(i).append("=v,");
        String input = b.toString();

        HandlerThread bg = new HandlerThread("Parser"); bg.start();
        Handler bh = new Handler(bg.getLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("parseLinear");
                try { parseLinear(input); } finally { Trace.endSection(); }
                if (++n < 10) bh.postDelayed(this, 50);
            }
        };
        bh.post(tick);
    }

    /** Index-based scan, no substring allocations. O(n). */
    private int parseLinear(String s) {
        int count = 0, start = 0, len = s.length();
        for (int i = 0; i < len; i++) {
            if (s.charAt(i) != ',') continue;
            // Look for '=' inside the [start, i) range.
            for (int j = start; j < i; j++) {
                if (s.charAt(j) == '=') { count++; break; }
            }
            start = i + 1;
        }
        return count;
    }
}
