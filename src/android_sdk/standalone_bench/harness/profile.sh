#!/usr/bin/env bash
# Profile ONE scenario under simpleperf. Assumes apk already installed + AOT'd.
# Usage: profile.sh <impl> <scenario> [iters] [seconds]
set -euo pipefail
export ADB_SERVER_SOCKET=tcp:192.168.122.1:5037
ADB="/home/zim/cf/bin/adb -s 94LBA009A6"
PKG=dev.perfetto.sdk.test
RUNNER="$PKG/dev.perfetto.sdk.bench.BenchInstrumentation"
IMPL="$1"; SCN="$2"; ITERS="${3:-60000000}"; SECS="${4:-10}"

$ADB logcat -c
# run the single scenario in the background (one long trial so simpleperf can sample it)
$ADB shell am instrument -w --no-hidden-api-checks -e impl "$IMPL" -e scenario "$SCN" \
  -e iters "$ITERS" -e warmup 200000 -e trials 1 "$RUNNER" >/dev/null 2>&1 &
INSTR_PID=$!
# wait for the worker process and grab its pid
pid=""
for i in $(seq 1 50); do
  pid=$($ADB shell pidof "$PKG" 2>/dev/null | tr -d '\r' | awk '{print $1}')
  [ -n "$pid" ] && break
  sleep 0.2
done
[ -n "$pid" ] || { echo "could not find $PKG pid"; exit 1; }
echo ">> profiling $IMPL/$SCN pid=$pid for ${SECS}s"
sleep 1  # let it get past warmup into steady state
$ADB shell "su -c '/system/bin/simpleperf record -p $pid -g -f 4000 --duration $SECS -o /data/local/tmp/perf_${IMPL}_${SCN//\//_}.data'" 2>&1 | tail -2
echo ">> top symbols ($IMPL/$SCN):"
$ADB shell "su -c '/system/bin/simpleperf report -i /data/local/tmp/perf_${IMPL}_${SCN//\//_}.data --sort symbol -n --percent-limit 1.5'" 2>&1 \
  | grep -vE '^#|^$|Cmdline|Arch|Event|Samples|Event count' | head -30
wait $INSTR_PID 2>/dev/null || true
