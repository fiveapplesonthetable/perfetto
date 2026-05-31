#!/usr/bin/env bash
#
# THROWAWAY (not for check-in): one-shot, on-device A/B benchmark of the Perfetto
# Java SDK track-event emit path — current High Level (HL) ABI vs the new
# Java-encoded Low Level (LL) path — across every API shape and data size.
#
# Run from external/perfetto (after applying the flag-gated emit stack):
#   tools/benchmark_java_sdk_device.sh
#
# It does the whole pipeline against the connected device:
#   1. gen_all   — regenerate Android.bp from the BUILD.gn changes the stack made
#   2. m         — build perfetto_trace_instrumentation_test (Soong)
#   3. install   — adb install the instrumentation APK
#   4. run       — am instrument once per impl (hl, ll); the impl is chosen via the
#                  `impl` arg, which sets perfetto.use_java_emit before the builder
#                  loads, so each impl runs in its own fresh process
#   5. report    — write a markdown table + print a shell summary
#
# Device selection honors ANDROID_SERIAL (as in AOSP); if unset and exactly one
# device is attached, that one is used. Skip stages with --no-gen / --no-build.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERFETTO="$(cd "$HERE/.." && pwd)"          # external/perfetto
AOSP="$(cd "$PERFETTO/../.." && pwd)"       # aosp root (external/perfetto -> external -> aosp)

ADB="${ADB:-adb}"
LUNCH="${LUNCH:-aosp_cf_x86_64_phone-trunk_staging-userdebug}"
PKG="dev.perfetto.sdk.test"
RUNNER="androidx.test.runner.AndroidJUnitRunner"
CLASS="dev.perfetto.sdk.test.PerfettoDeviceBenchmark"

ITERS=1000000
WARMUP=100000
TRIALS=5
OUT="$PERFETTO/perfetto-java-bench.md"
SERIAL="${ANDROID_SERIAL:-}"
DO_GEN=1
DO_BUILD=1

while [ $# -gt 0 ]; do
  case "$1" in
    --iters)    ITERS="$2";  shift 2 ;;
    --warmup)   WARMUP="$2"; shift 2 ;;
    --trials)   TRIALS="$2"; shift 2 ;;
    --out)      OUT="$2";    shift 2 ;;
    --serial)   SERIAL="$2"; shift 2 ;;
    --no-gen)   DO_GEN=0;    shift ;;
    --no-build) DO_BUILD=0;  shift ;;
    -h|--help)  sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

command -v "$ADB" >/dev/null 2>&1 || { echo "error: adb not on PATH (set \$ADB)" >&2; exit 1; }

# ---- resolve device (honor ANDROID_SERIAL / --serial; else require exactly one) -
if [ -z "$SERIAL" ]; then
  mapfile -t devs < <("$ADB" devices | awk 'NR>1 && $2=="device"{print $1}')
  [ "${#devs[@]}" -ge 1 ] || { echo "error: no adb device (is it booted?)" >&2; exit 1; }
  [ "${#devs[@]}" -eq 1 ] || { echo "error: multiple devices; set ANDROID_SERIAL/--serial: ${devs[*]}" >&2; exit 1; }
  SERIAL="${devs[0]}"
fi
ADBS=("$ADB" -s "$SERIAL")
echo ">> device: $SERIAL"
"${ADBS[@]}" wait-for-device
[ "$("${ADBS[@]}" shell getprop sys.boot_completed | tr -d '\r')" = "1" ] || {
  echo "error: device $SERIAL not fully booted" >&2; exit 1; }

# ---- 1. regenerate Android.bp from the stack's BUILD.gn changes ----------------
if [ "$DO_GEN" = 1 ]; then
  echo ">> gen_all (regenerating Android.bp) ..."
  "$PERFETTO/tools/gn" gen "$PERFETTO/out/bench_bp" --args='is_debug=false' >/dev/null
  "$PERFETTO/tools/gen_all" "$PERFETTO/out/bench_bp"
fi

# ---- 2 + 3. build + install the instrumentation APK ---------------------------
if [ "$DO_BUILD" = 1 ]; then
  echo ">> building perfetto_trace_instrumentation_test (m) ..."
  ( cd "$AOSP" \
      && source build/envsetup.sh >/dev/null 2>&1 \
      && lunch "$LUNCH" >/dev/null 2>&1 \
      && m perfetto_trace_instrumentation_test )
  APK="$(find "$AOSP/out" -name 'perfetto_trace_instrumentation_test.apk' 2>/dev/null | head -1)"
  [ -n "$APK" ] || { echo "error: instrumentation APK not found after build" >&2; exit 1; }
  echo ">> installing $APK"
  "${ADBS[@]}" install -r -t "$APK" >/dev/null
fi

"${ADBS[@]}" shell pm list instrumentation 2>/dev/null | grep -q "$PKG" || {
  echo "error: instrumentation $PKG not installed (build/install failed?)." >&2; exit 1; }

# ---- 4. run one fresh process per impl, scrape ns/op from logcat --------------
run_impl() { # $1 = hl|ll
  local impl="$1"
  echo ">> running impl=$impl (iters=$ITERS warmup=$WARMUP trials=$TRIALS) ..." >&2
  "${ADBS[@]}" logcat -c
  "${ADBS[@]}" shell am instrument -w \
    -e class "$CLASS" \
    -e impl "$impl" -e iters "$ITERS" -e warmup "$WARMUP" -e trials "$TRIALS" \
    "$PKG/$RUNNER" >/dev/null
  "${ADBS[@]}" logcat -d -s PERFBENCH:I | grep -oE "PERFBENCH $impl [^ ]+ [0-9.]+" || true
}

declare -A HL LL
SCENARIOS=()
note_scn() { case " ${SCENARIOS[*]} " in *" $1 "*) ;; *) SCENARIOS+=("$1") ;; esac; }
while read -r _ _ scn ns; do [ -n "${scn:-}" ] || continue; HL["$scn"]="$ns"; note_scn "$scn"; done < <(run_impl hl)
while read -r _ _ scn ns; do [ -n "${scn:-}" ] || continue; LL["$scn"]="$ns"; note_scn "$scn"; done < <(run_impl ll)
[ "${#SCENARIOS[@]}" -gt 0 ] || { echo "error: no PERFBENCH results parsed (check: adb logcat -s PERFBENCH:I)" >&2; exit 1; }

# ---- 5. markdown + summary ----------------------------------------------------
ABI="$("${ADBS[@]}" shell getprop ro.product.cpu.abi | tr -d '\r')"
MODEL="$("${ADBS[@]}" shell getprop ro.product.model | tr -d '\r')"
{
  echo "# Perfetto Java SDK emit benchmark — HL vs LL (on device)"
  echo
  echo "device: \`$MODEL\` ($ABI, serial \`$SERIAL\`) · iters=$ITERS warmup=$WARMUP best-of-$TRIALS · $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "| scenario | HL ns/op | LL ns/op | LL/HL |"
  echo "|----------|---------:|---------:|:-----:|"
  for scn in "${SCENARIOS[@]}"; do
    h="${HL[$scn]:-}"; l="${LL[$scn]:-}"
    if [ -n "$h" ] && [ -n "$l" ]; then
      ratio="$(awk -v a="$l" -v b="$h" 'BEGIN{ if(b>0) printf "%.2fx", a/b; else print "-" }')"
    else ratio="-"; fi
    echo "| $scn | ${h:-—} | ${l:-—} | $ratio |"
  done
  echo
  echo "LL/HL < 1.00 means the new Low-Level path is faster than the current High-Level ABI."
} | tee "$OUT"
echo
echo ">> wrote $OUT"
