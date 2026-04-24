package com.heapleak;

import android.app.Activity;
import android.graphics.Bitmap;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class ProfileActivity extends Activity {

    private static Bitmap cachedAvatar;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(48, 64, 48, 48);
        root.setGravity(Gravity.CENTER_HORIZONTAL);

        TextView title = new TextView(this);
        title.setText("ProfileActivity (fixed)");
        title.setTextSize(22);
        root.addView(title);

        for (int i = 0; i < 20; i++) {
            TextView tv = new TextView(this);
            tv.setText("row #" + i + " payload=" + Math.random());
            root.addView(tv);
        }
        setContentView(root);

        new Handler(Looper.getMainLooper()).postDelayed(this::finish, 400);
    }
}
