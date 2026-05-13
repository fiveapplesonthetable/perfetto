# Bitmap identity and dedup in AOSP heap dumps

This document is the AOSP-source-of-truth backing for the
HeapDumpExplorer UI columns added in this CL. The underlying stdlib
module — `android.memory.heap_graph.bitmap`, table
`heap_graph_bitmaps` — is shipped separately by upstream PR
[#5824](https://github.com/google/perfetto/pull/5824) ("stdlib: Add
bitmap specific table with bitmap metadata."), authored by
zezeozue@google.com; this CL consumes it. Every claim below is
cited inline by file path plus line number against the sources on
this machine (`/home/zim/dev/aosp`); nothing is paraphrased from
secondary sources.
The narrative builds bottom-up: define the problem, define the two
layers of bitmap bytes, walk each pixel-storage type, define `mId`
and `mSourceId`, walk the parcel sender/receiver flow, then derive
the dedup verdict each combination implies. By the end you can read
a row in the new `heap_graph_bitmaps` table and tell what
real RAM cost it carries.

---

## 1. The problem

HeapDumpExplorer's bitmap-gallery panel can identify "duplicate"
bitmaps by content-hashing each Bitmap's encoded pixel buffer (the
JPEG/PNG/WEBP bytes stored as a `byte[]` on the Java heap — §6 below
for the mechanism). The trace_processor exposes the precomputed hash
as `heap_graph_object_data.array_data_hash`; HDE's current query
groups Bitmaps by it (`queries.ts:194-240`).

That signal answers "do these N Bitmaps look the same?" — pixel
content is byte-identical at the dumpData level. But it does *not*
answer "are you paying for N copies of those pixels in RAM?". A
single Bitmap shared across processes via ashmem-fd transfer will
show up in N receivers' heap dumps with the same content hash, yet
the kernel attributes those pages once (proportionally via PSS).
A Bitmap whose backing was decoded independently in two places will
also show up as duplicate-by-content, but here each copy costs full
RSS in its owning process.

What we need to distinguish those cases is the underlying pixel
storage type and, when the Bitmap was parcel-received, the source
identity. Java fields `Bitmap.mId` and `Bitmap.mSourceId` carry
exactly that information, encoded in a known scheme. This CL surfaces
them in the stdlib and the UI.

---

## 2. Two layers of bitmap bytes

A useful frame for everything below: bitmap pixels live in two
places, and only one of them participates in cross-process sharing.

### Layer 1 — native pixel buffers

The actual decoded pixels for each Bitmap live in one of four native
backings, enumerated by the C++ `PixelStorageType` enum
(`frameworks/base/libs/hwui/hwui/Bitmap.h:39-44`):

```cpp
enum class PixelStorageType {
    WrappedPixelRef = 0,
    Heap            = 1,
    Ashmem          = 2,
    Hardware        = 3,
};
```

This is the layer where sharing is possible. ashmem regions can be
fd-transferred across processes (kernel pages shared via page cache).
`AHardwareBuffer*` handles are refcounted and can be wrapped by
multiple Java Bitmaps (one GPU allocation, N Java wrappers).
`SkPixelRef` references are refcounted on the Skia side. The
malloc'd heap region is the only backing that genuinely can't be
shared. §3 walks each storage type's allocation path and sharing
semantics.

### Layer 2 — `Bitmap$DumpData.buffers` Java `byte[]` arrays

A Bitmap can also be reported in the heap dump in *encoded* form — as
a Java `byte[]` holding a JPEG / PNG / WEBP rendition of its pixels —
via the static `Bitmap.dumpData.buffers` field (`byte[][]` declared
at `Bitmap.java:1610`). Each non-null entry is one Bitmap's compressed
representation, populated by `Bitmap.dumpAll(format)` immediately
before an HPROF capture.

These are ordinary Java objects on the GC heap. There is **no
Java-side sharing primitive**: every `byte[]` is its own managed-heap
allocation, GC-scanned and relocatable. Two `byte[]`s with identical
content are real duplicate Java heap bytes — the GC sees them as
distinct objects, the HPROF serializes each one's bytes inline, and
`heap_graph_object_data.array_data_hash` matches them only as
*identical content*, not as the same allocation. None of layer 1's
"could be kernel-shared" cases apply at layer 2.

Two important consequences flow from this distinction:

* **Layer 2 is what HDE's content-hash dedup reads.** The new
  Storage / Source / Bitmap ID columns from this CL come from
  `heap_graph_primitive`, which reflects the Java side of layer 1's
  metadata — `mId`, `mSourceId`, `mNativePtr`, etc. The columns let
  you climb from a layer-2 duplicate-by-content match back down to a
  layer-1 question about real RAM cost.
* **Layer 2 byte[]s are transient.** Their entire purpose is to ship
  pixel content into the HPROF. `Debug.dumpHprofData(file, fmt)`
  primes them with `Bitmap.dumpAll(fmt)` and clears them with
  `Bitmap.dumpAll(null)` in `finally` (`Debug.java:2175-2179,
  2197-2201`). They exist in the live process only during the dump
  window. The HPROF captures the snapshot; the live process
  doesn't carry the overhead afterwards.

The CL focuses on the layer-1 question because that's what matters
for live app memory. Where layer 2 is relevant (HPROF availability,
content-hash matching), it's called out explicitly.

---

## 3. The four `PixelStorageType` backings

Each backing has a distinct allocation path, ownership story, sharing
mechanism, and dedup verdict. Walking them in order of how often they
appear on a real device.

### 3.1 `Heap` (1) — private malloc'd memory

Allocated by `Bitmap::allocateHeapBitmap(size, info, rowBytes)`,
`Bitmap.cpp:239-244`:

