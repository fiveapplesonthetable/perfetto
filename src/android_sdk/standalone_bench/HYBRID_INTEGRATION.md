# Hybrid emit — clean production integration (HL framing + batched body)

Branch `dev/zezeozue/java-hl-hybrid`. The prototype (`native_emit_hybrid` +
`PERFETTO_TE_HL_PROTO_TYPE_RAW`) proved the win on a Pixel 4 XL: parity with HL
on empty events (the LL regression is gone) and faster than BOTH HL and LL on
anything with a payload (args/16 0.11x vs HL, 0.81x vs LL). This doc is the
clean way to land it so the LL stack can be deleted — and specifically how it
stays minimal-on-HL, faithful to the HL model, and free of leaks / perf
footguns.

## Change to HL / core perfetto: ~5 lines, additive only
Already done in this branch:
- `track_event_hl_abi.h`: `PERFETTO_TE_HL_PROTO_TYPE_RAW = 9` + a `…FieldRaw`
  struct (`{header; const void* buf; size_t len;}`).
- `hl.cc`: one `case` → `msg->AppendRawProtoBytes(field->buf, field->len)`.

HL's emit loop, interning, SMB framing, packet handling: untouched. It's a new
*field variant* inside the existing `PROTO_FIELDS` extra — used exactly as HL
extras are designed. No new emit path, no fork.

## DO NOT ship the monolithic JNI version
The throwaway `native_emit_hybrid(type, cat, name, body[], len, …)` that
marshals track-name `String[]`, `long[]` ids, per-call `GetStringUTFChars` +
matching releases, and a `std::vector` of extras is a **microbench shortcut**.
It duplicates HL logic and every `GetStringUTFChars` needs a paired release —
the exact leak/footgun surface to avoid. It exists only to measure; delete it.

## The clean integration (reuse everything that exists)
Tracks (named + nested), counters, flows: **unchanged** — they keep riding the
existing `NamedTrack` / `CounterTrack` / `Flow` / nested-track extras, which are
reusable native-backed `PerfettoPointer` objects already registered with a
`PerfettoNativeMemoryCleaner` (leak-safe, pooled, zero per-emit alloc).

The ONLY change is how debug args / proto fields are carried:

1. **New extra `RawBody`** (mirror the existing `Proto` extra exactly):
   - `native_init()` allocates one reusable native struct = a
     `PerfettoTeHlExtraProtoFields` whose single field is a `…FieldRaw`.
   - `native_get_extra_ptr()` returns the `PerfettoTeHlExtra*` for the HL list.
   - `native_set_body(ptr, addr, len)` updates the RAW field's `{buf, len}` to
     point at the body for this event (called once per emit).
   - `native_delete()` registered with the memory cleaner.
   One instance per (root) builder, reused across events. No per-emit allocation.

2. **Body buffer**: the builder already encodes args/flows/proto into its reused
   `ProtoWriter` (`mBody`, zero-alloc). Copy it once into a reused off-heap
   buffer (the existing `EmitBuffer`, kept solely for this) and point the
   `RawBody` extra's `buf` at that stable address for the synchronous emit. One
   `memcpy`, no pinning, no `Get*ArrayElements` to release.

3. **`PerfettoTrackEventBuilder.emit()`** becomes one path (drop the LL branch):
   - `writeArgs()` + `writeFlows()` + counter/proto → `mBody` (as today in the
     "java emit" branch).
   - if `mBody.position() > 0`: copy `mBody` → off-heap, `rawBody.setBody(addr,
     len)`, `addPerfettoPointerToExtra(rawBody)`.
   - tracks / counters via their existing `flush*ToHl()` (unchanged).
   - `PerfettoTrackEventExtra.native_emit(type, cat, name, mExtra.getPtr())` —
     the existing HL call. The event name goes through HL's existing
     thread-local `StringBuffer` (no malloc), so there's no per-emit string JNI.

### Why this is clean / hard to leak or footgun
- No new lifetimes: body lives in the same reused buffer the LL path used; the
  framing extras are the same pooled objects HL already cleans up; `RawBody` is
  one reused object with a cleaner.
- No per-emit allocation, no `GetStringUTFChars`/`Get*ArrayElements` juggling,
  no manual extra-array marshalling. Native does one verbatim `memcpy`.
- Strictly fewer moving parts than today's LL path (no frame encoder, no
  reparse, no uuid/track caches) — those files get deleted.

## Then: delete the LL stack
`PerfettoEvent` frame encode/`encodeFrame`/`emitJava` LL path, the uuid caches,
the LL `native_emit`/frame format — all removable once the builder uses the
`RawBody` + HL path. Verify with `trace_processor` over a captured session, then
A/B the full scenario set (args, strings, mixed, tracks, nested, flows,
counters, proto) to confirm parity-or-better everywhere.
