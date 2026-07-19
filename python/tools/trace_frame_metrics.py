#!/usr/bin/env python3
# Copyright (C) 2026 The Android Open Source Project
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Frame-based trace metrics from the android.display.video capture.

Perfetto's app-startup metrics report time-to-initial-display (the first frame)
and time-to-full-display (reportFullyDrawn). Neither is when the app's content
actually settles on screen: the first frame is often a blank window or splash,
and reportFullyDrawn is app-declared and frequently wrong or missing. This looks
at what was *actually on screen*: it decodes the recorded display video during
each startup and finds when the screen settles - when it reaches its final
appearance and holds it - reporting that per process next to the startup table's
numbers. The settle detection is per screen-region so it sees through a static
splash to the real content, catches content that fades in gradually, and ignores
a perpetually live region (video, camera viewfinder, a game animation). Each
startup's window ends at the user's first touch, so what the user did after the
app was up isn't mistaken for the app still loading.

`--metric startup` (the default) is the only metric today; the frame-settle core
is reusable for others.

Requires PyAV (`pip install av`) and numpy. trace_processor is downloaded
automatically unless --trace-processor points at a local build.

Example:
  trace_frame_metrics.py trace.perfetto-trace --metric startup
"""

import argparse
import io
import os
import shutil
import subprocess
import sys
import tempfile

ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(ROOT_DIR)
sys.path.append(os.path.join(ROOT_DIR, 'python'))

from python.perfetto.trace_processor import TraceProcessor
from python.perfetto.trace_processor import TraceProcessorConfig

# All thresholds below are device- and frame-rate-independent by construction:
#  - Frames are downscaled to a fixed AREA preserving aspect (so a 1080p or 720p,
#    portrait or landscape capture all reduce to the same analysis resolution),
#    and the grid uses a fixed CELL_PX cell size, so a "cell" always covers the
#    same fraction of the screen regardless of the source resolution.
#  - Change is measured as a mean-abs pixel difference in 0..1 (normalised by the
#    cell's area and the colour range), so a threshold means the same thing on any
#    display.
#  - Every window and duration is in nanoseconds, and "live" is a fraction of the
#    frames in a time window - both independent of the capture frame rate.
DIFF_AREA = 14400  # target pixel area of the downscaled analysis frame (~160x90)
CELL_PX = 10       # analysis grid cell size (px on the downscaled frame)
# Each cell's settled value is the median of that cell over the last FINAL_WIN_NS
# of the window - a robust reference for "what the screen ended up looking like".
FINAL_WIN_NS = 800_000_000
# A cell this far (mean-abs, 0..1) from its own final value still counts as
# changing; at or below it the cell has reached its settled appearance.
CELL_SETTLE_THRESH = 0.030
# Frame-to-frame cell motion at or above this counts as movement.
CELL_MOVE_THRESH = 0.020
# A cell that moves in at least this fraction of the window's TAIL (a truly live
# region keeps moving right up to the end; a one-off content transition doesn't).
LIVE_TAIL_NS = 800_000_000
LIVE_CELL_FRAC = 0.30
# If at least this fraction of cells are live, the startup is classed 'live'.
LIVE_REGION_FRAC = 0.20
# A frame counts as "at final" once this fraction of the non-live cells match
# their final value; settle = the first frame that then holds for STABLE_NS.
AT_FINAL_FRAC = 0.95
# Never look further than this from the startup start.
SETTLE_CAP_NS = 8_000_000_000
# The window also ends at the user's first touch (past this guard, which skips the
# launch gesture): after the user interacts it's no longer the app loading.
GESTURE_IGNORE_NS = 300_000_000
# The settled look must hold at least this long before the window closes for the
# startup to count as fully settled ('ok'); otherwise it's still-changing.
STABLE_NS = 400_000_000

def die(msg):
  print(msg, file=sys.stderr)
  sys.exit(1)


VIDEO_TABLE = '__intrinsic_video_frames'
AU_FN = '__intrinsic_video_frame_au_data'


def query_video(tp):
  """(codec demuxer name, config bytes, [(ts, au_data)]) from the trace_processor
  video-frame table - the same source trace_video_conv uses."""
  ids = [
      r.display_id for r in tp.query(
          f'SELECT DISTINCT display_id FROM {VIDEO_TABLE} ORDER BY display_id')
  ]
  if not ids:
    die('No android.display.video frames in this trace; startup-frame analysis '
        'needs the screen recording.')
  rows = list(
      tp.query(f'''
        SELECT ts,
               COALESCE(is_config, 0) AS is_config,
               codec_string AS codec,
               {AU_FN}(id) AS data
        FROM {VIDEO_TABLE}
        WHERE display_id = {ids[0]}
        ORDER BY ts, id'''))
  codec = next((r.codec for r in rows if r.codec), '') or ''
  fmt = 'hevc' if codec.lower().startswith(('hvc', 'hev')) else 'h264'
  config = b''.join(r.data for r in rows if r.is_config)
  frames = [(r.ts, r.data) for r in rows if not r.is_config]
  return fmt, config, frames


def diff_dims(src_w, src_h):
  """Analysis (width, height) for a source frame: downscale to ~DIFF_AREA pixels
  preserving aspect (so portrait stays portrait, not squished into landscape),
  each dim a whole number of CELL_PX cells. Resolution- and aspect-independent."""
  aspect = (src_w / src_h) if src_h else 1.0
  h = (DIFF_AREA / aspect)**0.5
  gw = max(1, round(h * aspect / CELL_PX))
  gh = max(1, round(h / CELL_PX))
  return gw * CELL_PX, gh * CELL_PX


def decode_frames(fmt, config, frames):
  """Decode every frame to a small RGB array. Returns (ts_array, [ndarray]) in
  capture order. Decode order == capture order (the screen encoder emits no
  B-frames), so the i-th decoded picture is frames[i]. RGB (not luma) so a
  colour change with little brightness change - e.g. a coloured splash giving
  way to a dark app - still registers."""
  import av
  import numpy as np
  stream = config + b''.join(d for _, d in frames)
  imgs = []
  dw = dh = None
  with av.open(io.BytesIO(stream), format=fmt) as container:
    for pic in container.decode(video=0):
      if dw is None:
        dw, dh = diff_dims(pic.width, pic.height)
      rgb = pic.reformat(width=dw, height=dh, format='rgb24')
      imgs.append(rgb.to_ndarray().astype(np.int16))
  n = min(len(imgs), len(frames))
  if len(imgs) != len(frames):
    print(f'warning: decoded {len(imgs)} frames but {len(frames)} in trace; '
          f'using first {n}.', file=sys.stderr)
  ts = [frames[i][0] for i in range(n)]
  return ts, imgs[:n]


def settle_frame(ts, imgs, start_ns, next_start_ns, first_touch_ns):
  """Find when the screen reaches its final settled appearance during a startup.

  Two ideas make this robust. (1) Each grid cell is compared against its OWN final
  value (median over the last FINAL_WIN_NS of the window): a static splash differs
  from the final content, so it is not mistaken for settled, and content that fades
  in gradually (each frame barely different) is still caught. The settle time is
  the first frame that is "at final" (nearly all non-live cells match their final)
  and then holds for STABLE_NS - so an isolated later blip can't drag it. (2) The
  window ends at the user's first touch (past a short launch-gesture guard): once
  the user interacts, later change is interaction, not the app loading. It is also
  capped at the next startup and at SETTLE_CAP_NS. Cells that keep moving through
  the window's tail (video, camera viewfinder, a game animation) are excluded so
  their motion doesn't stop the surrounding UI from settling.

  Returns (settle_ts, change_from_first, status): status is 'ok' (settled and
  held), 'still-changing' (never held for STABLE_NS) or 'live' (a large region
  keeps moving). Returns (None, None, None) if there are <2 frames."""
  import numpy as np
  win_end = min(start_ns + SETTLE_CAP_NS, (next_start_ns or 1 << 62) - 1,
                first_touch_ns or 1 << 62)
  idx = [i for i in range(len(ts)) if start_ns <= ts[i] <= win_end]
  if len(idx) < 2:
    return None, None, None
  tarr = np.array([ts[i] for i in idx], dtype=np.int64)
  tw = tarr[-1]
  n = len(idx)
  # Grid derived from the frame's own size, at a fixed CELL_PX cell size, so a
  # cell always covers the same fraction of the screen on any resolution/aspect.
  fh, fw = imgs[idx[0]].shape[:2]
  gh, gw = fh // CELL_PX, fw // CELL_PX
  # Mean colour per grid cell, per frame -> (n, gh, gw, 3).
  cm = np.stack([
      imgs[i][:gh * CELL_PX, :gw * CELL_PX].reshape(
          gh, CELL_PX, gw, CELL_PX, 3).mean(axis=(1, 3)) for i in idx])
  final = np.median(cm[tarr >= tw - FINAL_WIN_NS], axis=0)
  dev = np.abs(cm - final).mean(3) / 255.0            # (n,gh,gw) distance to final
  move = np.zeros((n, gh, gw))                        # frame-to-frame cell motion
  move[1:] = np.abs(cm[1:] - cm[:-1]).mean(3) / 255.0
  tail = tarr >= tw - LIVE_TAIL_NS
  live = (move[tail] >= CELL_MOVE_THRESH).mean(0) >= LIVE_CELL_FRAC
  use = ~live if (~live).any() else np.ones((gh, gw), bool)
  # A frame is "at final" once nearly all non-live cells match their final value;
  # settle = the first such frame that then stays at-final for >= STABLE_NS.
  at_final = (dev <= CELL_SETTLE_THRESH)[:, use].mean(1) >= AT_FINAL_FRAC
  settle_ts, held = None, False
  for k in range(n):
    if not at_final[k]:
      continue
    j = k
    while j < n and tarr[j] - tarr[k] < STABLE_NS:
      j += 1
    if at_final[k:min(j + 1, n)].all():
      settle_ts, held = int(tarr[k]), True
      break
  frac_live = float(live.mean())
  if settle_ts is None:                               # never held for STABLE_NS
    onsets = np.where(at_final)[0]
    settle_ts = int(tarr[onsets[-1]]) if len(onsets) else int(tarr[-1])
  if frac_live >= LIVE_REGION_FRAC:
    status = 'live'
  elif held:
    status = 'ok'
  else:
    status = 'still-changing'
  # How different the settled screen is from the first captured frame; a small
  # value means little visibly loaded (e.g. only a splash was seen).
  settled_i = idx[int(np.searchsorted(tarr, settle_ts, 'right')) - 1]
  change = float(np.abs(imgs[settled_i].astype(np.int16)
                        - imgs[idx[0]].astype(np.int16)).mean()) / 255.0
  return settle_ts, change, status


def query_startups(tp):
  tp.query('INCLUDE PERFETTO MODULE android.startup.startups;')
  tp.query('INCLUDE PERFETTO MODULE android.startup.time_to_display;')
  return list(
      tp.query('''
        SELECT s.startup_id AS id, s.ts AS ts, s.ts_end AS ts_end,
               s.dur AS dur, s.package AS package, s.startup_type AS type,
               p.upid AS upid, p.pid AS pid, pr.name AS process,
               t.time_to_initial_display AS ttid,
               t.time_to_full_display AS ttfd
        FROM android_startups s
        JOIN android_startup_processes p USING (startup_id)
        LEFT JOIN process pr ON pr.upid = p.upid
        LEFT JOIN android_startup_time_to_display t USING (startup_id)
        ORDER BY s.ts'''))


def query_touch_ts(tp):
  """Sorted timestamps of user input events - used to end a startup's measurement
  window at the first touch (after that the screen changes because of the user,
  not the app loading)."""
  return sorted(r.ts for r in tp.query('''
      SELECT ts FROM slice
      WHERE name IN ('deliverInputEvent', 'View#onTouchEvent', 'TIS.onInputEvent')
      ORDER BY ts'''))


def first_touch_after(touch_ts, start_ns):
  """First touch at least GESTURE_IGNORE_NS after start (skipping the launch
  gesture itself), or None."""
  import bisect
  i = bisect.bisect_left(touch_ts, start_ns + GESTURE_IGNORE_NS)
  return touch_ts[i] if i < len(touch_ts) else None


def ms(ns):
  return '-' if ns is None else f'{ns / 1e6:.1f}'


def save_frames(fmt, config, frames, targets, out_dir):
  """Re-decode and save the full-colour frame at each target index as a PNG,
  named <label>.png. This is the 'here is the frame we measured it at' output,
  the direct analogue of a high-speed-camera capture."""
  import av
  os.makedirs(out_dir, exist_ok=True)
  want = dict(targets)
  stream = config + b''.join(d for _, d in frames)
  saved = 0
  with av.open(io.BytesIO(stream), format=fmt) as container:
    for i, pic in enumerate(container.decode(video=0)):
      if i in want:
        rgb = pic.reformat(format='rgb24').to_ndarray()
        _write_png(os.path.join(out_dir, f'{want[i]}.png'), rgb)
        saved += 1
  return saved


def _write_png(path, rgb):
  """Write an HxWx3 uint8 RGB array as a PNG (no Pillow dependency)."""
  import struct
  import zlib
  h, w = rgb.shape[0], rgb.shape[1]
  rows = bytearray()
  data = rgb.astype('uint8').tobytes()
  stride = w * 3
  for y in range(h):
    rows.append(0)  # filter type 0
    rows += data[y * stride:(y + 1) * stride]

  def chunk(typ, payload):
    return (struct.pack('>I', len(payload)) + typ + payload +
            struct.pack('>I', zlib.crc32(typ + payload) & 0xffffffff))

  with open(path, 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n')
    f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
    f.write(chunk(b'IDAT', zlib.compress(bytes(rows), 6)))
    f.write(chunk(b'IEND', b''))


SHEET_TILE_H = 300  # each settled frame is scaled to this height for the sheet
SHEET_PAD = 4
FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
]


def contact_sheet(fmt, config, frames, recs, cols, out_path):
  """Tile each startup's settled frame into one labelled PNG - a high-speed-
  camera-style summary: one *content* thumbnail per launch (the settled frame,
  not the launch-moment splash), labelled with the process and settle time.
  Returns the number of tiles."""
  import av
  import numpy as np
  targets = {r['_frame_index']: r for r in recs if r['_frame_index'] is not None}
  if not targets:
    die('no settled frames to put on a contact sheet.')
  decoded = {}
  stream = config + b''.join(d for _, d in frames)
  last = max(targets)
  with av.open(io.BytesIO(stream), format=fmt) as container:
    for i, pic in enumerate(container.decode(video=0)):
      if i in targets:
        tw = max(1, round(SHEET_TILE_H * pic.width / pic.height))
        decoded[i] = pic.reformat(
            width=tw, height=SHEET_TILE_H, format='rgb24').to_ndarray()
      if i >= last:
        break
  order = sorted(((decoded[i], targets[i]) for i in targets if i in decoded),
                 key=lambda t: t[1]['startup_id'])
  if not order:
    die('could not decode any settled frame for the contact sheet.')

  th, tw = order[0][0].shape[:2]
  n = len(order)
  cols = cols or min(n, 6)
  rows = (n + cols - 1) // cols
  p = SHEET_PAD
  canvas = np.full((rows * (th + p) + p, cols * (tw + p) + p, 3), 24, np.uint8)
  placed = []
  for j, (img, r) in enumerate(order):
    rr, cc = divmod(j, cols)
    y, x = p + rr * (th + p), p + cc * (tw + p)
    canvas[y:y + th, x:x + tw] = img
    proc = (r['process'] or r['package'] or '?').split('.')[-1]
    tag = '' if r['status'] == 'ok' else f" [{r['status']}]"
    placed.append((x + 4, y + 4,
                   f"{r['startup_id']} {proc} {r['settled_ms']:.0f}ms{tag}"))
  _write_png(out_path, canvas)
  _label_png(out_path, placed, max(round(th * 0.05), 12))
  return n


def _label_png(png_path, placed, fontsize):
  """Burn each tile's label onto the sheet with ffmpeg drawtext. Skipped with a
  warning if ffmpeg isn't on PATH (the sheet is still written, unlabelled)."""
  if not shutil.which('ffmpeg'):
    print('note: ffmpeg not found; contact sheet written without labels.',
          file=sys.stderr)
    return
  font = next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)
  font_opt = f"fontfile='{font}':" if font else ''
  tmp = tempfile.mkdtemp()
  try:
    filters = []
    for i, (x, y, label) in enumerate(placed):
      tf = os.path.join(tmp, f'{i}.txt')
      with open(tf, 'w') as f:
        f.write(label)
      filters.append(
          f'drawtext={font_opt}textfile={tf}:fontcolor=white:fontsize={fontsize}'
          f':x={x}:y={y}:box=1:boxcolor=black@0.5:boxborderw=3')
    out = os.path.join(tmp, 'out.png')
    proc = subprocess.run(
        ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error', '-i', png_path,
         '-vf', ','.join(filters), out],
        capture_output=True, text=True)
    if proc.returncode != 0:
      die(f'ffmpeg failed labelling the contact sheet:\n{proc.stderr.strip()}')
    shutil.move(out, png_path)
  finally:
    shutil.rmtree(tmp, ignore_errors=True)


