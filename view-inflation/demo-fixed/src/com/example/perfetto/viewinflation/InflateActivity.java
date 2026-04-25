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
        list.setAdapter(new FlatAdapter(this));
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

    /** Flat single-level layout. measure/layout proportional to one View. */
    private static final class FlatAdapter extends BaseAdapter {
        private final Context ctx;
        FlatAdapter(Context c) { ctx = c; }
        @Override public int getCount() { return ROW_COUNT; }
        @Override public Object getItem(int p) { return p; }
        @Override public long getItemId(int p) { return p; }
        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            Trace.beginSection("FlatAdapter.getView");
            try {
                TextView tv = (TextView) convertView;
                if (tv == null) {
                    tv = new TextView(ctx);
                    tv.setMinHeight(180);
                    tv.setPadding(24, 24, 24, 24);
                }
                tv.setText("Row " + position);
                return tv;
            } finally { Trace.endSection(); }
        }
    }
}
