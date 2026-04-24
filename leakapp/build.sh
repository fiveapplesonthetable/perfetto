#!/usr/bin/env bash
# Build a minimal unsigned APK for the HeapLeak demo and sign with AOSP testkey.
# Uses tools already present in the AOSP prebuilts tree.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
AOSP="$HOME/dev/aosp"
ANDROID_JAR="$AOSP/prebuilts/sdk/36/public/android.jar"
AAPT2="$AOSP/out/host/linux-x86/bin/aapt2"
D8="$AOSP/out/host/linux-x86/bin/d8"
APKSIGNER="$AOSP/out/host/linux-x86/bin/apksigner"
ZIPALIGN="$AOSP/out/host/linux-x86/bin/zipalign"
TESTKEY_PK8="$AOSP/build/target/product/security/testkey.pk8"
TESTKEY_PEM="$AOSP/build/target/product/security/testkey.x509.pem"

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/res_compiled"

echo "==> javac"
find "$HERE/src" -name '*.java' > "$BUILD/sources.txt"
LAMBDA_STUBS="$AOSP/prebuilts/sdk/tools/core-lambda-stubs.jar"
javac -source 1.8 -target 1.8 \
      -bootclasspath "$ANDROID_JAR:$LAMBDA_STUBS" \
      -cp "$ANDROID_JAR:$LAMBDA_STUBS" \
      -d "$BUILD/classes" @"$BUILD/sources.txt"

echo "==> d8 (class -> dex)"
"$D8" --lib "$ANDROID_JAR" --output "$BUILD/dex" \
      $(find "$BUILD/classes" -name '*.class')

echo "==> aapt2 link (produces APK skeleton)"
"$AAPT2" link \
    -I "$ANDROID_JAR" \
    --manifest "$HERE/AndroidManifest.xml" \
    -A "$HERE/assets" \
    -o "$BUILD/base.apk"

echo "==> adding classes.dex"
(cd "$BUILD/dex" && zip -j "$BUILD/base.apk" classes.dex)

echo "==> zipalign"
"$ZIPALIGN" -p -f 4 "$BUILD/base.apk" "$BUILD/aligned.apk"

echo "==> apksigner (v1+v2+v3 with AOSP testkey)"
"$APKSIGNER" sign \
    --key "$TESTKEY_PK8" \
    --cert "$TESTKEY_PEM" \
    --v1-signing-enabled true \
    --v2-signing-enabled true \
    --v3-signing-enabled true \
    --out "$BUILD/leakapp.apk" \
    "$BUILD/aligned.apk"

echo "==> DONE: $BUILD/leakapp.apk"
ls -la "$BUILD/leakapp.apk"
