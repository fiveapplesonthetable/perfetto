#!/usr/bin/env bash
# Standalone build of the Perfetto Java SDK emit-benchmark APK.
# No AOSP/Soong, no framework perfetto: the APK bundles ONLY the SDK java from
# the perfetto GH checkout + the benchmark driver + libperfetto_jni.so (arm64).
#
# Stages (override with: build_apk.sh [compile|dex|apk|all], default all):
#   compile  javac SDK + bench + annotation stubs  -> classes/
#   dex      d8 the dev/ classes only              -> classes.dex
#   apk      aapt2 link + add dex + .so + sign      -> bench.apk
set -euo pipefail

KIT=/mnt/agent/perfetto-benchkit
REPO=/mnt/agent/perfetto/bench-wt
SDK_SRC="$REPO/src/android_sdk/java/main/dev/perfetto/sdk"
SO="$REPO/out/android/stripped/libperfetto_jni.so"

ANDROID_JAR=/mnt/agent/aosp/prebuilts/sdk/34/public/android.jar
AAPT2=/mnt/agent/aosp/prebuilts/sdk/tools/linux/bin/aapt2
APKSIGNER="java -jar /mnt/agent/aosp/prebuilts/sdk/tools/linux/lib/apksigner.jar"
D8="java -cp /mnt/agent/aosp/prebuilts/r8/r8.jar com.android.tools.r8.D8"
ZIPALIGN=/mnt/agent/aosp/prebuilts/build-tools/linux-x86/bin/zipalign

OUT="$KIT/out"
STAGE="${1:-all}"
mkdir -p "$OUT"

compile() {
  echo ">> javac (SDK + bench + stubs)"
  rm -rf "$OUT/classes"; mkdir -p "$OUT/classes"
  javac -source 17 -target 17 -encoding UTF-8 -nowarn -implicit:none \
    -cp "$ANDROID_JAR" \
    -d "$OUT/classes" \
    $(find "$KIT/stubs" -name '*.java') \
    "$SDK_SRC"/*.java \
    "$KIT/src/dev/perfetto/sdk/bench/"*.java
  echo "   compiled $(find "$OUT/classes" -name '*.class' | wc -l) classes"
}

dex() {
  echo ">> d8 (dev/ classes only -> classes.dex; stubs excluded)"
  # Only dex the perfetto SDK + bench. dalvik.* / errorprone stubs are NOT dexed:
  # CriticalNative/FastNative descriptors stay on methods (ART uses the real
  # platform annotation from the boot classpath at runtime).
  local cls; cls=$(cd "$OUT/classes" && find dev -name '*.class')
  rm -rf "$OUT/dex"; mkdir -p "$OUT/dex"
  ( cd "$OUT/classes" && $D8 --release --min-api 33 --lib "$ANDROID_JAR" \
      --output "$OUT/dex" $cls )
  echo "   $(unzip -l "$OUT/dex/classes.dex" >/dev/null 2>&1 && echo dex.jar || ls -la "$OUT/dex/classes.dex")"
}

apk() {
  echo ">> aapt2 link (manifest only, no resources)"
  "$AAPT2" link --manifest "$KIT/AndroidManifest.xml" -I "$ANDROID_JAR" \
    --min-sdk-version 33 --target-sdk-version 34 \
    -o "$OUT/base.apk"
  echo ">> add classes.dex + lib/arm64-v8a/libperfetto_jni.so"
  ( cd "$OUT/dex" && zip -q "$OUT/base.apk" classes.dex )
  rm -rf "$OUT/lib"; mkdir -p "$OUT/lib/lib/arm64-v8a"
  cp "$SO" "$OUT/lib/lib/arm64-v8a/libperfetto_jni.so"
  cp "$REPO/out/android/stripped/libperfetto_c.so" "$OUT/lib/lib/arm64-v8a/libperfetto_c.so"
  ( cd "$OUT/lib" && zip -qr "$OUT/base.apk" lib )
  echo ">> zipalign + sign"
  rm -f "$OUT/bench.apk"
  "$ZIPALIGN" -p -f 4 "$OUT/base.apk" "$OUT/bench-aligned.apk"
  $APKSIGNER sign --ks "$KIT/debug.keystore" --ks-pass pass:android \
    --ks-key-alias androiddebugkey --key-pass pass:android \
    --out "$OUT/bench.apk" "$OUT/bench-aligned.apk"
  $APKSIGNER verify -v "$OUT/bench.apk" | head -5
  echo "   => $OUT/bench.apk ($(du -h "$OUT/bench.apk" | cut -f1))"
}

case "$STAGE" in
  compile) compile ;;
  dex) dex ;;
  apk) apk ;;
  all) compile; dex; apk ;;
  *) echo "unknown stage $STAGE"; exit 2 ;;
esac