```cpp
sk_sp<Bitmap> Bitmap::allocateHeapBitmap(size_t size,
                                          const SkImageInfo& info,
                                          size_t rowBytes) {
    void* addr = calloc(size, 1);
    if (!addr) return nullptr;
    return sk_sp<Bitmap>(new Bitmap(addr, size, info, rowBytes));
}
```

* **Backing:** plain `calloc`'d bytes, owned by this Bitmap.
* **Sharing:** never. Each Bitmap has its own malloc'd region; the
  destructor (`Bitmap.cpp:393-397`) `free()`s it and calls
  `mallopt(M_PURGE, 0)` on Android.
* **Cross-process transport:** parcel-write goes Path B (blob copy),
  see §5.
* **When chosen:** most `BitmapFactory.decode*` calls; `Bitmap.copy`;
  `Bitmap.createBitmap` (basic forms); the Bitmap_createFromParcel
  in-place blob-copy callback (`jni/Bitmap.cpp:933-935`).
* **Heap-dump signal:** `bitmap_storage_type='heap'`. Native pixel
  bytes contribute to `heap_graph_object.native_size` because libhwui
  registers the malloc via `NativeAllocationRegistry`
  (`Bitmap.java:161-183`).

**Dedup verdict at layer 1:** two `heap` Bitmaps with identical
content always mean wasted RAM. Saving = `(count − 1) × allocation_byte_count`.

### 3.2 `Ashmem` (2) — shared kernel memory

Allocated by `Bitmap::allocateAshmemBitmap`, `Bitmap.cpp:184-208`:

```cpp
sk_sp<Bitmap> Bitmap::allocateAshmemBitmap(size_t size,
                                            const SkImageInfo& info,
                                            size_t rowBytes) {
#ifdef __ANDROID__
    uint64_t id = getId(PixelStorageType::Ashmem);
    auto ashmemId = getAshmemId("allocate", id, info.width(), ...);
    int fd = ashmem_create_region(ashmemId.c_str(), size);
    ...
    void* addr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    ...
    return sk_sp<Bitmap>(new Bitmap(addr, fd, size, info, rowBytes, id));
```

* **Backing:** a kernel ashmem region (POSIX-shared-memory-like). The
  Bitmap holds an open fd and an mmap'd address range.
* **Sharing:** cross-process by fd transfer through Binder. Multiple
  processes mmap'ing the same fd see the same kernel pages; the
  kernel attributes them as PSS-shared. Within a single process,
  multiple mmaps of the same fd also share physical pages
  (page-cache deduplication).
* **Cross-process transport:** parcel-write goes **Path A** (fd
  transfer) when the Bitmap is immutable, **Path B** (blob copy)
  otherwise. §5 details both paths.
* **When chosen:** explicit code paths that opt into shared memory
  (icon services, IPC-heavy frameworks). Most app code does not
  default to ashmem.
* **Heap-dump signal:** `bitmap_storage_type='ashmem'`. The
  `heap_graph_object.native_size` is small (it represents the
  BitmapWrapper struct, not the pixel pages — those live outside
  the malloc-tracked native heap).

**Dedup verdict at layer 1** (refined by `source_id`):

* Two `ashmem` Bitmaps with same content **and** same non-`-1`
  `mSourceId` (and the sender was also `ashmem`): kernel pages
  shared, **not wasted**. The Path-A receive at
  `jni/Bitmap.cpp:941-957` mmaps the sender's transferred fd, so
  the same physical pages back both Bitmaps.
* Two `ashmem` Bitmaps with `mSourceId IS NULL`: independent
  `allocateAshmemBitmap` calls, **fully wasted** — each is its own
  kernel region.

### 3.3 `Hardware` (3) — AHardwareBuffer / GraphicBuffer

Allocated by `HardwareBitmapUploader::allocateHardwareBitmap`
(invoked from `Bitmap.cpp:213`) or wrapped from an existing
`AHardwareBuffer` via `Bitmap::createFrom(AHardwareBuffer*, ...)`
at `Bitmap.cpp:253-277`. Constructor body at `Bitmap.cpp:363-378`:

```cpp
Bitmap::Bitmap(AHardwareBuffer* buffer, ...) ... {
    mPixelStorage.hardware.buffer = buffer;
    mPixelStorage.hardware.size = AHardwareBuffer_getAllocationSize(buffer);
    AHardwareBuffer_acquire(buffer);
    setImmutable();   // HW bitmaps are always immutable
    mImage = SkImages::DeferredFromAHardwareBuffer(buffer, ...);
    ...
}
```

* **Backing:** an `AHardwareBuffer*` — a refcounted kernel handle to
  GPU-accessible memory (typically gralloc / dma-buf-backed).
* **Sharing:** `AHardwareBuffer` handles are refcounted and can be
  shared cross-process via Binder. Two Java Bitmaps wrapping the
  same `AHardwareBuffer*` share the GPU allocation; each
  `AHardwareBuffer_acquire` bumps the refcount.
* **Cross-process transport:** parcel-write goes Path B (the
  hardware Bitmap has no ashmem fd, so the Path-A condition
  `fd >= 0` at `jni/Bitmap.cpp:1049` fails). Receivers allocate
  their own fresh region.
* **When chosen:** `HardwareRenderer.createHardwareBitmap`,
  `Bitmap.copy(Config.HARDWARE, false)`, `ImageDecoder.decodeBitmap`
  with hardware allocator hint, screen capture pipelines
  (`SurfaceFlinger`, `MediaProjection`).
* **Heap-dump signal:** `bitmap_storage_type='hardware'`. The Java
  field `mHardwareBuffer` (a `WeakReference<HardwareBuffer>`,
  `Bitmap.java:99`) holds the wrapper. The `AHardwareBuffer*`
  identity is NOT in `mId`, so two `hardware` Bitmaps with the same
  content hash could (a) wrap one handle (no GPU duplication) or
  (b) wrap two distinct handles holding identical pixels (full GPU
  duplication). Disambiguating requires walking
  `mHardwareBuffer.handle.id` via `heap_graph_reference` — out of
  scope for this CL.

