package com.heapleak;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.util.Log;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

public class MainActivity extends Activity {

    public static final List<String>  DUPLICATE_STRINGS = new ArrayList<>();
    public static final List<byte[]>  DUPLICATE_ARRAYS  = new ArrayList<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 64, 48, 48);
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView title = new TextView(this);
        title.setText("HeapLeak demo");
        title.setTextSize(24);
        root.addView(title);

        TextView status = new TextView(this);
        status.setText("PID: " + Process.myPid());
        status.setTextSize(16);
        root.addView(status);

        setContentView(root);

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            triggerAllLeaks();
            status.setText("Leaks triggered. Awaiting dump.\nPID: " + Process.myPid());
        }, 800);
    }

    private void triggerAllLeaks() {
        // 1) Leaked Activity via static companion-object-equivalent field (ProfileActivity.last).
        startActivity(new Intent(this, ProfileActivity.class));

        // 2) Duplicate bitmaps held by FeedAdapter.cache (a static list that only grows).
        FeedAdapter adapter = new FeedAdapter();
        byte[] pngBytes = loadAssetBytes("leaky.png");
        if (pngBytes != null) {
            for (int i = 0; i < 12; i++) {
                Bitmap bmp = BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.length);
                if (bmp != null) adapter.onBindViewHolder(bmp);
            }
        }

        // 3) Duplicate strings — ambient content for the Strings tab tour shot.
        String template = "user config payload: theme=dark, locale=en_US, region=NA, v=7";
        for (int i = 0; i < 80; i++) {
            DUPLICATE_STRINGS.add(new String(template.toCharArray()));
        }

        // 4) Duplicate byte[] — ambient content for the Arrays tab tour shot.
        byte[] src = new byte[8192];
        Arrays.fill(src, (byte) 0xAB);
        for (int i = 0; i < 10; i++) {
            DUPLICATE_ARRAYS.add(src.clone());
        }

        Toast.makeText(this, "Leaks triggered. PID=" + Process.myPid(),
                       Toast.LENGTH_LONG).show();
        Log.i("HeapLeak", "Leaks triggered. PID=" + Process.myPid()
                + " bitmaps=" + FeedAdapter.cache.size()
                + " strings=" + DUPLICATE_STRINGS.size()
                + " arrays=" + DUPLICATE_ARRAYS.size());
    }

    private byte[] loadAssetBytes(String name) {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            Log.e("HeapLeak", "asset " + name + " missing", e);
            return null;
        }
    }
}
