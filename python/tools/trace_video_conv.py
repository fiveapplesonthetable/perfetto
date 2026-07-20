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
"""Extract screen-recording video from a Perfetto trace into an .mp4.

The android.display.video data source stores each captured frame as a coded
access unit in the trace, on screen from its own timestamp until the next frame
(so the capture rate is variable). This reads those frames and remuxes them into
an .mp4 with ffmpeg's libav (PyAV): the coded access units are copied verbatim
(no re-encode) and each is given its real presentation time, so the output
preserves the trace's exact, variable per-frame timing. A clip starts exactly at
the requested timestamp and ends at the requested end. Works for H.264 and HEVC.
With --compare it lays two traces' videos side by side, each captioned; the
side-by-side composite is re-encoded, but each single-clip export is lossless.

Requires the PyAV package (`pip install av`). ffmpeg on the PATH is only needed
for the re-encode paths (--compare, and clips that need a 'No video frames'
card); a plain lossless export uses libav alone. trace_processor is downloaded
automatically unless --trace-processor points at a local build.

Examples:
  # whole video
  trace_video_conv.py trace.perfetto-trace -o out.mp4

  # list the video streams in the trace
  trace_video_conv.py trace.perfetto-trace --list

  # clip to a time range (trace ts, ns), or to whatever a query selects
  trace_video_conv.py trace.perfetto-trace -o clip.mp4 --start 90697190 --end 90697200
  trace_video_conv.py trace.perfetto-trace -o clip.mp4 \
      --query "SELECT ts, dur FROM slice WHERE name = 'my_cuj'"

  # slow motion (0.5x) or 2x faster
  trace_video_conv.py trace.perfetto-trace -o out.mp4 --speed 0.5

  # two traces side by side, each clipped independently, with captions
  trace_video_conv.py before.perfetto-trace --compare after.perfetto-trace \
      -o cmp.mp4 --title Before --title2 After

  # a contact sheet (PNG) of frames tiled together, to skim a whole capture
  trace_video_conv.py trace.perfetto-trace -o sheet.png --contact-sheet
  # one tile per query row, labelled with the row's name (e.g. per startup)
  trace_video_conv.py trace.perfetto-trace -o startups.png --contact-sheet \
      --query "SELECT ts, name FROM slice WHERE name GLOB 'launching: *'"
"""

import argparse
import collections
import os
import shutil
import statistics
import subprocess
import sys
import tempfile

# `python.perfetto.*` needs the repo root on sys.path; that package's own
# absolute `perfetto.*` imports need python/ on it too.
ROOT_DIR = os.path.dirname(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.append(ROOT_DIR)
sys.path.append(os.path.join(ROOT_DIR, 'python'))

from python.perfetto.trace_processor import TraceProcessor
from python.perfetto.trace_processor import TraceProcessorConfig

VIDEO_TABLE = '__intrinsic_video_frames'
AU_FN = '__intrinsic_video_frame_au_data'

Frame = collections.namedtuple('Frame', 'ts is_key is_config pts data')
# A per-trace selection: which display, and how to clip it.
Clip = collections.namedtuple('Clip', 'display_id start end query')
# A loaded clip: config + selected frames, the requested [start, end] window (ns,
# or None), the codec string, the stream's last frame ts, and - when clipped by a
# --query - that query's per-row (ts, name) for one-tile-per-row contact sheets.
Loaded = collections.namedtuple('Loaded',
                                'cfg sel start end codec last_ts rows')

FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
    '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
]


def die(msg):
  print(msg, file=sys.stderr)
  sys.exit(1)


def list_streams(tp):
  rows = list(
      tp.query(f'''
        SELECT display_id,
               COALESCE(MAX(display_name), '') AS name,
               COUNT(*) AS frames,
               (MAX(ts) - MIN(ts)) / 1e9 AS duration_s
        FROM {VIDEO_TABLE}
        WHERE COALESCE(is_config, 0) = 0
        GROUP BY display_id
        ORDER BY display_id'''))
  if not rows:
    die('No android.display.video frames in this trace.')
  print(f"{'display_id':>10}  {'frames':>7}  {'duration_s':>10}  name")
  for r in rows:
    print(f'{r.display_id:>10}  {r.frames:>7}  {r.duration_s:>10.2f}  {r.name}')


