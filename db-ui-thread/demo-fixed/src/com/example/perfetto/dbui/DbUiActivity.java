package com.example.perfetto.dbui;

import android.app.Activity;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.Context;
import android.database.Cursor;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.Trace;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

public class DbUiActivity extends Activity {

    @Override
    protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        TextView t = new TextView(this);
        t.setText("DbUiDemo (fixed)");
        root.addView(t);
        setContentView(root);

        // Fix: open the DB and run the query on a background thread.
        // Activity returns from onCreate immediately; first frame renders.
        HandlerThread bg = new HandlerThread("Db"); bg.start();
        new Handler(bg.getLooper()).post(() -> {
            Trace.beginSection("openAndQueryOffMainThread");
            try {
                SeedHelper h = new SeedHelper(this);
                SQLiteDatabase db = h.getWritableDatabase();
                seedIfEmpty(db, 5000);
                int categories;
                try (Cursor c = db.rawQuery(
                        "SELECT COUNT(DISTINCT category) FROM items WHERE name LIKE ?",
                        new String[] {"%a%"})) {
                    categories = c.moveToFirst() ? c.getInt(0) : 0;
                }
                final int cats = categories;
                new Handler(Looper.getMainLooper()).post(() -> t.setText("categories: " + cats));
            } finally { Trace.endSection(); }
        });
    }

    private static void seedIfEmpty(SQLiteDatabase db, int n) {
        try (Cursor c = db.rawQuery("SELECT COUNT(*) FROM items", null)) {
            if (c.moveToFirst() && c.getInt(0) >= n) return;
        }
        db.beginTransaction();
        try {
            for (int i = 0; i < n; i++) {
                db.execSQL("INSERT INTO items(name,category) VALUES(?,?)",
                          new Object[]{"item-" + i, "cat-" + (i % 50)});
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
    }

    static class SeedHelper extends SQLiteOpenHelper {
        SeedHelper(Context c) { super(c, "items.db", null, 1); }
        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT, category TEXT)");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int o, int n) {}
    }
}
