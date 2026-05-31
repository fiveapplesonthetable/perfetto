# Hybrid emit stack (HL framing + Java-batched body)

A clean stack of small CLs, mirroring the LL stack but replacing the LL emit
approach with: keep the High Level emit (framing / interning / SMB), and carry
the variable body (debug args, proto fields) as ONE verbatim `RAW` proto field
instead of arg-by-arg. Outcome: parity with HL on empty events (the LL
small-event regression is gone) and faster than BOTH HL and LL on anything with
a payload (measured on a Pixel 4 XL: args/16 = 0.11x vs HL, 0.81x vs LL). It
also lets the entire LL apparatus (frame encoder, off-heap EmitBuffer, uuid /
track caches) be deleted -- simpler AND faster.

## CLs (each small, self-contained, reviewable)

1. **shared_lib: add PERFETTO_TE_HL_PROTO_TYPE_RAW** *(done -- 730ae63aaa)*
   The 20-line core primitive: a HL proto field appended verbatim via protozero's
   existing `Message::AppendRawProtoBytes`. Foundation for everything below.

2. **android_sdk: RawBody extra + hybrid emit path**
   A reusable `RawBody` extra (native + Java) mirroring the existing `Proto`
   extra: one `PerfettoTeHlExtraProtoFields` holding a single `RAW` field, with
   `set_body(addr,len)`. Builder gains a single HL emit path. Leak-safe: one
   reused object per builder, registered with the native memory cleaner; body
   lives in the builder's reused buffer copied once into a reused off-heap buffer.

3. **android_sdk: migrate debug args to the hybrid body**
   Args write into the body `ProtoWriter` (already buffered) and ride the
   `RawBody` extra instead of per-arg HL `Arg` extras. Drop `flushArgsToHl`.

4. **android_sdk: migrate flows** -- flows written into the body (process-track
   xor fixed64), drop the per-flow HL extras.

5. **android_sdk: migrate proto fields** -- beginProto/addField write into the
   body; the `RawBody` extra carries them. Drop the HL `Proto`/`Field` extras.

6. **android_sdk: keep counters + counter tracks on their HL extras**
   Counters/counter-tracks stay as HL extras (already optimal); the body rides
   alongside. No per-emit caching needed.

7. **android_sdk: keep named + nested tracks on their HL extras**
   `NAMED_TRACK` / `NESTED_TRACKS` HL extras unchanged; the LL nested-track frame
   encoding goes away. Nested tracks ride the existing `NESTED_TRACKS` extra.

8. **android_sdk: delete the LL emit stack**
   Remove `PerfettoEvent` frame encode/`encodeFrame`/`emitJava`, `EmitBuffer`,
   the LL `native_emit` + frame format, and the process/thread track uuid caches.
   `emit()` becomes the single HL path.

Verify each migration with `trace_processor` over a captured session, and A/B
the full scenario set (instant, slice, args, strings, mixed, tracks, nested,
flows, counters, proto) confirming parity-or-better vs HL everywhere.

## Verification gate — run at EVERY CL (no CL lands without it)

Each CL must clear the same bar before the next is stacked:

1. **Benchmark the full scenario set** on the real arm64 device (Pixel 4 XL,
   forced AOT): instant, slice, instant_int_args/{1,2,4,8,16},
   instant_string_args/4, instant_mixed_args/3, process/thread/nested tracks,
   instant_flows/{1,2,4}, counter int/double, instant_proto_fields/{1,4}.
   - No regression vs the previous CL on ANY scenario, and the migrated feature
     must be faster across all argument types/sizes (batching wins as the
     payload grows, parity at zero).
2. **Zero new allocations on the hot path.** The hybrid emit must stay
   allocation-free per event (reused ProtoWriter body, reused off-heap buffer,
   reused RawBody/track/counter/flow extras). Check by counting allocations
   around a tight emit loop (flat line expected) and confirming no new/autobox
   in the per-emit path on review.
3. **Trace correctness:** capture a session and parse it with trace_processor;
   wire output must be identical to the pre-migration path.

Only when all three pass does the next migration stack on top.