def pick_display(tp, want):
  ids = [
      r.display_id for r in tp.query(
          f'SELECT DISTINCT display_id FROM {VIDEO_TABLE} ORDER BY display_id')
  ]
  if not ids:
    die('No android.display.video frames in this trace.')
  if want is None:
    if len(ids) > 1:
      die(f'Trace has multiple video streams {ids}; pick one with --display-id.'
         )
    return ids[0]
  if want not in ids:
    die(f'display_id {want} not found; available: {ids}')
  return want


def query_frames(tp, display_id):
  """The stream's config rows and displayable frames, in playback order."""
  rows = tp.query(f'''
      SELECT ts,
             COALESCE(is_key_frame, 0) AS is_key,
             COALESCE(is_config, 0) AS is_config,
             COALESCE(pts_us, 0) AS pts,
             {AU_FN}(id) AS data
      FROM {VIDEO_TABLE}
      WHERE display_id = {display_id}
      ORDER BY ts, id''')
  frames = [Frame(r.ts, r.is_key, r.is_config, r.pts, r.data) for r in rows]
  config = [f for f in frames if f.is_config]
  return config, [f for f in frames if not f.is_config]


def resolve_region(tp, clip):
  """The (start_ts, end_ts) to clip to, or (None, None) for the whole stream."""
  if not clip.query:
    return clip.start, clip.end
  rows = list(tp.query(clip.query))
  if not rows:
    die('--query returned no rows; nothing to clip to.')
  if not hasattr(rows[0], 'ts'):
    die("--query must return a 'ts' column.")
  starts = [r.ts for r in rows]
  ends = [
      r.ts + (r.dur if getattr(r, 'dur', None) is not None else 0) for r in rows
  ]
  return min(starts), max(ends)


def select_range(frames, start_ts, end_ts):
  """Frames whose on-screen interval intersects [start_ts, end_ts], extended
  back to a seeding key frame."""
  if start_ts is None and end_ts is None:
    return frames
  # A captured frame stays on screen until the next one is captured, so the
  # frame shown at start_ts is the last one that begins at or before it, not
  # the first one after. Snapping forward instead would drop the very frame
  # the user asked for whenever start_ts falls between two frames.
  lo = 0
  if start_ts is not None:
    while lo + 1 < len(frames) and frames[lo + 1].ts <= start_ts:
      lo += 1
  # A clip can only be decoded starting from a key frame, so back up to the
  # last one at or before the chosen start.
  seed = lo
  while seed > 0 and not frames[seed].is_key:
    seed -= 1
  hi = len(frames)
  if end_ts is not None:
    hi = 0
    while hi < len(frames) and frames[hi].ts <= end_ts:
      hi += 1
  return frames[seed:hi]


def build_stream(config, frames):
  # Frames are Annex-B access units (already start-code delimited), so the
  # elementary stream is the config (SPS/PPS) followed by the frames.
  return b''.join(f.data for f in config + frames)