**Dedup verdict at layer 1:** ambiguous from `mId` / `mSourceId`
alone. Most common case in practice is (b) — two GPU allocations
holding the same pixels, which is wasted GPU memory.

### 3.4 `WrappedPixelRef` (0) — wrapping an existing `SkPixelRef`

The only storage type where the Bitmap **does not own** its pixel
memory. The other three storage types all imply ownership: `~Bitmap()`
frees the malloc'd buffer / `munmap`s the ashmem region /
`AHardwareBuffer_release`s the GPU buffer. `WrappedPixelRef` just
holds a refcounted reference to a pre-existing `SkPixelRef*`
allocated by some other code.

Allocated by `Bitmap::createFrom(const SkImageInfo&, SkPixelRef&)`,
`Bitmap.cpp:247-249`, with the constructor at `Bitmap.cpp:340-348`:

```cpp
Bitmap::Bitmap(SkPixelRef& pixelRef, const SkImageInfo& info)
        : SkPixelRef(info.width(), info.height(),
                     pixelRef.pixels(), pixelRef.rowBytes())
        , mInfo(validateAlpha(info))
        , mPixelStorageType(PixelStorageType::WrappedPixelRef)
        , mId(getId(mPixelStorageType)) {
    pixelRef.ref();
    mPixelStorage.wrapped.pixelRef = &pixelRef;
    traceBitmapCreate();
}
```

* **Backing:** an externally-owned `SkPixelRef*`. Pixels live
  wherever that external code allocated them.
* **Sharing:** entirely a property of the wrapped `SkPixelRef`. Two
  Bitmaps that wrap the same `SkPixelRef*` share its pixels; two
  that wrap distinct refs share nothing. The Java heap graph cannot
  see the `SkPixelRef*` — it lives in C++ — so this distinction is
  invisible from an HPROF.
* **Cross-process transport:** none. `SkPixelRef`s are Skia-internal
  and have no parcelling story. You will never see a
  `wrapped_pixel_ref` Bitmap with a non-`-1` `mSourceId`.
* **When chosen on a real device:** four narrow code paths:
  1. **Hardware-bitmap transform** —
     `Bitmap.createBitmap(hardwareSource, x, y, w, h, m, filter)`
     (`Bitmap.java:1001-1004`) calls `nativeCopyPreserveInternalConfig`,
     which wraps the source's `SkPixelRef`
     (`jni/Bitmap.cpp:1322`) so a transformation canvas can draw it.
     Short-lived intermediate.
  2. **NDK `AImageDecoder`** — `apex/android_bitmap.cpp:346, 387`
     use `createFrom(info, pixelRef)` to expose decoder-owned
     buffers to the NDK API. Only path likely to be retained.
  3. **Legacy `Movie` frames** — `jni/Movie.cpp:77` wraps each frame's
     `SkPixelRef` for the deprecated `Movie` API.
  4. **Layoutlib** — Studio IDE's bitmap preview rendering, where
     the framework runs against host-allocated Skia bitmaps.
* **Heap-dump signal:** `bitmap_storage_type='wrapped_pixel_ref'`,
  `mSourceId == -1` (always).

**Dedup verdict at layer 1:** indeterminate from the heap dump
alone. In practice we observed zero `wrapped_pixel_ref` instances
across ~50 cuttlefish Bitmaps in §10, consistent with these paths
being either transient or off-device.

---

## 4. `Bitmap.mId` — process-monotonic instance identifier

### 4.1 Declaration and assignment

`frameworks/base/graphics/java/android/graphics/Bitmap.java`:

```java
75:    @UnsupportedAppUsage
76:    private final long mNativePtr;
...
109:    private long mId;
...
199:    Bitmap(long id, long nativeBitmap, int width, int height, int density,
200:            boolean requestPremultiplied, byte[] ninePatchChunk,
201:            NinePatch.InsetStruct ninePatchInsets, boolean fromMalloc) {
...
206:        mId = id;
...
216:        mNativePtr = nativeBitmap;
```

`mId` is set once in the constructor from a JNI-supplied long. No
setter, no reassignment. `mNativePtr` is `final` and points at a
`BitmapWrapper*` — the JNI-side opaque holder around the C++
`android::Bitmap`. Both are visible in HPROF as Java long fields.

### 4.2 Native generation — the encoding

`frameworks/base/libs/hwui/hwui/Bitmap.cpp:122-127`:

```cpp
//   1) the monotonic number could increase beyond 1000,000 and wrap around,
//   which only happens when more than 1,000,000 bitmaps have been created
//   over time. This could result in two IDs being the same despite being
//   really rare.
//   2) the IDs are intentionally represented in decimal to make it easier to
//   reason and associate with numbers shown in heap dump (mostly in decimal)
//   and PIDs shown in different tools (mostly in decimal as well).
uint64_t Bitmap::getId(PixelStorageType type) {
    static std::atomic<uint64_t> idCounter{0};
    return (idCounter.fetch_add(1) % 1000000)
        + static_cast<uint64_t>(type) * 1000000
        + static_cast<uint64_t>(getpid()) * 10000000;
}
```

Decimal layout (chosen for human-readability in dumps):

```
 mId = pid * 10^7  +  storage_type * 10^6  +  (counter % 10^6)
```

