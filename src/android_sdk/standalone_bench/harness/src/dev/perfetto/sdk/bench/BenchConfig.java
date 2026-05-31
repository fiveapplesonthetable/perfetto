package dev.perfetto.sdk.bench;

import android.util.Base64;

/** Precomputed perfetto TraceConfig (track_event ds, category "bench", 8MB buffer). */
final class BenchConfig {
  private static final String B64 = "CgMIgEASGwoZCgt0cmFja19ldmVudBAAigcHEgViZW5jaA==";

  static byte[] bytes() {
    return Base64.decode(B64, Base64.DEFAULT);
  }

  private BenchConfig() {}
}
