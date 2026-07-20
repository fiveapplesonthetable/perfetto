# Seeing the screen in a trace (android.display.video)

The `android.display.video` data source records each display's framebuffer as an
encoded video (H.264 or HEVC) inside the trace, emitting a frame whenever the
screen changes. Every frame is a trace packet, so **every frame carries a trace
timestamp** — the recording and the rest of the trace share one clock. That is
what this workflow is for: moving both ways between what was on screen and
everything else the trace recorded, so the screen becomes a queryable dimension of
the trace rather than an opaque video.

This workflow drives `$SKILL_ROOT/bin/trace_video_conv.py`, which reads the frames
out of the trace and writes PNGs (one frame, or a grid of frames) and MP4s. It
does not re-record or modify the trace.

If a trace has not been loaded into `trace_processor` yet, read
`$SKILL_ROOT/infra-references/querying.md` first — this workflow uses queries to
choose timestamps.

## Mental model

The video is a two-way bridge between pixels and the trace timeline:

- **Time → screen.** Given a timestamp — a literal ts, or one a query returns (a
  janky frame, a CUJ boundary, an app launch, an ANR) — decode the frame that was
  on screen then and look at it.
- **Screen → time.** Given a visual state — an app, a page, a dialog, a line of
  on-screen text — find the timestamp(s) it was on screen, then use that
  timestamp anywhere a timestamp is used.

Two facts shape how you use it:

1.  **You are the recognizer.** `trace_processor` cannot tell a Gmail inbox from a
    drafts page, and cannot read the text on screen — you do, by looking at
    decoded frames. So *screen → time* questions are answered by producing images
    and reading them, never by SQL. This is a real strength: anything you can
    recognize by eye (an app, a layout, a toast, a specific string) becomes a
    time you can query on.
2.  **The screen at time T is the last frame at or before T** — a frame stays up
    until the next one is emitted (capture is variable-rate: a static screen emits
    nothing). The tool applies this. The raw frame timestamps are in the
    `__intrinsic_video_frames` table if you need them directly.

Every task below is one of three things: time → screen, screen → time, or joining
a screen state's time range with an ordinary query.

## Setup

Read `$SKILL_ROOT/environment-references/setup.md` for `$SKILL_ROOT` and the
bundled `trace_processor`. The tool needs the `perfetto`, `av` and `numpy` Python
packages (`av`/`numpy` only for the `--screenshot` PNG); `ffmpeg` on the PATH is
needed only for `--timestamps` and `--compare`. Install them — on an
externally-managed Python (PEP 668), into a venv:

```bash
python3 -m venv /tmp/venv && . /tmp/venv/bin/activate   # if pip is managed
pip install perfetto av numpy
VC="$SKILL_ROOT/bin/trace_video_conv.py --trace-processor $SKILL_ROOT/bin/trace_processor"
```

Confirm the trace has a recording, and note the `display_id` if there is more than
one display:

```bash
python3 $VC TRACE.perfetto-trace --list
```

One row per display: `display_id`, `frames`, `duration_s`, `name` (e.g. "Built-in
Screen"). No rows means the trace has no `android.display.video` capture. Pass
`--display-id N` to any command below when there is more than one.

## Time → screen: what was on screen at a moment or event

`--screenshot` decodes the single frame on screen at a point and writes it as a
PNG. The point is a literal `--start` ts (ns), or the earliest ts a `--query`
returns.

```bash
# at a literal timestamp
python3 $VC TRACE.perfetto-trace --screenshot at_ts.png --start 90697190000

# at the moment of an event a query selects (the ts comes from the trace)
python3 $VC TRACE.perfetto-trace --screenshot janky.png \
    --query "SELECT ts FROM slice WHERE name = 'Choreographer#doFrame'
             ORDER BY dur DESC LIMIT 1"
```

Open the PNG and read it to answer the question: had the app drawn or was it still
a splash, was a dialog up, what did the UI show at the janky frame. Any query that
yields a `ts` works — the frame timeline (jank), a slice boundary, an input event,
a log message, an `android_startups` row.

## Screen → time: when a state (or some text) was on screen

`trace_processor` has no concept of "the drafts page"; find it by eye, then pin
the timestamp. Which method depends on what your agent can view:

- **Video-capable agent:** extract the range (or the whole trace) as an `.mp4`
  with `--timestamps` (see "Read content that spans several screens" below), watch
  it, and read the ts off the frame where the state first appears.
- **Stills-only agent:** `--screenshot` the frames and narrow down. There is one
  row per on-screen change in `__intrinsic_video_frames`, so a state that appeared
  at all has a frame — screenshot those exact timestamps, never a fixed time
  interval, or a short-lived screen (a quick app launch, a dialog that flashed up)
  lands in the gap and is missed:

  ```sql
  SELECT ts FROM __intrinsic_video_frames
  WHERE display_id = 0 AND ts BETWEEN <lo> AND <hi> ORDER BY ts
  ```

  `--screenshot` those timestamps, find the one showing the state, then bisect —
  screenshot between the last frame without it and the first with it — to pin the
  exact ts. When a window holds too many frames to shoot one by one, extract it as
  an `.mp4` with `--timestamps` (see below) and scan that instead.

- A state can appear more than once (an app opened twice); scan the whole range.
- A **time range** for a state is `[first frame showing it, first frame that no
  longer shows it]`: find both edges the same way.

## Join a screen state's time with any query

A ts or range from the previous step is ordinary data; join it with the rest of
the trace. The loop is: bracket a screen state's range (screen → time) → run a
query over that range → `--screenshot` a result to see it (time → screen).

- **Per-screen resource use.** "Memory on the conversation list vs the drafts
  page": bracket each page's range (screen → time), then query the process's
  memory counters over each range and compare.
- **Jank per screen.** "Which screen dropped the most frames": bracket each
  screen's range, query janky frames for the process within each (the
  `android.frames` stdlib over `actual_frame_timeline_slice`), aggregate per
  screen, report the worst — then `--screenshot` a janky frame's ts to see what
  was up when it dropped.

