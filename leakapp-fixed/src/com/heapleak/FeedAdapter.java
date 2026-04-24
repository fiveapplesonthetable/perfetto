package com.heapleak;

import android.graphics.Bitmap;
import android.util.LruCache;

public class FeedAdapter {
    private static final LruCache<Integer, Bitmap> cache = new LruCache<Integer, Bitmap>(4) {
        @Override protected int sizeOf(Integer key, Bitmap value) { return 1; }
    };

    public Bitmap get(int key) {
        return cache.get(key);
    }

    public void put(int key, Bitmap bmp) {
        cache.put(key, bmp);
    }
}
