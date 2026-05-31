# Investigation: serialize the TrackEvent in Java straight into the SMB

Branch: `dev/zezeozue/java-smb-direct` (off the `java-protowriter-opt` opt stack).
Goal: close the last gap (LL trailing HL on tiny events) by **serializing the
protobuf in Java directly into the shared-memory-buffer (SMB) chunk the tracing
service owns — no off-heap staging copy, no native re-parse of a frame, and
ideally no per-event memcpy of the body.**

This is the endgame the empty-event floor pointed to: today even the LL path
encodes into a Java buffer, copies it off-heap, and has native re-parse a frame
and append the body into the SMB. If Java writes the final bytes *into the SMB
chunk itself*, all of that disappears.

## What the SMB exposes (public ABI — already there)

`PerfettoDsTracerImplPacketBegin(tracer)` returns a `PerfettoStreamWriter` whose
fields point straight at the current SMB chunk
(`include/perfetto/public/abi/stream_writer_abi.h`):

```c
struct PerfettoStreamWriter {
  struct PerfettoStreamWriterImpl* impl;
  uint8_t* begin;       // first byte of the current chunk
  uint8_t* end;         // one past the last writable byte of the chunk
  uint8_t* write_ptr;   // next byte to write
};
```

So once a packet is begun, `[write_ptr, end)` is a **raw writable window into
the SMB**. Java writing protobuf there *is* writing into the trace buffer.
`PerfettoStreamWriterNewChunk()` rotates to a fresh chunk when full;
`PERFETTO_STREAM_WRITER_PATCH_SIZE == 4` is the redundant length-prefix size —
and `ProtoWriter` already emits exactly that 4-byte redundant varint for nested
lengths, so intra-chunk length patching is already Java-compatible.

## Proposed shape

Two JNI calls per event, with the body serialized by Java in between, straight
into the SMB:

1. `smb_begin(catPtr, type, name, trackUuid, …) -> { long ctx, long writeAddr, int cap }`
   - `PerfettoTeLlBegin` (iterate active instances — see "Hard parts"),
     `PerfettoTeLlPacketBegin` (writer over the SMB chunk).
   - Native writes the parts that need per-sequence state: timestamp, sequence
     flags, category + event-name **interning**, `begin track_event`, type,
     interned category/name refs, `track_uuid`.
   - Returns the SMB `write_ptr` (where the body goes) + remaining capacity, and
     stashes `{iterator, writer, te_msg, intern_ctx}` in a per-thread native ctx.
2. **Java serializes the body** (debug args / proto fields) directly at
   `writeAddr` — the bulk of any non-empty event — advancing a Java position.
3. `smb_commit(ctx, bodyLen, internedRefs…)`
   - Advance `write_ptr += bodyLen`, write any interned-field refs, end the
     `track_event` (patch its length), end the packet, commit the chunk.

Result: no off-heap buffer, no frame, no native re-parse, and the body bytes are
written once — by Java, into the SMB.

## The fast-write problem (the crux to settle first)

Java must write bytes to the raw SMB address quickly. Options, with what we
already measured on the Pixel 4 XL / ART:

- **`Unsafe.putByte(long,byte)`** — NOT intrinsified on this ART; it's a real
  call per byte. **Dead end** (measured: a frame of ~20 putByte calls was far
  slower than a byte[] encode + one bulk copy).
- **`Unsafe.putLong/putInt(long,…)`** — UNTESTED; may be intrinsified even where
  putByte is not. Worth a microbenchmark — writing 8/4 bytes at a time could be
  viable.
- **A `DirectByteBuffer` over the SMB window** (native `NewDirectByteBuffer(
  write_ptr, cap)`) — per-field puts are OK when AOT-compiled (~1.3% each in
  profiles), but `NewDirectByteBuffer` **allocates a ByteBuffer object per
  packet** → GC pressure, breaks the zero-alloc hot path. Mitigation: hand Java
  a DirectByteBuffer over the **whole chunk once per chunk** (not per packet)
  and have Java write successive packets at offsets, only re-acquiring on chunk
  rotation. This is the most promising route and mirrors how perfetto's own
  `TraceWriter` amortizes chunk acquisition.

