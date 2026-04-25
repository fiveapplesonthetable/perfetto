package com.example.perfetto.viewinflation;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

public class InflateActivity extends Activity {
    private static final int ROW_COUNT = 5000;
    private ListView list;

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        list = new ListView(this);
        list.setAdapter(new DeepAdapter(this));
        setContentView(list);
        new Handler(Looper.getMainLooper()).postDelayed(this::scroll, 1500);
    }

    private void scroll() {
        Handler h = new Handler(Looper.getMainLooper());
        Runnable tick = new Runnable() {
            int n = 0;
            @Override public void run() {
                list.smoothScrollByOffset(8);
                if (++n < 600) h.postDelayed(this, 50);
            }
        };
        h.post(tick);
    }

    /** Builds a 30-deep nested LinearLayout per row. measure/layout dominates. */
    private static final class DeepAdapter extends BaseAdapter {
        private final Context ctx;
        DeepAdapter(Context c) { ctx = c; }
        @Override public int getCount() { return ROW_COUNT; }
        @Override public Object getItem(int p) { return p; }
        @Override public long getItemId(int p) { return p; }
        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            Trace.beginSection("DeepAdapter.getView");
            try {
                LinearLayout outer = new LinearLayout(ctx);
                outer.setMinimumHeight(180);
                LinearLayout cur = outer;
                for (int i = 0; i < 30; i++) {
                    LinearLayout child = new LinearLayout(ctx);
                    child.setOrientation(LinearLayout.HORIZONTAL);
                    child.setPadding(2, 2, 2, 2);
                    cur.addView(child);
                    cur = child;
                }
                TextView tv = new TextView(ctx);
                tv.setText("Row " + position);
                cur.addView(tv);
                return outer;
            } finally { Trace.endSection(); }
        }
    }
}
