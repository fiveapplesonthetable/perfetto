package com.example.perfetto.binderspam;

import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.view.ViewTreeObserver;
import android.widget.LinearLayout;
import android.widget.TextView;

public class SpamActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("BinderSpamDemo");
        root.addView(t);
        setContentView(root);

        final ConnectivityManager cm =
            (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);

        // The bug: the onPreDraw listener fires once per frame and makes a
        // cross-process binder call to system_server every time.
        root.getViewTreeObserver().addOnPreDrawListener(() -> {
            Trace.beginSection("checkNetwork");
            try {
                NetworkInfo ni = cm.getActiveNetworkInfo();
                t.setText("net=" + (ni != null && ni.isConnected()));
            } finally { Trace.endSection(); }
            return true;
        });

        // Force ~10 frames per second of redraw to keep the listener firing.
        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            @Override public void run() { root.invalidate(); h.postDelayed(this, 100); }
        };
        h.post(tick);
    }
}
