package com.example.perfetto.startup;

import android.app.Application;
import android.os.Trace;

public class StartupApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        // Three "SDKs" initialised serially on the main thread before
        // the launcher activity can show its first frame.
        initAnalytics();
        initCrashReporter();
        initImageLoader();
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