def nms(ns):
  """ns -> milliseconds as a rounded float, or None."""
  return None if ns is None else round(ns / 1e6, 1)


def measure_startups(tp, want_frames):
  """Build one record per startup, pairing the trace's reported numbers with the
  measured on-screen settle time. Returns (fmt, config, frames, records)."""
  # Check for startups first so a video-only trace fails with the right message.
  startups = query_startups(tp)
  if not startups:
    die('No app startups found in this trace. It needs process/activity data '
        '(atrace am/wm, ftrace) so the android.startup module can detect them.')
  fmt, config, frames = query_video(tp)
  print(f'Decoding {len(frames)} display-video frames...', file=sys.stderr)
  ts, imgs = decode_frames(fmt, config, frames)
  starts = sorted(s.ts for s in startups)
  touch_ts = query_touch_ts(tp)

  recs = []
  for s in startups:
    nxt = next((t for t in starts if t > s.ts), None)
    touch = first_touch_after(touch_ts, s.ts)
    settled_ts, change, status = settle_frame(ts, imgs, s.ts, nxt, touch)
    proc = s.process or s.package or '?'
    settled_ns = None if settled_ts is None else settled_ts - s.ts
    r = {
        'startup_id': s.id,
        'upid': s.upid,
        'pid': s.pid,
        'process': proc,
        'package': s.package,
        'startup_type': s.type,
        'start_ts': s.ts,
        'reported_ttid_ms': nms(s.ttid),
        'reported_ttfd_ms': nms(s.ttfd),
        'reported_dur_ms': nms(s.dur),
        'settled_ts': settled_ts,
        'settled_ms': nms(settled_ns),
        'change': None if change is None else round(change, 4),
        'status': 'no-video' if settled_ts is None else status,
        'frame_png': None,
        '_frame_index': None if settled_ts is None else ts.index(settled_ts),
        # Raw ns kept for the SQL (debug tracks want ns); the ms above are for
        # the human table / JSON only.
        '_dur_ns': s.dur,
        '_ttid_ns': s.ttid,
        '_ttfd_ns': s.ttfd,
        '_settled_ns': settled_ns,
    }
    if settled_ts is not None and want_frames:
      short = proc.split('.')[-1] or proc
      r['frame_png'] = (f'startup{s.id:02d}-{short}-'
                        f'settled-{settled_ns // 1_000_000}ms.png')
    recs.append(r)
  return fmt, config, frames, recs


