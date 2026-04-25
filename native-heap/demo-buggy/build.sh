#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BUILD="$HERE/build"
AOSP="$HOME/dev/aosp"
ANDROID_JAR="$AOSP/prebuilts/sdk/36/public/android.jar"
LAMBDA_STUBS="$AOSP/prebuilts/sdk/tools/core-lambda-stubs.jar"
AAPT2="$AOSP/out/host/linux-x86/bin/aapt2"
D8="$AOSP/out/host/linux-x86/bin/d8"
APKSIGNER="$AOSP/out/host/linux-x86/bin/apksigner"
ZIPALIGN="$AOSP/out/host/linux-x86/bin/zipalign"
TESTKEY_PK8="$AOSP/build/target/product/security/testkey.pk8"
TESTKEY_PEM="$AOSP/build/target/product/security/testkey.x509.pem"

rm -rf "$BUILD"
mkdir -p "$BUILD/classes" "$BUILD/dex" "$BUILD/lib/x86_64"

find "$HERE/src" -name '*.java' > "$BUILD/sources.txt"
javac -source 1.8 -target 1.8 \
      -bootclasspath "$ANDROID_JAR:$LAMBDA_STUBS" -cp "$ANDROID_JAR:$LAMBDA_STUBS" \
      -d "$BUILD/classes" @"$BUILD/sources.txt"

"$D8" --lib "$ANDROID_JAR" --output "$BUILD/dex" \
      $(find "$BUILD/classes" -name '*.class')

"$AAPT2" link -I "$ANDROID_JAR" \
    --manifest "$HERE/AndroidManifest.xml" -A "$HERE/assets" \
    -o "$BUILD/base.apk"

(cd "$BUILD/dex" && zip -j "$BUILD/base.apk" classes.dex)
cp "$HERE/jniLibs/x86_64/libleak.so" "$BUILD/lib/x86_64/libleak.so"
(cd "$BUILD" && zip -r base.apk lib/x86_64/libleak.so)

"$ZIPALIGN" -p -f 4 "$BUILD/base.apk" "$BUILD/aligned.apk"
"$APKSIGNER" sign --key "$TESTKEY_PK8" --cert "$TESTKEY_PEM" \
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
    --out "$BUILD/demo.apk" "$BUILD/aligned.apk"

ls -la "$BUILD/demo.apk"