def load_clip(bin_path, trace, clip):
  """Open a trace and return the Loaded clip. sel is the selected frames (by ts,
  seeded from a key frame), each carrying its real ts for exact timing."""
  if not os.path.exists(trace):
    die(f'No such trace: {trace}')
  config = TraceProcessorConfig(bin_path=bin_path)
  with TraceProcessor(trace=trace, config=config) as tp:
    display_id = pick_display(tp, clip.display_id)
    cfg_frames, frames = query_frames(tp, display_id)
    if not frames:
      die(f'No displayable frames for display {display_id} in {trace}.')
    start_ts, end_ts = resolve_region(tp, clip)
    sel = select_range(frames, start_ts, end_ts)
    query_rows = None
    if clip.query:
      # Keep each row (not just the merged span) so a contact sheet can show one
      # tile per row, labelled with the row's `name` column when it has one.
      query_rows = [(r.ts,
                     str(r.name) if getattr(r, 'name', None) is not None
                     else None) for r in tp.query(clip.query)]
    rows = tp.query(f'SELECT codec_string FROM {VIDEO_TABLE} '
                    f'WHERE display_id = {display_id} '
                    'AND codec_string IS NOT NULL LIMIT 1')
    codec_string = next((r.codec_string for r in rows), None)
  if not sel:
    die(f'No frames in the requested range for {trace}.')
  if sum(len(f.data) for f in sel) == 0:
    die(f'Frames in {trace} carry no encoded data: the trace has frame rows '
        'but not the encoded payload, so there is nothing to mux. It was '
        'likely recorded without the video bytes.')
  # last_ts is the stream's final frame; an --end past it is a real gap (capture
  # stopped), not the last frame simply staying on screen.
  return Loaded(cfg_frames, sel, start_ts, end_ts, codec_string, frames[-1].ts,
                query_rows)


def find_font():
  return next((p for p in FONT_CANDIDATES if os.path.exists(p)), None)


def probe_dims(path):
  """(width, height) of the video in a file, via libav."""
  import av
  with av.open(path) as c:
    s = c.streams.video[0]
    return s.width, s.height


def write_temp(data, suffix):
  mode = 'wb' if isinstance(data, bytes) else 'w'
  with tempfile.NamedTemporaryFile(mode, suffix=suffix, delete=False) as f:
    f.write(data)
    return f.name


def run_ffmpeg(in_out_args):
  # Only the re-encode paths (cards, --compare) need the ffmpeg binary; a
  # lossless single-clip export goes through libav alone.
  if not shutil.which('ffmpeg'):
    die('this needs ffmpeg on PATH (apt install ffmpeg / brew install ffmpeg).')
  cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error'] + in_out_args
  proc = subprocess.run(cmd, capture_output=True, text=True)
  if proc.returncode != 0:
    die(f'ffmpeg failed:\n{proc.stderr.strip()}')


def probe_duration(path):
  """The video's duration in seconds, via libav (0.0 if unknown)."""
  import av
  with av.open(path) as c:
    return c.duration / 1_000_000 if c.duration else 0.0  # duration is in us


def codec_format(codec_string):
  """The libav demuxer name for the trace's codec ('hevc' or 'h264')."""
  cs = (codec_string or '').lower()
  return 'hevc' if cs.startswith(('hvc', 'hev')) else 'h264'


def mux(cfg_frames, sel, start_ts, end_ts, codec_string, speed, out_path):
  """Wrap the coded frames in an .mp4 with their exact per-frame timing and no
  re-encode, via ffmpeg's libav (PyAV): copy the coded access units and give each
  its real presentation time. Pre-roll before start_ts is trimmed with an edit
  list so playback begins exactly at start_ts, and the last frame is held to
  end_ts. Works for any codec libav parses (H.264, HEVC)."""
  import av
  from fractions import Fraction

  raw = write_temp(build_stream(cfg_frames, sel), '.bin')
  rebase = start_ts if start_ts is not None else sel[0].ts
  n = len(sel)
  gaps = [
      sel[i + 1].ts - sel[i].ts
      for i in range(n - 1)
      if sel[i + 1].ts > sel[i].ts
  ]
  # The last frame has no successor to bound it; hold it for the median gap.
  nominal = int(statistics.median(gaps)) if gaps else 33_000_000
  hi = end_ts if end_ts is not None else sel[-1].ts + nominal
  # Microsecond timebase: matches pts_us exactly (ts are whole microseconds) and
  # keeps values small enough for a multi-second held frame to fit the container.
  tb = Fraction(1, 1_000_000)

  def us(ns):
    return round(ns / 1000 / speed)

  try:
    inp = av.open(raw, format=codec_format(codec_string))
    src = inp.streams.video[0]
    out = av.open(out_path, 'w')
    dst = out.add_stream_from_template(src)  # copies codec params (avcC/hvcC)
    dst.time_base = tb
    packets = [p for p in inp.demux(src) if p.size > 0]
    if len(packets) != n:
      die(f'expected {n} frames but the stream demuxed {len(packets)}.')
    for i, (f, p) in enumerate(zip(sel, packets)):
      nxt = sel[i + 1].ts if i + 1 < n else hi
      p.pts = p.dts = us(f.ts - rebase)
      p.duration = max(1, us(min(nxt, hi) - f.ts))
      p.time_base = tb
      p.stream = dst
      out.mux(p)
    out.close()
    inp.close()
  finally:
    os.unlink(raw)
  return n


