package com.example.perfetto.jank;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

public class JankActivity extends Activity {

    private static final int ROW_HEIGHT_PX = 220;
    private static final int ROW_COUNT = 5000;
    private ListView list;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        list = new ListView(this);
        list.setAdapter(new BadAdapter(this));
        setContentView(list);

        // Programmatic scroll a few hundred ms after the first frame so the
        // trace captures real, sustained jank without needing user input.
        new Handler(Looper.getMainLooper()).postDelayed(this::startScrolling, 1500);
    }

    private void startScrolling() {
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

    /** Decodes one of five PNGs from assets on every getView() call. No cache. */
    private static final class BadAdapter extends BaseAdapter {
        private final Context ctx;
        private final byte[][] assets = new byte[5][];

        BadAdapter(Context ctx) {
            this.ctx = ctx;
            for (int i = 0; i < assets.length; i++) {
                assets[i] = readAsset("img" + i + ".png");
            }
        }

        @Override public int getCount() { return ROW_COUNT; }
        @Override public Object getItem(int p) { return p; }
        @Override public long getItemId(int p) { return p; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            Trace.beginSection("BadAdapter.getView");
            try {
                LinearLayout row = (LinearLayout) convertView;
                if (row == null) {
                    row = new LinearLayout(ctx);
                    row.setOrientation(LinearLayout.HORIZONTAL);
                    row.setMinimumHeight(ROW_HEIGHT_PX);
                    ImageView iv = new ImageView(ctx);
                    iv.setLayoutParams(new LinearLayout.LayoutParams(ROW_HEIGHT_PX, ROW_HEIGHT_PX));
                    iv.setId(1);
                    row.addView(iv);
                    TextView tv = new TextView(ctx);
                    tv.setTextSize(18);
                    tv.setPadding(24, 0, 0, 0);
                    tv.setId(2);
                    row.addView(tv);
                }

                // The bug: synchronous decode on the UI thread, every bind, no cache.
                byte[] bytes = assets[position % assets.length];
                Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                ((ImageView) row.findViewById(1)).setImageBitmap(bmp);
                ((TextView) row.findViewById(2)).setText("Row " + position);
                return row;
            } finally {
                Trace.endSection();
            }
        }

        private byte[] readAsset(String name) {
            try (InputStream in = ctx.getAssets().open(name);
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                return out.toByteArray();
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }
    }
}