Recommended first experiment: microbench `Unsafe.putLong`-to-native vs a
chunk-level reused `DirectByteBuffer`, decide the writer substrate, then build
`ProtoWriter`-into-SMB on the winner.

## Hard parts (why this is a real project, not a tweak)

1. **Per-sequence interning / incremental state.** Category and event-name iids
   live in native per-sequence state. Either keep interning native (as above —
   begin/commit straddle it), or port the intern tables to Java (large). Keep it
   native for v1.
2. **Multi-instance fan-out.** `emit_track_event` loops over every active data
   source instance and writes the packet to each. A begin/commit pair models
   one writer; v1 should handle the common single-instance case and fall back to
   the existing LL `native_emit` when `>1` instance is active.
3. **Chunk rotation mid-packet + cross-chunk patching.** If the body doesn't fit
   in `[write_ptr, end)`, native must `NewChunk` and the `track_event` length
   field (now in a committed chunk) goes on the **patch list** the service
   applies. v1: detect overflow in `smb_begin`/before the Java write and fall
   back to the copy path; only the common (fits-in-chunk) case goes direct.
4. **Lifetime/safety.** The Java write must happen entirely between begin and
   commit with no other emit on the thread in between; the SMB pointer is only
   valid for that window. A misbehaving write corrupts the trace or crashes the
   producer — so this needs trace-output verification (capture the session bytes,
   run `trace_processor` over them) on every change, not just a microbenchmark.

## Phased plan

- **P0 (substrate):** microbench `Unsafe.putLong` vs reused chunk
  `DirectByteBuffer`; pick the Java→native writer.
- **P1 (mechanism):** `smb_begin`/`smb_commit` JNI for the single-instance,
  fits-in-chunk case; Java writes the body direct; fall back to `native_emit`
  otherwise. Verify trace validity with `trace_processor`.
- **P2 (measure):** A/B vs HL and current LL across the scenario set; confirm the
  copy + reparse are gone and check the empty-event case.
- **P3 (generalize):** multi-instance loop, chunk-rotation/patch-list, and decide
  whether name interning moves to Java.

## P0 RESULT — and why this investigation stops here

The gating substrate microbench was run on the Pixel 4 XL (arm64, AOT speed),
writing a ~40-byte packet (5 longs) per op:

| substrate | ns/op | vs byte[] |
|---|---|---|
| `byte[]` (today's ProtoWriter) | **31.6** | 1.00× |
| `DirectByteBuffer.putLong` (into native) | 46.5 | 1.47× slower |
| `Unsafe.putLong` (into native addr) | 55.3 | 1.75× slower |

(Harness: `BenchInstrumentation.runWriteBench`, `-e writebench 1`.)

**This inverts the premise.** Writing *into native memory* (the SMB) from Java
is ~1.5–1.75× slower than writing into a Java `byte[]`, because ART intrinsifies
managed-array stores but not native-memory writes — and crucially this is true
even for `putLong`, not just the already-known-bad `putByte`. So serializing the
TrackEvent straight into the SMB would make **serialization itself ~1.5× slower**
to avoid a copy that, for a small packet, is a **nearly-free `memcpy`** (~40
bytes). The extra ~15 ns/packet of native-write cost dwarfs the few ns of memcpy
it saves.

Net: SMB-direct is **negative for small events** (the exact case we wanted to
fix) and only the cost it removes — the per-byte copy — matters for *large*
packets, which is where LL already wins decisively. So it would help where we
don't need it and hurt where we do.

**Conclusion:** the current design — serialize into a Java `byte[]` (fast,
intrinsified) then hand it to native with a single bulk copy — is already
near-optimal on ART. The empty-event gap vs HL is genuinely the floor for a
"serialize-in-Java" architecture; closing it would require either a faster
Java→native-memory primitive than ART currently provides, or moving the whole
chunk-ownership/commit protocol into Java (porting `TraceWriter`), whose fixed
overhead would almost certainly exceed what's left to gain. Not worth it.

This branch stands as the measured record of why. The two landed Java-side CLs
(single-copy frame encode, track-uuid caching) on `java-protowriter-opt` remain
the right, shippable outcome.