The video is the ground truth of which screen was up when; the query supplies the
numbers; the screenshot shows the frame. See
`$SKILL_ROOT/infra-references/querying.md` for the queries.

## Read content that spans several screens (extract a clip)

To answer a question about content that runs across several frames — reading a
scrolling list, following a flow — a single screenshot is not enough. Extract the
region to an `.mp4`; the coded frames are copied verbatim (no re-encode) with
their real per-frame timing:

```bash
python3 $VC TRACE.perfetto-trace -o clip.mp4 --start 90697190000 --end 90699200000
python3 $VC TRACE.perfetto-trace -o cuj.mp4 \
    --query "SELECT ts, dur FROM slice WHERE name = 'my_cuj'"   # a section
python3 $VC TRACE.perfetto-trace -o out.mp4                     # the whole video
```

**If your agent can watch video (e.g. Gemini), feed it the clip and ask** —
"list the friends shown", "what error appeared". If it can only read images,
`--screenshot` points across the range instead and read them.

An `.mp4` on its own carries only *relative* playback time, not the trace ts. Add
**`--timestamps`** to burn each frame's trace ts (ns) in a row under the video, so
a video-capable agent reads both the content and the exact ts — bridging back to
the trace from a clip:

```bash
python3 $VC TRACE.perfetto-trace -o clip.mp4 --start <ts> --end <ts> --timestamps
```

## Compare two traces (for a human to watch)

`--compare` puts a second trace's clip beside the first, each captioned and
clipped independently — the before/after view:

```bash
python3 $VC before.perfetto-trace --compare after.perfetto-trace \
    -o cmp.mp4 --title Before --title2 After
```

## Capturing a trace with screen video

On `userdebug` builds the data source works out of the box; on `user` builds
unlock it once per boot:

```bash
adb shell setprop debug.tracing_video_allowed true   # user builds only
```

Add the data source to the trace config; `display_video_config` is optional (each
field defaults to the producer's setting):

```
data_sources {
  config {
    name: "android.display.video"
    display_video_config {
      scale: 0.5                       # 0.5 = half resolution (less overhead/size)
      format: FORMAT_H264              # or FORMAT_HEVC (smaller; needs HEVC support)
      key_frame_interval_secs: 2       # smaller = snappier seeking, larger trace
      max_stream_size_bytes: 67108864  # 64 MiB per display (default cap 256 MiB)
    }
  }
}
```

Record with the Perfetto helper scripts (see
`$SKILL_ROOT/infra-references/recording_android_traces.md`, General Tracing /
`record_android_trace` with this config). Capturing uses the device's video
encoder while the trace runs, which can perturb the timing you are measuring, and
grows the trace with screen activity; it costs nothing when off. There is a
256 MiB-per-display cap (on device and again at load), so a long or
high-resolution capture can stop before the trace ends.

## Reference

- Data source: `android.display.video` (see <https://perfetto.dev/docs> and
  `record_android_trace`).
- `__intrinsic_video_frames` — one row per frame: `display_id`, `ts`,
  `is_key_frame`, `is_config`, `codec_string`, `pts_us`; the encoded bytes for a
  row are `__intrinsic_video_frame_au_data(id)`.