`getId(type)` is called from every concrete Bitmap constructor that
allocates fresh pixel memory: `Bitmap.cpp:334` (Heap), `:344`
(WrappedPixelRef), `:355` (Ashmem — note the third constructor
takes an explicit `id` parameter so the ashmem-region allocation in
`allocateAshmemBitmap` can keep its `mId` across the alloc/wrap
split), `:370` (Hardware). The JNI then passes the value into the
Java constructor (`jni/Bitmap.cpp:285-300`).

### 4.3 Decoding a real `mId`

From `/tmp/cf-systemserver.hprof` (cuttlefish, recorded 2026-05-10):
one Bitmap with `mId = 9432000084`.

* `9432000084 / 10^7 = 943` → pid 943 (system_server).
* `(9432000084 % 10^7) / 10^6 = 2` → `PixelStorageType::Ashmem`.
* `9432000084 % 10^6 = 84` → the 85th Bitmap allocated in pid 943.

The stdlib helpers `_android_bitmap_storage_type_name` and the
arithmetic in `heap_graph_bitmaps` decode these components
into named columns (`bitmap_pid`, `bitmap_storage_type`).

### 4.4 What `mId` does and doesn't tell you

`mId` *is*:

* A stable per-instance identifier within one process lifetime.
* Self-describing — pid and storage type recoverable from the value
  alone.
* Useful for correlating a Bitmap with its `Bitmap_writeToParcel` /
  `Bitmap_createFromParcel` perfetto slice (the JNI uses `mId` as
  the slice flow id, `jni/Bitmap.cpp:1018, 1039, 895, 898`).

`mId` is *not*:

* A content key. Two Bitmaps with byte-identical pixels have
  different `mId`s.
* A pixel-memory key. Two Bitmaps that share underlying ashmem
  pages have different `mId`s (the IDs are minted at construction,
  before sharing is set up).
* Stable across processes. Even for a parcel-shared Bitmap, the
  receiver's Bitmap gets a fresh `mId` (with the receiver's pid in
  the high bits); the sender's `mId` lives in the receiver's
  `mSourceId` field instead.
* A dedup key. *Every* allocation gets a fresh value; two Bitmap
  objects in one process are guaranteed to have distinct `mId`s.

---

## 5. `Bitmap.mSourceId` — cross-process source identifier

### 5.1 Declaration and default

`Bitmap.java:111-114`:

```java
// source id of the bitmap where this bitmap was created from, e.g.
// in the case of ashmem bitmap received, mSourceId is the mId of
// the bitmap from the sender
private long mSourceId = -1;
```

The native side declares the same `uint64_t mSourceId = -1` at
`Bitmap.h:255`. `-1` is the `UNDEFINED_BITMAP_ID` sentinel. The new
stdlib canonicalises `-1` to SQL `NULL` so consumers can use
`source_id IS NOT NULL` to find parcel-received Bitmaps.

### 5.2 The sender → receiver flow

The only path that writes a non-`-1` `mSourceId` is the parcel
reconstruction path.

**Sender side** — `Bitmap_writeToParcel` at `jni/Bitmap.cpp:1005-1082`:

```cpp
1018:    uint64_t id = bitmapWrapper->bitmap().getId();
...
1034:    p.writeInt64(id);                              // sender's mId on wire
...
1047:    // Transfer the underlying ashmem region if we have one and it's immutable.
1049:    int fd = bitmapWrapper->bitmap().getAshmemFd();
1050:    if (fd >= 0 && p.allowFds() && bitmap.isImmutable()) {
1057:        status = writeBlobFromFd(p.get(),
                          bitmapWrapper->bitmap().getAllocationByteCount(), fd);
                                                       // Path A: dup ashmem fd
        ...
1071:    status = writeBlob(p.get(), id, bitmap, !asMutable);
                                                       // Path B: copy bytes
```

Path A — sender's ashmem fd dup'd into the parcel — fires only when:

1. The sender has an ashmem fd (`getAshmemFd() >= 0` → sender storage
   is `ashmem`).
2. The parcel allows fd transfer (`p.allowFds()`).
3. The Bitmap is immutable.

Path B fires otherwise. `writeBlob` may put the payload inline (small
sizes) or allocate a fresh ashmem region for the receiver to mmap
(large sizes); the choice is internal to libbinder's blob allocator.

**Receiver side** — `Bitmap_createFromParcel` at `jni/Bitmap.cpp:863-980`:

```cpp
891:    const int64_t sourceId = p.readInt64();       // sender's mId off wire
...
925:    binder_status_t error = readBlob(p.get(),
            // In-place callback — heap-allocate, memcpy from blob.
928:        [&](std::unique_ptr<int8_t[]> buffer, int32_t size) {
933:            nativeBitmap = Bitmap::allocateHeapBitmap(allocationSize, imageInfo, rowBytes);
935:            memcpy(nativeBitmap->pixels(), buffer.get(), allocationSize);
                ...
            },
            // Ashmem callback — mmap the sender's transferred fd.
941:        [&](android::base::unique_fd fd, int32_t size) {
950:            void* addr = mmap(nullptr, size, flags, MAP_SHARED, fd.get(), 0);
                ...
956:            nativeBitmap = Bitmap::createFrom(imageInfo, rowBytes,
                    fd.release(), addr, size, !isMutable);
            });
...
972:    nativeBitmap->setSourceId(sourceId);          // store sender's mId
```

The receiver's chain:

