package com.example.perfetto.jank;

import android.app.Activity;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Trace;
import android.util.LruCache;
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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class JankActivity extends Activity {

    private static final int ROW_HEIGHT_PX = 220;
    private static final int ROW_COUNT = 5000;
    private ListView list;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        list = new ListView(this);
        list.setAdapter(new GoodAdapter(this));
        setContentView(list);
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

    /**
     * Decodes off the UI thread, caches the result. The UI thread does at most a
     * cache lookup and an ImageView.setImageBitmap.
     */
    private static final class GoodAdapter extends BaseAdapter {
        private final Context ctx;
        private final byte[][] assets = new byte[5][];
        private final LruCache<Integer, Bitmap> cache = new LruCache<Integer, Bitmap>(8) {
            @Override protected int sizeOf(Integer key, Bitmap value) { return 1; }
        };
        private final ExecutorService decoder = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "BitmapDecoder");
            t.setDaemon(true);
            return t;
        });
        private final Handler ui = new Handler(Looper.getMainLooper());

        GoodAdapter(Context ctx) {
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
            Trace.beginSection("GoodAdapter.getView");
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

                final int key = position % assets.length;
                final ImageView iv = (ImageView) row.findViewById(1);
                Bitmap cached = cache.get(key);
                if (cached != null) {
                    iv.setImageBitmap(cached);
                } else {
                    iv.setImageBitmap(null);
                    final byte[] bytes = assets[key];
                    decoder.submit(() -> {
                        Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                        ui.post(() -> {
                            cache.put(key, bmp);
                            // Re-bind only if this row is still showing the same key.
                            if (iv.getTag() == null || ((Integer) iv.getTag()) == key) {
                                iv.setImageBitmap(bmp);
                            }
                        });
                    });
                    iv.setTag(key);
                }
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