def render_startup_table(recs):
  hdr = (f'{"id":>3} {"upid":>5} {"process":<26} {"type":>5} '
         f'{"dur":>7} {"ttid":>7} {"ttfd":>7} {"settled":>8} {"Δ%":>4} '
         f'{"status":<14} {"settled_ts":>18}')
  print(hdr)
  print('-' * len(hdr))

  def m(x):
    return '-' if x is None else f'{x:.1f}'

  for r in recs:
    dpct = '-' if r['change'] is None else f'{r["change"] * 100:.0f}'
    abs_ts = '-' if r['settled_ts'] is None else str(r['settled_ts'])
    print(f'{r["startup_id"]:>3} {r["upid"]:>5} {r["process"][:26]:<26} '
          f'{(r["startup_type"] or "?"):>5} '
          f'{m(r["reported_dur_ms"]):>7} {m(r["reported_ttid_ms"]):>7} '
          f'{m(r["reported_ttfd_ms"]):>7} {m(r["settled_ms"]):>8} {dpct:>4} '
          f'{r["status"]:<14} {abs_ts:>18}')
  print('\nreported = what the trace\'s android.startup module told you; '
        'settled = what the recorded screen actually showed. Times in ms from '
        'the startup start.')
  print('  dur         startup slice duration - the framework\'s standard '
        'startup time (intent -> Displayed); always present')
  print('  ttid        time to initial display: first frame drawn (often a '
        'blank/splash window); optional, may be blank')
  print('  ttfd        reportFullyDrawn: app-declared "fully drawn"; blank when '
        'the app never calls it (most apps don\'t)')
  print('  settled     MEASURED: time until the screen reached its final look - '
        'the first frame the app is really usable at (splash/fade-in aware)')
  print('  Δ%          how different that settled frame is from the first '
        'captured one (0 = identical; low = little loaded, e.g. only a splash)')
  print('  status      ok = settled and held; still-changing = still drawing '
        'when the window closed (settled is a lower bound); live = a region '
        '(video/camera/animation) never stops, settled is the surrounding UI; '
        'no-video')
  print('  settled_ts  absolute trace timestamp (ns) of the settled frame - '
        'paste into the Perfetto UI search box to jump to it')


