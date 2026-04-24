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
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;

public class MainActivity extends Activity {

    private static final int ASSET_KEY = 0x1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 64, 48, 48);
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView title = new TextView(this);
        title.setText("HeapLeak demo (fixed)");
        title.setTextSize(24);
        root.addView(title);

        TextView status = new TextView(this);
        status.setText("PID: " + Process.myPid());
        status.setTextSize(16);
        root.addView(status);

        setContentView(root);

        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            runScenarios();
            status.setText("Scenarios ran, no leaks.\nPID: " + Process.myPid());
        }, 800);
    }

    private void runScenarios() {
        startActivity(new Intent(this, ProfileActivity.class));

        FeedAdapter adapter = new FeedAdapter();
        byte[] pngBytes = loadAssetBytes("leaky.png");
        if (pngBytes != null) {
            for (int i = 0; i < 12; i++) {
                Bitmap bmp = adapter.get(ASSET_KEY);
                if (bmp == null) {
                    bmp = BitmapFactory.decodeByteArray(pngBytes, 0, pngBytes.length);
                    adapter.put(ASSET_KEY, bmp);
                }
            }
        }

        Toast.makeText(this, "Fixed scenarios ran. PID=" + Process.myPid(),
                       Toast.LENGTH_LONG).show();
        Log.i("HeapLeakFixed", "Fixed scenarios ran. PID=" + Process.myPid());
    }

    private byte[] loadAssetBytes(String name) {
        try (InputStream in = getAssets().open(name);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        } catch (IOException e) {
            Log.e("HeapLeakFixed", "asset " + name + " missing", e);
            return null;
        }
    }
}