# A thin dark header bar (Perfetto's chrome colour) with left-aligned text.
HEADER_COLOR = '0x1A2633'

# Shared grid the two sides are resampled onto for the (re-encoded) side-by-side.
COMPARE_FPS = 60


def caption(title_file, font, fontsize, band):
  """A drawtext filter that left-aligns the caption in the top band."""
  font_opt = f"fontfile='{font}':" if font else ''
  return (f'drawtext={font_opt}textfile={title_file}:fontcolor=white:'
          f'fontsize={fontsize}:x=16:y=({band}-th)/2')


def blank_card(font, fontsize, enable):
  """A drawtext filter that centres 'No video frames' while `enable` holds. Drawn
  in a translucent box so it reads over a frozen last frame as well as black."""
  font_opt = f"fontfile='{font}':" if font else ''
  return (f"drawtext={font_opt}text='No video frames':fontcolor=white:"
          f"fontsize={fontsize}:x=(w-tw)/2:y=(h-th)/2:box=1:boxcolor=black@0.6:"
          f"boxborderw={max(fontsize // 3, 8)}:enable='{enable}'")


def fill_filters(font, height, lead, content_end, total):
  """The ffmpeg filters that pad a clip's frameless window parts with a card: a
  black lead-in before the first frame, the frozen last frame after the last.
  Both pads go in one tpad (chaining two tpads drops part of the second)."""
  cardsize = max(round(height * 0.05), 20)
  tpad, cards = [], []
  if lead > 1e-3:
    tpad.append(f'start_mode=add:start_duration={lead:.3f}:color=black')
    cards.append(blank_card(font, cardsize, f'lt(t,{lead:.3f})'))
  if total - content_end > 1e-3:
    tpad.append(f'stop_mode=clone:stop_duration={total - content_end:.3f}')
    cards.append(blank_card(font, cardsize, f'gte(t,{content_end:.3f})'))
  return [f'tpad={":".join(tpad)}'] + cards if tpad else []


def fill_card(video, lead, content_end, total, out_path):
  """Re-encode `video` with lead-in/tail cards filling its frameless window
  parts. Runs only when the window reaches past the frames."""
  dims = probe_dims(video)
  filters = fill_filters(find_font(), dims[1] if dims else 720, lead,
                         content_end, total)
  run_ffmpeg([
      '-i', video, '-vf', ','.join(filters), '-c:v', 'libx264', '-pix_fmt',
      'yuv420p', '-movflags', '+faststart', out_path
  ])


def clip_span(clip, mp4, speed):
  """Mux one clip's frames and describe how its requested window maps to output
  seconds: (lead, content_end, window). `lead` is blank time before the first
  frame; frames run [lead, content_end]; `window` is the full span to show, so
  [content_end, window] is a frameless tail. When --end lands within the frames
  the last frame is held to it (lossless); only an --end past the stream's last
  frame leaves a real tail gap to card."""
  cfg, sel, start, end, codec, last_ts, _ = clip
  lead = (sel[0].ts - start) / 1e9 / speed \
      if start is not None and start < sel[0].ts else 0.0
  tail_gap = end is not None and end > last_ts
  mux(cfg, sel, None if lead else start, None if tail_gap else end, codec,
      speed, mp4)
  content_end = lead + probe_duration(mp4)
  window = (end - start) / 1e9 / speed if start is not None and end is not None \
      else content_end
  return lead, content_end, max(window, content_end)


