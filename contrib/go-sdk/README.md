# Perfetto Go SDK

Go bindings for the [Perfetto](https://perfetto.dev) tracing SDK, built on top
of the Perfetto **C SDK** via cgo. This mirrors the Rust bindings in
[`contrib/rust-sdk`](../rust-sdk): the same amalgamated C SDK is compiled
directly into the package (together with a thin C shim), so no external Perfetto
shared library is needed.

This is **community-maintained, experimental** code — see [`contrib/README.md`](../README.md).

## Layout

| Path | Purpose |
|---|---|
| `perfetto/` | The cgo package: `perfetto.go` (API), `session.go`, `config.go`, and the C shim (`shim.h`/`shim.cc`). |
| `examples/track_event/` | Captures an in-process trace and writes `example.pftrace`. |

## Building

The bindings compile the **amalgamated C SDK**, which — like the Rust bindings —
is generated on demand and not checked in. Generate it once from the repo root:

```sh
tools/gen_amalgamated --sdk c --output contrib/go-sdk/perfetto/perfetto
```

This writes `perfetto_c.h` and `perfetto_c.cc` into `contrib/go-sdk/perfetto/`.
Then, from `contrib/go-sdk/`:

```sh
go test ./...          # runs the in-process capture test
go run ./examples/track_event
```

cgo compiles the amalgamated C++ source, so a C++17 compiler (clang++ or g++) is
required. The first build is slow (the amalgamated source is large); subsequent
builds are cached by the Go build cache.

## Usage

### Emit track events (system backend)

Events are recorded by an external consumer such as the `perfetto` CLI.

```go
perfetto.Init(perfetto.BackendSystem)
cat := perfetto.RegisterCategory("rendering", "Rendering events")
perfetto.PublishCategories()

defer cat.Slice("DrawFrame")()          // slice begin now, end on return
cat.Instant("vsync", perfetto.Str("phase", "begin"))
```

### Capture a trace in-process

```go
perfetto.Init(perfetto.BackendInProcess)
cat := perfetto.RegisterCategory("app", "App events")
perfetto.PublishCategories()

s := perfetto.NewInProcessSession()
defer s.Destroy()
s.Setup(perfetto.TraceConfig{
    BufferSizeKB:      1024,
    EnabledCategories: []string{"app"},
}.Encode())
s.StartBlocking()

cat.Instant("hello")

s.StopBlocking()
os.WriteFile("out.pftrace", s.ReadTrace(), 0o644)  // serialized perfetto.protos.Trace
```

## Scope

This first cut covers the most common track-event needs: categories, slice
begin/end (and scoped slices), instant events, and string debug annotations,
plus the full in-process tracing-session lifecycle (setup / start / stop / read).

Not yet ported from the Rust bindings (contributions welcome): registered and
counter tracks, flows, custom protobuf fields, the low-level data-source API, and
generated protobuf message builders. For a fully custom `TraceConfig`, encode it
with a protobuf library and pass the bytes to `Session.Setup`.