1. Pull the sender's `mId` off the parcel (line 891).
2. Allocate a fresh native Bitmap. The receiver gets a *new* `mId`
   (with the receiver's pid in the high bits). Whether the new
   Bitmap is `heap`-backed or `ashmem`-backed depends on which
   readBlob callback fires:
   * **Heap callback** — sender went Path B with a small payload; the
     blob came inline; receiver does `allocateHeapBitmap` +
     `memcpy`. Receiver storage = `heap`.
   * **Ashmem callback** — sender went Path A *or* Path B with a
     large payload; in both cases an fd is in the parcel; receiver
     mmaps it. Receiver storage = `ashmem`.
3. Stamp `mSourceId = sourceId` on the receiver (line 972).

### 5.3 What `mSourceId` means

* `mSourceId == -1`: locally allocated. None of `BitmapFactory.decode*`,
  `Bitmap.copy`, `Bitmap.createBitmap`, `Canvas.drawBitmap`, etc.
  set `mSourceId`.
* `mSourceId != -1`: reconstructed from a Parcel. The value is the
  sender's `mId` at writeToParcel time. From it you can decode:
  * `sender_pid = mSourceId / 10^7`
  * `sender_storage_type = (mSourceId % 10^7) / 10^6` — exposed by
    the stdlib as `source_storage_type`.

### 5.4 The Path A vs Path B ambiguity

The receiver cannot tell from its own state alone which path the
sender took. A receiver with `storage=ashmem` and `source_id` non-NULL
was either:

* **Path A**: sender was ashmem-backed *and* immutable, fd was
  dup'd, receiver's mmap hits the same kernel pages as the sender's.
  **Pixels kernel-shared, not wasted.**
* **Path B with large payload**: sender was anything; `writeBlob`
  chose the ashmem-region path internally; receiver mmaps a fresh
  region. **Pixels not shared, doubled.**

The disambiguator is the **sender's storage type** (decoded from
`source_id`). Path A requires sender_storage = `ashmem`. If
`source_storage_type` is `heap` or `hardware`, Path A is impossible
and the verdict is definitively doubled. If `source_storage_type`
is `ashmem`, Path A is plausible but not certain — the sender's
mutability at writeToParcel time isn't preserved on the receiver
side. In practice, ashmem-backed Bitmaps are almost always
immutable (ashmem is used specifically for cross-process sharing,
which implies immutability), so the heuristic "sender=ashmem,
receiver=ashmem, same source_id" ≈ Path A holds ~always.

The stdlib columns expose the inputs (`bitmap_storage_type`,
`source_storage_type`) so consumers can apply the verdict logic
themselves; §8 makes the verdict matrix explicit.

---

## 6. HPROF and dumpData — how pixel content lands

An HPROF captures only the Java heap. The native pixel buffers from
§3 don't enter the file. The only way bitmap pixel content lands in
an HPROF is via the layer-2 `Bitmap$DumpData.buffers` `byte[][]`
field — each non-null entry being one Bitmap's compressed
representation, populated by `Bitmap.dumpAll(format)`.

### 6.1 `Bitmap.dumpAll`

`Bitmap.java:1660-1683`:

```java
public static void dumpAll(@Nullable String format) {
    if (format == null) {
        /* release the dump data */
        dumpData = null;
        return;
    }
    final CompressFormat fmt = CompressFormat.from(format);
    ...
    final ArrayList<Bitmap> allBitmaps = getAllBitmaps();
    dumpData = new DumpData(fmt, allBitmaps.size());
    for (Bitmap bitmap : allBitmaps) {
        ByteArrayOutputStream bas = new ByteArrayOutputStream();
        if (bitmap.compress(fmt, 90, bas)) {
            dumpData.add(bitmap.getNativeInstance(), bas.toByteArray(),
                    bitmap.getAllocationByteCount());
        }
    }
    ...
}
```

`getAllBitmaps()` returns the keys of `sAllBitmaps`, a
`WeakHashMap<Bitmap, Void>` declared at `Bitmap.java:139` and populated
by every Bitmap constructor (line 220-222). So `dumpAll` iterates
every live Bitmap regardless of storage type.

### 6.2 Where compress() reads from and writes to

This is the question "the bytes from dumpAll are in native land
anyway — is that reading from ashmem or native heap?" — answered
storage-by-storage by `Bitmap::getSkBitmap` at `Bitmap.cpp:453-462`:

```cpp
void Bitmap::getSkBitmap(SkBitmap* outBitmap) {
#ifdef __ANDROID__
    if (isHardware()) {
        outBitmap->allocPixels(mInfo);                        // alloc CPU buffer
        RenderProxy::copyHWBitmapInto(this, outBitmap);       // GPU->CPU readback
        return;
    }
#endif
    outBitmap->setInfo(mInfo, rowBytes());
    outBitmap->setPixelRef(sk_ref_sp(this), 0, 0);            // wrap existing pixels
}
```

Per storage type:

* `heap` source → `pixels()` points at `mPixelStorage.heap.address`,
  malloc'd native heap, private to this process.
* `ashmem` source → `pixels()` points at `mPixelStorage.ashmem.address`,
  the mmap'd ashmem region. If the region is Path-A-shared with
  the sender, these reads hit kernel page-cache pages without
  re-faulting them.
* `hardware` source → `getSkBitmap` allocates a fresh CPU buffer
  and pumps the GPU buffer into it. The encoder reads that fresh
  buffer (private to this process). Slow because of the GPU→CPU
  sync, hence the `StrictMode.noteSlowCall("Compression of a
  bitmap is slow")` warning at `Bitmap.java:1761`.
* `wrapped_pixel_ref` source → reads from the wrapped external
  `SkPixelRef`'s pixels.

The **encoded output** flows through an `SkWStream` adapter
(`CreateJavaOutputStreamAdaptor` at `jni/Bitmap.cpp:611`) that
forwards every native-side write back into the Java `OutputStream`
via JNI. The bytes end up in `bas`'s internal Java byte[] buffer.
After compress returns, `bas.toByteArray()` (`Bitmap.java:1678`)
calls `Arrays.copyOf` and produces a fresh Java byte[] for
`dumpData.buffers[i]`. So the output never lives in ashmem; it's
always managed-heap.

