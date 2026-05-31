#!/usr/bin/env bash
# Install (non-incremental!) -> force AOT speed -> verify compiled -> run hl+ll
# -> print HL-vs-LL ns/op table. Usage: run_bench.sh [iters] [warmup] [trials]
set -euo pipefail
export ADB_SERVER_SOCKET=tcp:192.168.122.1:5037
ADB="/home/zim/cf/bin/adb -s 94LBA009A6"
PKG=dev.perfetto.sdk.test
RUNNER="$PKG/dev.perfetto.sdk.bench.BenchInstrumentation"
APK=/mnt/agent/perfetto-benchkit/out/bench.apk
ITERS="${1:-1000000}"; WARMUP="${2:-100000}"; TRIALS="${3:-5}"
OUT=/mnt/agent/perfetto-benchkit/results

mkdir -p "$OUT"
echo ">> install (non-incremental) + AOT speed"
$ADB install -r -t --no-incremental "$APK" >/dev/null 2>&1
$ADB shell cmd package compile -m speed -f $PKG >/dev/null 2>&1
st=$($ADB shell dumpsys package dexopt 2>/dev/null | grep -A2 "\[$PKG\]" | grep -oE 'status=[a-z-]+' | head -1)
echo "   dexopt $st"
[ "$st" = "status=speed" ] || { echo "ABORT: not AOT-compiled ($st)"; exit 1; }

run_impl() { # $1=hl|ll
  $ADB logcat -c
  $ADB shell am instrument -w --no-hidden-api-checks -e impl "$1" -e iters "$ITERS" -e warmup "$WARMUP" -e trials "$TRIALS" \
    "$RUNNER" >/dev/null 2>&1
  $ADB logcat -d -s PERFBENCH:I 2>/dev/null | grep -oE "PERFBENCH $1 [^ ]+ [0-9.]+" | awk '{print $3, $4}'
}

echo ">> run hl (iters=$ITERS warmup=$WARMUP trials=$TRIALS)"; run_impl hl > "$OUT/hl.txt"
echo ">> run ll"; run_impl ll > "$OUT/ll.txt"

echo
printf "%-26s %12s %12s %8s\n" "scenario" "HL ns/op" "LL ns/op" "LL/HL"
printf "%-26s %12s %12s %8s\n" "--------" "--------" "--------" "-----"
worse=0
while read -r scn hl; do
  ll=$(awk -v s="$scn" '$1==s{print $2}' "$OUT/ll.txt")
  [ -n "$ll" ] || continue
  ratio=$(awk -v a="$ll" -v b="$hl" 'BEGIN{printf "%.2f", a/b}')
  flag=""; awk -v a="$ll" -v b="$hl" 'BEGIN{exit !(a>b)}' && { flag=" <-- LL slower"; worse=$((worse+1)); }
  printf "%-26s %12s %12s %8s%s\n" "$scn" "$hl" "$ll" "${ratio}x" "$flag"
done < "$OUT/hl.txt"
echo
echo "scenarios where LL is slower than HL: $worse"
