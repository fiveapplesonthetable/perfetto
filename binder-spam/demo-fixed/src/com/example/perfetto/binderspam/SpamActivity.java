package com.example.perfetto.binderspam;

import android.app.Activity;
import android.content.Context;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkRequest;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.concurrent.atomic.AtomicBoolean;

public class SpamActivity extends Activity {

    private final AtomicBoolean isConnected = new AtomicBoolean(false);
    private ConnectivityManager.NetworkCallback callback;
    private ConnectivityManager cm;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("BinderSpamDemo (fixed)");
        root.addView(t);
        setContentView(root);

        cm = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
        callback = new ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(Network n) { isConnected.set(true); }
            @Override public void onLost(Network n) { isConnected.set(false); }
        };
        cm.registerDefaultNetworkCallback(callback);

        // Per-frame work: read the cached value. No binder call.
        root.getViewTreeObserver().addOnPreDrawListener(() -> {
            Trace.beginSection("checkNetwork");
            try { t.setText("net=" + isConnected.get()); }
            finally { Trace.endSection(); }
            return true;
        });

        final Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            @Override public void run() { root.invalidate(); h.postDelayed(this, 100); }
        };
        h.post(tick);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (callback != null) cm.unregisterNetworkCallback(callback);
    }
}