def mux_compare(left, right, titles, speed, out_path):
  """Stack two clips side by side, each captioned, over each side's requested
  [start, end] window. Real frames play at their real times; any frameless part
  of the window - before the first frame, or after the last - shows a 'No video
  frames' card, so both sides fill the same span (e.g. two 5 s ranges both run
  5 s even if one starts late and ends early)."""
  font = find_font()
  tmp = tempfile.mkdtemp()
  titlefiles = []
  try:
    l_mp4 = os.path.join(tmp, 'l.mp4')
    r_mp4 = os.path.join(tmp, 'r.mp4')
    l_lead, l_end, l_win = clip_span(left, l_mp4, speed)
    r_lead, r_end, r_win = clip_span(right, r_mp4, speed)
    total = max(l_win, r_win)
    # textfile= avoids escaping title text (paths, colons, quotes) in the graph.
    title_l = write_temp(titles[0], '.txt')
    title_r = write_temp(titles[1], '.txt')
    titlefiles = [title_l, title_r]
    dims = probe_dims(l_mp4)
    height = dims[1] if dims else 720
    band = max(round(height * 0.045), 22)  # thin caption bar, in pixels
    fontsize = max(round(band * 0.55), 12)

    def side(idx, title_file, lead, content_end):
      chain = [
          f'[{idx}:v]fps={COMPARE_FPS}', f'scale=-2:{height}',
          f'pad=iw:ih+{band}:0:{band}:{HEADER_COLOR}',
          caption(title_file, font, fontsize, band)
      ]
      chain += fill_filters(font, height, lead, content_end, total)
      return ','.join(chain)

    graph = (f'{side(0, title_l, l_lead, l_end)}[l];'
             f'{side(1, title_r, r_lead, r_end)}[r];'
             f'[l][r]hstack=inputs=2[v]')
    run_ffmpeg([
        '-i', l_mp4, '-i', r_mp4, '-filter_complex', graph, '-map', '[v]',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        out_path
    ])
  finally:
    for f in titlefiles:
      os.unlink(f)
    shutil.rmtree(tmp, ignore_errors=True)


# Contact sheet: each decoded frame is scaled to this height (px); width follows
# the aspect ratio. Labels are burned on with ffmpeg's drawtext.
SHEET_TILE_H = 300
SHEET_PAD = 4
SHEET_BG = 24


def _write_png(path, rgb):
  """Write an HxWx3 uint8 RGB array as a PNG (no Pillow dependency)."""
  import struct
  import zlib
  h, w = rgb.shape[0], rgb.shape[1]
  data = rgb.astype('uint8').tobytes()
  stride = w * 3
  raw = bytearray()
  for y in range(h):
    raw.append(0)  # filter type 0 (none)
    raw += data[y * stride:(y + 1) * stride]

  def chunk(typ, payload):
    return (struct.pack('>I', len(payload)) + typ + payload +
            struct.pack('>I', zlib.crc32(typ + payload) & 0xffffffff))

  with open(path, 'wb') as f:
    f.write(b'\x89PNG\r\n\x1a\n')
    f.write(chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)))
    f.write(chunk(b'IDAT', zlib.compress(bytes(raw), 6)))
    f.write(chunk(b'IEND', b''))


