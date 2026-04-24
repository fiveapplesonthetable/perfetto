package com.heapleak;

import android.graphics.Bitmap;
import java.util.ArrayList;
import java.util.List;

public class FeedAdapter {
    public static final List<Bitmap> cache = new ArrayList<>();

    public void onBindViewHolder(Bitmap bmp) {
        cache.add(bmp);
    }
}
