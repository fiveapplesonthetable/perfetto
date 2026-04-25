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
        t.setText("CpuSpinDemo (buggy)");
        root.addView(t);
        setContentView(root);

        // Big input. Parser scans on a background thread; the bug is
        // O(n^2) due to repeated substring().
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < 2000; i++) b.append("k").append(i).append("=v,");
        String input = b.toString();

        HandlerThread bg = new HandlerThread("Parser"); bg.start();
        Handler bh = new Handler(bg.getLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                Trace.beginSection("parseQuadratic");
                try { parseQuadratic(input); } finally { Trace.endSection(); }
                if (++n < 10) bh.postDelayed(this, 50);
            }
        };
        bh.post(tick);
    }

    /** Hand-rolled "parser": each iteration creates a new substring. O(n^2). */
    private int parseQuadratic(String s) {
        int count = 0;
        while (s.length() > 0) {
            int comma = s.indexOf(',');
            if (comma < 0) break;
            String pair = s.substring(0, comma);          // alloc
            if (pair.indexOf('=') > 0) count++;
            s = s.substring(comma + 1);                    // alloc + O(n) copy
        }
        return count;
    }
}
