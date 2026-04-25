package com.example.perfetto.startup;

import android.app.Application;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Trace;

public class StartupApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        // Hand all three "SDK" initializers to a background thread so
        // Application.onCreate returns immediately and the launcher
        // activity can render its first frame.
        HandlerThread bg = new HandlerThread("AppInit");
        bg.start();
        Handler h = new Handler(bg.getLooper());
        h.post(this::initAnalytics);
        h.post(this::initCrashReporter);
        h.post(this::initImageLoader);
    }

    private void initAnalytics() {
        Trace.beginSection("Analytics.init");
        try { Thread.sleep(550); } catch (InterruptedException e) {}
        Trace.endSection();
    }

    private void initCrashReporter() {
        Trace.beginSection("CrashReporter.init");
        try { Thread.sleep(800); } catch (InterruptedException e) {}
        Trace.endSection();
    }

    private void initImageLoader() {
        Trace.beginSection("ImageLoader.init");
        try { Thread.sleep(1200); } catch (InterruptedException e) {}
        Trace.endSection();
    }
}