def sheet_picks(loaded, tiles):
  """(frame indices into loaded.sel, per-tile label) for the contact sheet. With
  a --query, one tile per row (the frame on screen at the row's ts, labelled with
  the row's name or its time); otherwise `tiles` frames spread across the clip."""
  sel = loaded.sel
  base = loaded.start if loaded.start is not None else sel[0].ts

  def at(ts):  # index of the frame on screen at ts (last one starting at/before)
    k = 0
    while k + 1 < len(sel) and sel[k + 1].ts <= ts:
      k += 1
    return k

  if loaded.rows:
    picks = [at(ts) for ts, _ in loaded.rows]
    labels = [name or f'{(sel[k].ts - base) / 1e6:.0f}ms'
              for k, (_, name) in zip(picks, loaded.rows)]
  else:
    n = max(1, min(tiles, len(sel)))
    step = (len(sel) - 1) / (n - 1) if n > 1 else 0
    picks = sorted({round(i * step) for i in range(n)})
    labels = [f'{(sel[k].ts - base) / 1e6:.0f}ms' for k in picks]
  return picks, labels


def contact_sheet(loaded, tiles, cols, out_path):
  """Decode the sampled frames, tile them into one labelled PNG, and write it - a
  contact sheet to skim a whole capture at a glance, or one tile per --query row.
  Returns the number of tiles written."""
  import av
  import numpy as np

  picks, labels = sheet_picks(loaded, tiles)
  want = set(picks)
  raw = write_temp(build_stream(loaded.cfg, loaded.sel), '.bin')
  decoded = {}
  try:
    with av.open(raw, format=codec_format(loaded.codec)) as c:
      last = max(want)
      for i, pic in enumerate(c.decode(video=0)):
        if i in want:
          tw = max(1, round(SHEET_TILE_H * pic.width / pic.height))
          decoded[i] = pic.reformat(
              width=tw, height=SHEET_TILE_H, format='rgb24').to_ndarray()
        if i >= last:
          break
  finally:
    os.unlink(raw)
  order = [(decoded[p], lbl) for p, lbl in zip(picks, labels) if p in decoded]
  if not order:
    die('could not decode any frame for the contact sheet.')

  th, tw = order[0][0].shape[:2]
  n = len(order)
  cols = cols or min(n, 6)
  rows = (n + cols - 1) // cols
  p = SHEET_PAD
  canvas = np.full((rows * (th + p) + p, cols * (tw + p) + p, 3), SHEET_BG,
                   np.uint8)
  placed = []  # (x, y, label) for the label pass
  for j, (img, label) in enumerate(order):
    r, c = divmod(j, cols)
    y, x = p + r * (th + p), p + c * (tw + p)
    canvas[y:y + th, x:x + tw] = img
    placed.append((x + 4, y + 4, label))
  _write_png(out_path, canvas)
  label_sheet(out_path, placed, max(round(th * 0.05), 12))
  return n


def label_sheet(png_path, placed, fontsize):
  """Burn each tile's label onto the sheet with ffmpeg drawtext (handles any text
  and reuses the TTF font). Skipped with a warning if ffmpeg isn't on PATH."""
  if not placed or not shutil.which('ffmpeg'):
    if placed:
      print('note: ffmpeg not found; contact sheet written without labels.',
            file=sys.stderr)
    return
  font = find_font()
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
    labelled = os.path.join(tmp, 'out.png')
    run_ffmpeg(['-i', png_path, '-vf', ','.join(filters), labelled])
    shutil.move(labelled, png_path)
  finally:
    shutil.rmtree(tmp, ignore_errors=True)