**So: shared-storage source bitmaps get cheaper page-cache reads
during encoding, but every receiver's dumpData byte[] output is a
real, private Java heap allocation.**

### 6.3 When `Bitmap.dumpAll` actually runs

A grep across `/home/zim/dev/aosp` finds two callers:

* **`android.os.Debug.dumpHprofData(String fileName, String bitmapFormat)`**
  — `Debug.java:2168-2200`:

  ```java
  public static void dumpHprofData(String fileName, String bitmapFormat)
          throws IOException {
      try {
          if (bitmapFormat != null) {
              Bitmap.dumpAll(bitmapFormat);     // prime dumpData
          }
          VMDebug.dumpHprofData(fileName);      // write HPROF
      } finally {
          if (bitmapFormat != null) {
              Bitmap.dumpAll(null);             // clear dumpData
          }
      }
  }
  ```

  Only path that primes `dumpData` for an HPROF, and only when
  `bitmapFormat` is non-null.

* **`ActivityThread.dumpBitmapsProto(...)`** (`ActivityThread.java:4090`)
  uses the proto-stream variant of `dumpAll` (`Bitmap.java:1694`),
  which writes directly to a passed-in `ProtoOutputStream` instead
  of populating the static `dumpData` field. This path doesn't
  affect HPROF — its output goes to whoever requested the proto
  (typically `dumpsys meminfo --proto`).

Which means:

| Capture path | dumpAll invoked? | HPROF has pixel content? |
|---|---|---|
| `am dumpheap <pid> <file>` | No | No |
| perfetto `android.java_hprof` data source | No | No |
| ART SIGUSR1 / heap-snapshot signal | No | No |
| `Debug.dumpHprofData(file, "png"/"jpg"/"webp")` | Yes | Yes |
| Studio "Dump Java heap" button | Yes (uses `Debug.dumpHprofData` with format) | Yes |

The cuttlefish HPROFs captured for §10 via `am dumpheap` show "1
bitmap without pixel data" in the UI not because of any storage type
property, but because dumpData was never primed. The new Storage /
Source / Bitmap ID columns from this CL still work in those cases
— they're sourced from `heap_graph_primitive`, not from `dumpData`
— which is the value-add: provenance and likely-RAM-cost are
readable even when pixel content isn't.

### 6.4 How HDE consumes dumpData

When dumpData was primed, HDE walks from the `Class<android.graphics.Bitmap>`
heap_graph_object through its `dumpData` static reference into the
parallel `natives` (`long[]`) and `buffers` (`Object[]` of `byte[]`)
arrays, building a `Map<nativePtr, bufferObjectId>` so each Bitmap
row can look up its encoded byte[]
(`queries.ts:1457-1556`, `queries.ts:200-214`).

Content-hash dedup uses the precomputed
`heap_graph_object_data.array_data_hash` on those byte[]s
(`queries.ts:218-224`). Two byte[]s with the same hash are
byte-identical at layer 2 — which corresponds to byte-identical
encoded pixel buffers, which (for any reasonable codec/quality) means
byte-identical decoded pixels. The hash is necessary but not
sufficient for "wasted RAM" at layer 1; combining with
`bitmap_storage_type` and `source_storage_type` is what gives the
layer-1 verdict.

---

## 7. Same-process RSS vs PSS — what a duplicate actually costs

This section answers "what cases is it actually doubling RSS / PSS
bytes in process?" — using the layer-1 verdict from §3-5.

For two Bitmaps in one heap dump with the same `array_data_hash`:

| Storage / source combination | Same-process RSS doubled? | Same-process PSS doubled? |
|---|---|---|
| `heap` + both `source_id IS NULL` | Yes | Yes |
| `heap` + non-NULL `source_id` (Path-B receive) | Yes | Yes |
| `ashmem` + both `source_id IS NULL` (independent allocs) | Yes | Yes |
| `ashmem` + same non-NULL `source_id`, sender=`heap`/`hardware` (forced Path B) | Yes | Yes |
| `ashmem` + same non-NULL `source_id`, sender=`ashmem` (very likely Path A) | Kernel-dependent: typically yes for per-VMA accounting, no for physical-page count | No — `/proc/PID/smaps` divides each shared page across referencing VMAs |
| `hardware` wrapping the **same** `AHardwareBuffer` | No | No |
| `hardware` wrapping **different** `AHardwareBuffer`s | Yes | Yes |
| `wrapped_pixel_ref` | Indeterminate | Indeterminate |

### Byte-level worked example

A 256×256 `ARGB_8888` Bitmap is `256 × 256 × 4 = 262,144` bytes of
pixel data. If five such Bitmaps appear in one process all
`storage='heap'` with all `source_id IS NULL`:

* RSS = `5 × 262,144 = 1,310,720` bytes (~1.25 MB).
* PSS = same (heap pages are private).
* Reclaimable by caching one decoded image = `4 × 262,144 ≈ 1.0 MB`.

If the same five were `storage='ashmem'` with identical non-NULL
`source_id`s and sender=`ashmem` (the rare Path-A same-process
double-receive):

