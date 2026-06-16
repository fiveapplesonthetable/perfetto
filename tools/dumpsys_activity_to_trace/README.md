# dumpsys activity → Perfetto

Open an Android `dumpsys activity --proto` capture directly in the Perfetto UI
and explore it with the **Process state explorer** (`com.android.ProcessState`)
— the oom-adj tier graph, process table, and binding details — with **no device
or framework change**.

## How it works

`dumpsys activity --proto` already emits a structured `ActivityManagerService`
proto on every device (zero new producer code). This tool wraps those bytes
into a Perfetto trace using Perfetto's
[ExtensionDescriptor](../../docs/instrumentation/extensions.md) mechanism: the
AMS proto is attached as a `TrackEvent` extension and its `FileDescriptorSet` is
embedded in the trace, so `trace_processor` auto-decodes the entire tree into
the `args` table — no per-field importer, no vendored proto. The
`com.android.ProcessState` plugin pivots those args
(`am_dumpsys.processes…`, `…service_records[].connections[]…`) into the
process / service / binding relations its graph reads.

## Steps

```sh
# 1. Build the descriptor set (one-off; AMS proto comes from an AOSP checkout).
protoc --include_imports \
    --descriptor_set_out=combined.desc \
    -I <perfetto> \
    -I <aosp> \
    -I <aosp>/external/protobuf/src \
    -I tools/dumpsys_activity_to_trace \
    dumpsys_activity_extension.proto

# 2. Capture from the device (no root, no device change).
adb shell dumpsys activity --proto > ams.pb

# 3. Convert and open ams.pftrace in https://ui.perfetto.dev.
tools/dumpsys_activity_to_trace/convert.py --desc combined.desc --in ams.pb --out ams.pftrace
```

The `Process state explorer` entry appears in the sidebar; it shows every
process in oom-adj tier columns, with service-binding edges (client → host,
foreground bindings in red) and a per-process details panel.

## Coverage

`dumpsys activity --proto` is a point-in-time snapshot, so the explorer shows a
single snapshot (no timeline). Content-provider bindings and the OomAdjuster
derivation steps aren't in the dumpsys proto, so those parts of the explorer are
empty; everything else (processes, oom-adj, services, service bindings,
why-alive `adj_source`) is populated. Any other `dumpsys <svc> --proto` can be
ingested the same way by adding an extension hook for that service's proto.