def print_startup_json(recs):
  import json
  print(json.dumps([{k: v for k, v in r.items() if not k.startswith('_')}
                    for r in recs], indent=2))


def print_startup_sql(recs):
  """A query to paste into the Perfetto UI 'Query (SQL)' page. Run it, then
  'Show debug track' on (ts, dur, name): each slice spans the MEASURED settle
  time and carries every reported and measured number as a column/arg, so you
  can compare real-vs-reported on the timeline."""

  def val(x):
    if x is None:
      return 'NULL'
    if isinstance(x, str):
      return "'" + x.replace("'", "") + "'"
    return repr(x)

  rows = []
  for r in recs:
    # The debug-track slice spans the measured settle time (fall back to the
    # reported dur if there was no video). All durations are ns.
    span = r['_settled_ns'] if r['_settled_ns'] is not None else (r['_dur_ns']
                                                                  or 0)
    cells = [
        r['start_ts'], span, r['process'],
        r['startup_id'], r['upid'], r['startup_type'],
        r['_dur_ns'], r['_ttid_ns'], r['_ttfd_ns'], r['_settled_ns'],
        r['settled_ts'],
        None if r['change'] is None else round(r['change'] * 100), r['status'],
    ]
    rows.append('  (' + ', '.join(val(c) for c in cells) + ')')
  cols = ('ts, dur, name, startup_id, upid, type, dur_ns, ttid_ns, ttfd_ns, '
          'settled_ns, settled_ts, change_pct, status')
  print('-- Paste into the Perfetto UI "Query (SQL)" page and run it. Each row '
        'is one startup with every number.')
  print('-- "Show debug track" on (ts, dur, name) draws a slice spanning the '
        'measured settle time; the rest show as args.')
  print(f'WITH startups({cols}) AS (VALUES')
  print(',\n'.join(rows))
  print(') SELECT * FROM startups ORDER BY ts;')