* RSS still ~1.25 MB (kernel may count each VMA's resident pages).
* PSS ~`262,144` bytes (~256 KB) — each shared page is divided
  across the five VMAs that map it, summing back to one page worth.
* Reclaimable ≈ 0 — kernel is already sharing.

The whole point of the new columns is to read off which row applies
without having to walk down to `/proc/PID/smaps`.

### Cross-process view

When the same Bitmap is parceled to multiple processes via Path A
(immutable + ashmem + fds-allowed sender; `jni/Bitmap.cpp:1057`):

* Each receiving process's RSS counts the full region.
* Each receiving process's PSS divides shared pages by the number of
  processes mapping them. Total system PSS = `region_size`,
  distributed proportionally.
* Without `source_id`, an analyst summing per-process bitmap RSS
  across processes counts the region N times. With `source_id`, the
  group can be collapsed and attributed once.

This is where `mSourceId` pays off most. The system_server cuttlefish
example in §10 (38×48 bitmap from `com.android.phone`) is exactly
this pattern.

---

## 8. The dedup decision matrix — what `mId` + `mSourceId` can determine

Given two Bitmaps A and B with the same `array_data_hash`, this is
the complete table of what the new columns let you classify.

### Definitively determinable from `mId` + `mSourceId` alone

| receiver_storage | source_id | sender_storage (decoded from source_id) | Verdict |
|---|---|---|---|
| `heap` | NULL | — | **Doubled.** Independent local heap allocations. Reclaimable = `(N-1) × allocation_byte_count`. |
| `heap` | non-NULL | * | **Doubled.** Path A always lands as `ashmem` on the receiver (`jni/Bitmap.cpp:956`); a `heap` receiver with a non-NULL `source_id` is therefore Path B (in-place blob copy → `Bitmap::allocateHeapBitmap` at `jni/Bitmap.cpp:933`). Each receiver pays full bytes. |
| `ashmem` | NULL | — | **Doubled.** No parcel involved; each `Bitmap::allocateAshmemBitmap` produces a fresh kernel region (`Bitmap.cpp:184-208`). |
| `ashmem` | non-NULL | `heap` or `hardware` | **Doubled.** The sender had no ashmem fd (`writeToParcel:1049` `getAshmemFd()` returns -1), so Path A is impossible — the sender went Path B with a payload large enough that the receiver's `readBlob` allocated a fresh ashmem region. Independent kernel pages. |

### Ambiguous from `mId` + `mSourceId` alone

| receiver_storage | source_id | sender_storage | Why ambiguous |
|---|---|---|---|
| `ashmem` | non-NULL | `ashmem` | Path A vs Path B depends on the sender's `isImmutable()` at `writeToParcel` time (`jni/Bitmap.cpp:1050`), which the receiver's heap dump doesn't preserve. Default heuristic: assume Path A (kernel-shared, not doubled) — most ashmem-backed Bitmaps are immutable in practice. Mutable ashmem senders are rare; when they fire, this row will be mis-classified as kernel-shared when it's actually doubled. |
| `hardware` | * | * | `AHardwareBuffer*` handle identity isn't encoded in `mId` or `mSourceId`. Two `hardware` Bitmaps with the same content hash could (a) wrap the same buffer handle — no GPU memory duplication — or (b) wrap different buffers holding identical pixels — full GPU duplication. Distinguishing requires walking `Bitmap.mHardwareBuffer.handle.id` via `heap_graph_reference` (future CL). |
| `wrapped_pixel_ref` | * | * | `SkPixelRef*` identity is C++-side only, not visible in `heap_graph_primitive`. |

The stdlib SQL header captures this matrix verbatim as a
DEDUP-VERDICT QUICK REFERENCE so analysts querying the table see it
without needing to find this doc.

---

## 9. AOSP source files indexed for this research

Every claim in §1-8 is backed by one or more of these files. Line
ranges are the spans read in detail.

| File | Lines | What was extracted |
|---|---|---|
| `frameworks/base/graphics/java/android/graphics/Bitmap.java` | 1-260, 999-1010, 1600-1700, 1690-1770, 2160-2200, 2440-2500, 2660-2710 | mId/mSourceId/mNativePtr declarations; constructor flow; nativeGetSourceId/setSourceId JNI bindings; writeToParcel/createFromParcel Java side; DumpData class + dumpAll string and proto variants; sAllBitmaps WeakHashMap; createBitmap hardware-source path |
| `frameworks/base/graphics/java/android/os/Debug.java` | 2155-2202 | dumpHprofData with/without bitmapFormat — the only Bitmap.dumpAll caller for HPROFs |
| `frameworks/base/core/java/android/app/ActivityThread.java` | 4080-4101 | dumpBitmapsProto proto-stream caller of Bitmap.dumpAll(proto, ...) |
| `frameworks/base/libs/hwui/hwui/Bitmap.h` | 39-44, 87-120, 250-260 | PixelStorageType enum; getId / getSourceId / setSourceId accessors; mId / mSourceId field declarations |
| `frameworks/base/libs/hwui/hwui/Bitmap.cpp` | 115-208, 230-260, 320-405, 453-462, 637-720 | getId encoding; allocateAshmemBitmap; allocateHeapBitmap; createFrom variants for SkPixelRef and AHardwareBuffer; constructor bodies for each PixelStorageType; destructor; getSkBitmap (the GPU-readback branch); compress encoder dispatch |
| `frameworks/base/libs/hwui/jni/Bitmap.cpp` | 285-300, 600-620, 855-980, 1005-1085, 1310-1330, 1400-1415, 1440-1475 | createBitmap JNI helper; Bitmap_compress entry; Bitmap_createFromParcel + Bitmap_writeToParcel full bodies; Bitmap_copyPreserveInternalConfig (one of the WrappedPixelRef call sites); Bitmap_getSourceId / Bitmap_setSourceId; JNI methodTable |
| `frameworks/base/libs/hwui/jni/Movie.cpp` | 75-80 | Movie-frame WrappedPixelRef call site |
| `frameworks/base/libs/hwui/apex/android_bitmap.cpp` | 340-395 | NDK AImageDecoder WrappedPixelRef call sites |

Plus perfetto-side files for the schema and existing-stdlib context:

| File | Lines | What was extracted |
|---|---|---|
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/prelude/after_eof/memory.sql` (upstream tree) | 100-220 | heap_graph_object, heap_graph_object_data, heap_graph_primitive, heap_graph_reference view definitions; the comment at 107-110 that heap_graph_object_data is HPROF-only |
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/android/memory/heap_graph/heap_graph_class_aggregation.sql` | 1-176 | Existing class-aggregation pattern; reference for stdlib style |
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/android/freezer.sql` (upstream) | 22-54 | `_pid_to_upid(pid, ts)` reference implementation that the new module clones |
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/prelude/after_eof/casts.sql` | 1-44 | cast_int! / cast_string! / cast_double! macros |
| `ui/src/plugins/com.android.HeapDumpExplorer/queries.ts` (upstream) | 180-240, 1430-1560, 1790-1900 | Existing bitmap-list SQL; array_data_hash lookup; BitmapDumpData traversal |
| `ui/src/plugins/com.android.HeapDumpExplorer/views/bitmap_gallery_view.ts` | 1-565 | Existing UI surface that this CL extends with Storage / Source / Bitmap ID columns |

---

## 10. Cuttlefish-captured evidence (recorded 2026-05-10)

Three fresh `am dumpheap` HPROFs from this machine's cuttlefish
(Baklava build `BP4A.251205.006`). All three lack pixel content
because `am dumpheap` doesn't invoke `Bitmap.dumpAll` (§6.3), but
the new `Storage` / `Source` / `Bitmap ID` columns (sourced from
`heap_graph_primitive`) all populate correctly.

* `/tmp/cf-systemui.hprof` (100 MB) — pid 2800, com.android.systemui.
  12 Bitmaps:

  ```
  bitmap_id      w   h   density  source_id  recycled
  28001000001   106 118  320     -1         0     <- pid 2800, storage=heap
  28001000002    11  13  320     -1         0
  ...
  28003000008    64  64  320     -1         0     <- pid 2800, storage=hardware
  28003000010    64  64  320     -1         0     <- pid 2800, storage=hardware
  ```

  Two storage types (heap=1, hardware=3) decode correctly per
  `Bitmap.cpp:122-127`. All `mSourceId == -1`: SystemUI's Bitmaps
  are all locally allocated.

* `/tmp/cf-launcher.hprof` (51 MB) — pid 3214, com.android.launcher3.
  ~40 Bitmaps, dominated by 108×108 icons; mix of heap and hardware
  storage. All `mSourceId == -1`. Many byte-identical icons — the
  case where the existing content-hash dedup is informative and
  the new columns refine it.

* `/tmp/cf-systemserver.hprof` (85 MB) — pid 943, system_server. One
  Bitmap with non-trivial `mSourceId`:

  ```
  bitmap_id    source_id    w   h   recycled
  9432000084   29922000089  38  48  0
  ```

  Decoded:
  * `bitmap_id = 9432000084` → pid 943 (system_server),
    storage=`ashmem`, counter 84.
  * `source_id = 29922000089` → pid 2992 (com.android.phone, radio
    uid), storage=`ashmem`, counter 89.

  Path-A receive: `com.android.phone` sent an immutable
  ashmem-backed Bitmap; system_server's receiver mmap'd the same
  fd; kernel pages shared. Per the §8 matrix and the heuristic in
  §5.4, this row is "kernel-shared, not doubled." Without
  `source_id` and `source_storage_type` the analyst would see
  "ashmem Bitmap, 7,395 bytes native_size" and have no way to know
  the bytes are PSS-attributed proportionally to two processes.

In the HDE UI this row renders as `Storage: ashmem`, `Source: ?
(2992, ashmem)` — the `?` because HPROF-only files don't contain a
`process` table and so the stdlib's `source_process_name` resolver
gives back NULL. A combined trace (HPROF + `linux.process_stats`)
resolves the name to `com.android.phone`.

The `mSourceId != -1` case was rare in practice — one Bitmap out of
~50 across three system processes — but it's exactly the case
where the new columns add information that nothing else exposes.

---

## 11. What this CL ships

The stdlib module is shipped separately by upstream PR
[#5824](https://github.com/google/perfetto/pull/5824)
(`android.memory.heap_graph.bitmap`, table `heap_graph_bitmaps`).
This branch carries PR #5824's contents as a single base commit so
the UI consumer can land independently; the only UI-facing
dependencies on the stdlib are the module path, the table name, and
the column schema documented in §1-8 above.

UI consumer changes:

* **`ui/src/plugins/com.android.HeapDumpExplorer/queries.ts`** —
  `getBitmapList` `INCLUDE`s `android.memory.heap_graph.bitmap` and
  joins `heap_graph_bitmaps` to pick up the decoded provenance
  columns. `mNativePtr` is still pivoted inline from
  `heap_graph_primitive` because the stdlib doesn't expose it and
  the `BitmapDumpData` lookup needs it.

* **`ui/src/plugins/com.android.HeapDumpExplorer/types.ts`** —
  `BitmapListRow` extended with `storageType`, `bitmapId`,
  `sourceId`, `sourcePid`, `sourceStorageType`, `sourceProcessName`.

* **`ui/src/plugins/com.android.HeapDumpExplorer/views/bitmap_gallery_view.ts`** —
  data grid gains `Storage`, `Source`, `Bitmap ID` columns using the
  canonical `colHeader` + `COL_INFO` pattern; the bitmap card
  secondary line shows storage + "from <sender>" annotation when
  the source is set.

* **`ui/src/plugins/com.android.HeapDumpExplorer/components.ts`** —
  three new entries in `COL_INFO` for the column tooltips
  (`bitmapStorage`, `bitmapId`, `bitmapSource`).

* **This file** — the research write-up.

Scope: fork-side only. The AOSP `external/perfetto` tree's HPROF
parser doesn't populate `heap_graph_primitive` and lacks the HDE
plugin, so neither change applies there. Trace processor C++ is
untouched; this is pure stdlib SQL + TypeScript.