def parse_args():
  ap = argparse.ArgumentParser(
      description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument('trace', help='input .perfetto-trace')
  ap.add_argument('-o', '--output', help='output .mp4')
  ap.add_argument(
      '--list',
      action='store_true',
      help='list the video streams in the trace and exit')
  ap.add_argument(
      '--trace-processor',
      metavar='PATH',
      help='local trace_processor(_shell) build '
      '(default: download a prebuilt)')
  ap.add_argument(
      '--speed',
      type=float,
      default=1.0,
      help='playback speed: 2 = twice as fast, 0.5 = slow motion '
      '(applies to both sides)')

  s = ap.add_argument_group('contact sheet (still image of tiled frames)')
  s.add_argument(
      '--contact-sheet',
      action='store_true',
      help='write a PNG contact sheet of tiled frames to -o instead of an .mp4; '
      'with --query, one tile per row (labelled with its `name` column)')
  s.add_argument(
      '--tiles',
      type=int,
      default=24,
      help='frames to sample across the clip for the contact sheet '
      '(ignored when --query gives one tile per row; default: 24)')
  s.add_argument(
      '--cols',
      type=int,
      default=0,
      help='columns in the contact sheet (default: auto)')

  g = ap.add_argument_group('clip (first trace)')
  g.add_argument(
      '--display-id', type=int, help='which video stream (see --list)')
  g.add_argument('--start', type=int, help='clip start (trace ts, ns)')
  g.add_argument('--end', type=int, help='clip end (trace ts, ns)')
  g.add_argument(
      '--query',
      help='clip to the region a SQL query selects '
      '(must return ts, optionally dur)')
  g.add_argument('--title', help='caption for the first video (compare mode)')

  g2 = ap.add_argument_group('compare (two traces side by side)')
  g2.add_argument(
      '--compare',
      metavar='TRACE',
      help='second trace; its video is placed to the right')
  g2.add_argument(
      '--display-id2', type=int, help='stream to use from --compare')
  g2.add_argument(
      '--start2', type=int, help='clip start for --compare (ts, ns)')
  g2.add_argument('--end2', type=int, help='clip end for --compare (ts, ns)')
  g2.add_argument('--query2', help='clip query for --compare')
  g2.add_argument('--title2', help='caption for the second video')
  return ap.parse_args()


def main():
  args = parse_args()
  if args.trace_processor and not os.path.exists(args.trace_processor):
    die(f'No such trace_processor: {args.trace_processor}')
  if not os.path.exists(args.trace):
    die(f'No such trace: {args.trace}')
  if args.speed <= 0:
    die('--speed must be > 0')

  if args.list:
    config = TraceProcessorConfig(bin_path=args.trace_processor)
    with TraceProcessor(trace=args.trace, config=config) as tp:
      list_streams(tp)
    return 0

  if not args.output:
    die('-o/--output is required (or use --list).')

  # PyAV is needed only to write the output (not for --list), so it is imported
  # lazily and is not a dependency of the perfetto package.
  try:
    import av  # noqa: F401
  except ImportError:
    die('writing the output needs PyAV (ffmpeg bindings): pip install av')
  if args.contact_sheet:
    try:
      import numpy  # noqa: F401
    except ImportError:
      die('the contact sheet needs numpy: pip install numpy')

  clip = Clip(args.display_id, args.start, args.end, args.query)
  left = load_clip(args.trace_processor, args.trace, clip)

  if args.contact_sheet:
    n = contact_sheet(left, args.tiles, args.cols, args.output)
    print(f'Wrote {args.output}: contact sheet of {n} frames')
    return 0

  if args.compare:
    clip2 = Clip(args.display_id2, args.start2, args.end2, args.query2)
    right = load_clip(args.trace_processor, args.compare, clip2)
    titles = (args.title or os.path.basename(args.trace), args.title2 or
              os.path.basename(args.compare))
    mux_compare(left, right, titles, args.speed, args.output)
    print(
        f'Wrote {args.output}: {len(left.sel)} + {len(right.sel)} frames side '
        f'by side ({titles[0]} | {titles[1]})')
  else:
    work = tempfile.mkdtemp()
    try:
      clip_mp4 = os.path.join(work, 'clip.mp4')
      lead, content_end, total = clip_span(left, clip_mp4, args.speed)
      if lead > 1e-3 or total - content_end > 1e-3:
        fill_card(clip_mp4, lead, content_end, total, args.output)
      else:
        shutil.move(clip_mp4, args.output)  # no gaps: keep the lossless remux
    finally:
      shutil.rmtree(work, ignore_errors=True)
    print(f'Wrote {args.output}: {len(left.sel)} frames')
  return 0


if __name__ == '__main__':
  sys.exit(main())