def report_startup(tp, frames_dir=None, as_json=False, as_sql=False,
                   sheet_path=None):
  want_frames = frames_dir is not None or sheet_path is not None
  fmt, config, frames, recs = measure_startups(tp, want_frames)
  if as_json:
    print_startup_json(recs)
  else:
    render_startup_table(recs)
  if frames_dir is not None:
    targets = {r['_frame_index']: r['frame_png'][:-4]
               for r in recs if r['_frame_index'] is not None}
    saved = save_frames(fmt, config, frames, targets, frames_dir)
    print(f'\nSaved {saved} settled frames to {frames_dir} '
          f'(startup<id>-<proc>-settled-<ms>ms.png)', file=sys.stderr)
  if sheet_path is not None:
    n = contact_sheet(fmt, config, frames, recs, 0, sheet_path)
    print(f'\nWrote {sheet_path}: contact sheet of {n} settled frames',
          file=sys.stderr)
  if as_sql:
    print()
    print_startup_sql(recs)


def parse_args():
  ap = argparse.ArgumentParser(
      description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument('trace', help='input .perfetto-trace')
  ap.add_argument(
      '--metric', choices=('startup',), default='startup',
      help='which frame metric to report (default: startup)')
  ap.add_argument(
      '--frames-dir', metavar='DIR',
      help='also save each measured settled frame as a PNG here, named '
      'startup<id>-<proc>-settled-<ms>ms.png (the high-speed-camera-style '
      '"frame we called it at")')
  ap.add_argument(
      '--contact-sheet', metavar='PNG',
      help='write a contact sheet tiling each startup\'s settled frame (one '
      'content thumbnail per launch, labelled with process + settle time); '
      'needs ffmpeg for the labels')
  ap.add_argument(
      '--json', action='store_true',
      help='emit machine-readable JSON records instead of the table')
  ap.add_argument(
      '--sql', action='store_true',
      help='also print a debug-track SQL query to paste into the Perfetto UI')
  ap.add_argument(
      '--trace-processor', metavar='PATH',
      help='local trace_processor(_shell) build (default: download a prebuilt)')
  return ap.parse_args()


def main():
  args = parse_args()
  if not os.path.exists(args.trace):
    die(f'No such trace: {args.trace}')
  if args.trace_processor and not os.path.exists(args.trace_processor):
    die(f'No such trace_processor: {args.trace_processor}')
  try:
    import av  # noqa: F401
    import numpy  # noqa: F401
  except ImportError:
    die('this needs PyAV and numpy: pip install av numpy')

  config = TraceProcessorConfig(bin_path=args.trace_processor)
  with TraceProcessor(trace=args.trace, config=config) as tp:
    report_startup(tp, args.frames_dir, args.json, args.sql, args.contact_sheet)
  return 0


if __name__ == '__main__':
  sys.exit(main())
