package com.example.perfetto.dbui;

import android.app.Activity;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.Context;
import android.database.Cursor;
import android.os.Bundle;
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
        t.setText("DbUiDemo (buggy)");
        root.addView(t);
        setContentView(root);

        // The bug: open the DB and run a heavy query inline in onCreate.
        Trace.beginSection("openAndQueryOnUiThread");
        try {
            SeedHelper h = new SeedHelper(this);
            SQLiteDatabase db = h.getWritableDatabase();           // disk I/O
            seedIfEmpty(db, 5000);                                  // bulk insert
            try (Cursor c = db.rawQuery(
                    "SELECT COUNT(DISTINCT category) FROM items WHERE name LIKE ?",
                    new String[] {"%a%"})) {                       // full scan
                if (c.moveToFirst()) t.setText("categories: " + c.getInt(0));
            }
        } finally { Trace.endSection(); }
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
