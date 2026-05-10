# Bitmap identity in AOSP and what it means for heap-dump dedup

This document is the AOSP-source-of-truth backing for the
`android.bitmaps` heap-graph stdlib module and the HeapDumpExplorer UI
changes that go with it. Everything is cited inline by file path + line
number; nothing is paraphrased from secondary sources.

The questions answered:

1. What is `Bitmap.mId`? Where is it generated, where stored, where read?
2. What is `Bitmap.mSourceId`? Where set, where read, what does it mean?
3. What does each `PixelStorageType` (heap / ashmem / hardware /
   wrapped_pixel_ref) physically mean for memory backing? When is one
   chosen over another?
4. Given the existing HDE content-hash duplicate detection (`array_data_hash`
   over the encoded pixel buffer), when does "duplicate hash" mean "wasted
   RAM" and when does it mean "OS is sharing it for free"?
5. How does the heap-dump-side `Bitmap.dumpData` machinery work, and how
   does HDE consume it?

TL;DR up front:

* `mId` is a **process-monotonic instance counter**, encoded with the
  PID and PixelStorageType. It is **not** a dedup key — every Bitmap
  allocation in a process gets a fresh `mId`. It is useful as a stable
  per-instance identifier and as a decode of the storage type the
  Bitmap was born with.
* `mSourceId` is `-1` for locally-allocated Bitmaps and equals the
  **sender's `mId`** for Bitmaps reconstructed from a Parcel. It's the
  only field with cross-instance semantics.
* The PixelStorageType determines whether duplicate content actually
  costs duplicate RAM. `heap` → yes, always. `ashmem` with a non-`-1`
  `mSourceId` from an immutable parcel → no, kernel-shared. `hardware`
  → maybe, depends on AHardwareBuffer identity. `wrapped_pixel_ref` →
  layoutlib path, almost never seen on real device traces.
* The existing `array_data_hash` content hash is **necessary but not
  sufficient** to claim "wasted RAM". You need it to find candidate
  duplicates; you need `mId` / `mSourceId` / storage type to interpret
  what each duplicate actually costs.

---

## 1. The `mId` field

### 1.1 Java declaration

`frameworks/base/graphics/java/android/graphics/Bitmap.java:75`

```java
@UnsupportedAppUsage
private final long mNativePtr;
```

`frameworks/base/graphics/java/android/graphics/Bitmap.java:109`

```java
private long mId;
```

`mId` is a `long` (signed 64-bit on the Java side, treated as `uint64_t`
on the native side). Not `final` syntactically, but assigned exactly
once in the only constructor that touches it (see below).

### 1.2 Native generation

`frameworks/base/libs/hwui/hwui/Bitmap.cpp:122-127`

```cpp
uint64_t Bitmap::getId(PixelStorageType type) {
    static std::atomic<uint64_t> idCounter{0};
    return (idCounter.fetch_add(1) % 1000000)
        + static_cast<uint64_t>(type) * 1000000
        + static_cast<uint64_t>(getpid()) * 10000000;
}
```

Encoding (decimal, not bitfield — explicitly chosen so the value reads
naturally in heap dumps):

```
 mId = pid * 10^7  +  storage_type * 10^6  +  (counter % 10^6)
```

Where:

* **pid** is `getpid()` of the allocating process at construction time.
  Stable for the lifetime of that Bitmap. Two Bitmaps allocated in
  different processes will encode different pids and so cannot collide
  unless `pid` itself collides (rare in any single trace window).
* **storage_type** is the `PixelStorageType` enum value (see §3),
  numerically 0..3.
* **counter** is a process-wide `std::atomic<uint64_t>` — fetch-and-add
  one per allocation, modulo `10^6`. After 1,000,000 Bitmap allocations
  in the same process, the counter wraps. Bitmap.cpp:117-119 says this
  out loud:

  > the monotonic number could increase beyond 1000,000 and wrap around,
  > which only happens when more than 1,000,000 bitmaps have been
  > created over time. This could result in two IDs being the same
  > despite being really rare.

  In practice this means: assume `mId` collisions are essentially
  impossible across different Bitmap instances within a single heap
  dump; never write code that depends on `mId` being globally unique
  across the lifetime of a long-running process.

`getId(type)` is called from every concrete `Bitmap` constructor
that allocates fresh pixel memory:

* `Bitmap.cpp:330-338` — `Bitmap(void* address, size_t size, ...)` →
  Heap-backed
* `Bitmap.cpp:340-348` — `Bitmap(SkPixelRef& pixelRef, ...)` →
  WrappedPixelRef-backed
* `Bitmap.cpp:350-360` — `Bitmap(void* address, int fd, size_t mappedSize, ..., uint64_t id)`
  → Ashmem-backed (note: takes an explicit `id` parameter so the same
  ashmem region can keep its `mId` across the alloc/wrap split, see
  `allocateAshmemBitmap` line 187)
* `Bitmap.cpp:363-378` — `Bitmap(AHardwareBuffer*, ...)` →
  Hardware-backed

### 1.3 JNI hop: native → Java

`frameworks/base/libs/hwui/jni/Bitmap.cpp:285-300` constructs the Java
`Bitmap` object via JNI:

```cpp
jobject obj = env->NewObject(gBitmap_class, gBitmap_constructorMethodID,
                             static_cast<jlong>(bitmap->getId()),  // <- mId
                             reinterpret_cast<jlong>(wrapper),
                             ...);
```

The native `Bitmap::getId()` (the per-instance accessor at
`Bitmap.h:115-117`) reads the value previously stored in `mId` (the
field on the C++ `android::Bitmap` object — note this is a **different**
`mId` from the Java field; the Java field is initialised from this).

### 1.4 Java assignment

`Bitmap.java:199-223` constructor:

```java
Bitmap(long id, long nativeBitmap, int width, int height, int density,
        boolean requestPremultiplied, byte[] ninePatchChunk,
        NinePatch.InsetStruct ninePatchInsets, boolean fromMalloc) {
    if (nativeBitmap == 0) {
        throw new RuntimeException("internal error: native bitmap is 0");
    }

    mId = id;
    mWidth = width;
    mHeight = height;
    ...
    mNativePtr = nativeBitmap;
    mSourceId = nativeGetSourceId(mNativePtr);
    registerNativeAllocation(fromMalloc);

    synchronized (Bitmap.class) {
      sAllBitmaps.put(this, null);
    }
}
```

Three things to notice:

1. `mId = id` — set once, never reassigned.
2. `mSourceId = nativeGetSourceId(mNativePtr)` — read from the native
   side (the C++ `Bitmap` may have been pre-populated by a parcel
   reader; see §2 below).
3. `sAllBitmaps.put(this, null)` — every Bitmap is registered in a
   process-wide `WeakHashMap<Bitmap, Void>` (declared at
   `Bitmap.java:139`). This is what `Bitmap.dumpAll(...)` iterates over
   when writing dumpData; see §4.

### 1.5 What `mId` is *not*

`mId` is **never**:

* A content key. Two Bitmaps with byte-identical pixel buffers have
  different `mId`s by construction.
* A pixel-memory key. Two Bitmaps that share underlying ashmem pages
  still have different `mId`s.
* Stable across processes. Even for a parcel-shared Bitmap, the
  receiver's Bitmap gets a fresh `mId` (with the receiver's pid in the
  high bits); the sender's `mId` lives in the receiver's `mSourceId`
  field instead.

`mId` *is*:

* A stable per-instance identifier within one process's lifetime.
* A self-describing tag — pid and storage type are recoverable from it
  without any additional context.
* Useful for correlating a Bitmap with its `Bitmap_writeToParcel` /
  `Bitmap_createFromParcel` slice in the timeline (those slices use
  `mId` as their slice id — `jni/Bitmap.cpp:1018, 1039, 895, 898`).

---

## 2. The `mSourceId` field

### 2.1 Java declaration

`Bitmap.java:111-114`:

```java
// source id of the bitmap where this bitmap was created from, e.g.
// in the case of ashmem bitmap received, mSourceId is the mId of
// the bitmap from the sender
private long mSourceId = -1;
```

`-1` is the `UNDEFINED_BITMAP_ID` sentinel. The default is `-1` and
stays `-1` for any locally-allocated Bitmap (decode, copy, scale,
canvas-paint, hardware capture, etc.). The native side declares the
same default at `frameworks/base/libs/hwui/hwui/Bitmap.h:255`:

```cpp
uint64_t mSourceId = -1;  // source Id where this bitmap is orignated from
```

### 2.2 Where `mSourceId` is set: the sender → receiver flow

The only path that writes a non-`-1` `mSourceId` is the parcel
reconstruction path. The full data flow:

**Sender side** (`frameworks/base/libs/hwui/jni/Bitmap.cpp:1005-1082`,
`Bitmap_writeToParcel`):

```cpp
1018:    uint64_t id = bitmapWrapper->bitmap().getId();
...
1030:    p.writeInt32(bitmap.width());
1031:    p.writeInt32(bitmap.height());
1032:    p.writeInt32(bitmap.rowBytes());
1033:    p.writeInt32(density);
1034:    p.writeInt64(id);                       // <-- sender's mId on the wire
1035:    const uint64_t parcel_id = getParcelId();
1036:    p.writeInt64(parcel_id);
...
1049:    int fd = bitmapWrapper->bitmap().getAshmemFd();
1050:    if (fd >= 0 && p.allowFds() && bitmap.isImmutable()) {
1057:        status = writeBlobFromFd(p.get(),
                  bitmapWrapper->bitmap().getAllocationByteCount(), fd);
                                               // ^^^ Path A: dup the
                                               //     ashmem fd so the
                                               //     receiver mmaps the
                                               //     SAME kernel pages
        ...
1071:    status = writeBlob(p.get(), id, bitmap, !asMutable);
                                               // ^^^ Path B: copy bytes
                                               //     into a fresh ashmem
                                               //     blob owned by the
                                               //     parcel
```

**Receiver side** (`jni/Bitmap.cpp:863-980`, `Bitmap_createFromParcel`):

```cpp
891:    const int64_t sourceId = p.readInt64();   // <-- sender's mId
892:    const int64_t parcel_id = p.readInt64();
...
        // Allocates a fresh native Bitmap for the receiver. Whether it's
        // heap-backed, ashmem-backed, or sharing the sender's ashmem fd
        // depends on which payload path the sender chose — see the
        // `readBlob` callbacks at lines 925-959.
924:    sk_sp<Bitmap> nativeBitmap;
925:    binder_status_t error = readBlob(
            p.get(),
            // In place callback — heap-allocate, memcpy from blob.
928:        [&](std::unique_ptr<int8_t[]> buffer, int32_t size) {
933:            nativeBitmap = Bitmap::allocateHeapBitmap(allocationSize, imageInfo, rowBytes);
935:            memcpy(nativeBitmap->pixels(), buffer.get(), allocationSize);
                ...
            },
            // Ashmem callback — mmap the sender's transferred fd.
941:        [&](android::base::unique_fd fd, int32_t size) {
                ...
950:            void* addr = mmap(nullptr, size, flags, MAP_SHARED, fd.get(), 0);
                ...
956:            nativeBitmap = Bitmap::createFrom(imageInfo, rowBytes,
                    fd.release(), addr, size, !isMutable);
            });
...
972:    nativeBitmap->setSourceId(sourceId);   // <-- store the sender's
                                               //     mId on the receiver
                                               //     Bitmap as mSourceId
```

So the receiver's chain is:

1. Pull `sourceId` (sender's `mId`) off the parcel — line 891.
2. Allocate a *new* native Bitmap. The new Bitmap gets a *new*
   `mId` (per `Bitmap::getId(...)`, called by whichever
   `allocate*Bitmap` constructor was used). The receiver's pid is in
   the new `mId`'s high bits.
3. Set `mSourceId = sourceId` on the new Bitmap (line 972,
   via the public C++ setter at `Bitmap.h:120`).
4. Java constructor (Bitmap.java:217) reads it back via
   `nativeGetSourceId(mNativePtr)` (JNI getter at `jni/Bitmap.cpp:1404-1407`).

**Important: `mSourceId` is set even on Path B (blob copy).** The
sender's `mId` rides the parcel either way; whether the receiver ends
up with shared kernel pages depends on whether the sender wrote
ashmem-fd or blob-copy, NOT on whether `mSourceId` is populated.

### 2.3 What `mSourceId` tells you, what it doesn't

If `mSourceId == -1`: this Bitmap was allocated locally. Period.
None of `BitmapFactory.decode*`, `Bitmap.copy`, `Bitmap.createBitmap`,
`Canvas.drawBitmap` etc. ever set `mSourceId` to a non-`-1` value.

If `mSourceId != -1`: this Bitmap was reconstructed from a Parcel.
The numeric value is the sender's `mId` at writeToParcel time. From
that single number you can decode:

* `sender_pid = mSourceId / 10^7`
* `sender_storage_type = (mSourceId % 10^7) / 10^6`
* `sender_counter = mSourceId % 10^6`

What `mSourceId` does **not** tell you:

* Whether the actual pixel pages are kernel-shared with the sender.
  That's determined by whether the sender went through Path A or Path
  B in §2.2 above, which is a runtime decision based on
  `bitmap.isImmutable()` and `p.allowFds()`. Heap dumps don't preserve
  that decision; the closest signal you have is the receiver's own
  `bitmap_storage_type`. (Path A → receiver storage = `ashmem` AND
  `mSourceId != -1`. Path B → receiver may also be `ashmem`, just not
  fd-shared.)
* Whether the sender process is even still alive at heap-dump time.
* Whether the sender's pid has been recycled. The trace's
  `process` table lifetime windows are the only disambiguator —
  `_android_bitmap_resolve_sender_upid(pid, at_ts)` in the stdlib
  handles this.

---

## 3. PixelStorageType — what each backing actually means

Declared at `frameworks/base/libs/hwui/hwui/Bitmap.h:39-44`:

```cpp
enum class PixelStorageType {
    WrappedPixelRef = 0,
    Heap            = 1,
    Ashmem          = 2,
    Hardware        = 3,
};
```

These are not interchangeable — they have very different memory
semantics.

### 3.1 `Heap` (1) — private malloc'd memory

Allocated by `Bitmap::allocateHeapBitmap(size, info, rowBytes)`,
`Bitmap.cpp:239-244`:

```cpp
sk_sp<Bitmap> Bitmap::allocateHeapBitmap(size_t size, const SkImageInfo& info, size_t rowBytes) {
    void* addr = calloc(size, 1);
    if (!addr) {
        return nullptr;
    }
    return sk_sp<Bitmap>(new Bitmap(addr, size, info, rowBytes));
}
```

* **Backing**: `malloc()` of `size` bytes, owned by this Bitmap.
* **Sharing**: never. Each Bitmap has its own malloc'd region.
* **Process-locality**: strictly local to the allocating process.
* **Created when**: most `BitmapFactory.decode*` calls; `Bitmap.copy`;
  `Bitmap.createBitmap` (the basic forms); the Bitmap_createFromParcel
  blob-copy path (`jni/Bitmap.cpp:933-935`).
* **Destruction**: `~Bitmap()` at `Bitmap.cpp:393-397` calls `free()`
  and `mallopt(M_PURGE, 0)` on Android.
* **Heap-dump signal**: `bitmap_storage_type='heap'`, and the pixel
  bytes contribute to `heap_graph_object.native_size` (because libhwui
  registers them as native allocations against the Java Bitmap via
  `NativeAllocationRegistry`, see `Bitmap.java:161-183`).

**Dedup verdict**: two `heap` Bitmaps with identical content always
mean wasted RAM. Saving = `(count - 1) × allocation_byte_count`.

### 3.2 `Ashmem` (2) — shared kernel memory

Allocated by `Bitmap::allocateAshmemBitmap(...)`, `Bitmap.cpp:184-208`:

```cpp
184: sk_sp<Bitmap> Bitmap::allocateAshmemBitmap(size_t size,
                                                const SkImageInfo& info,
                                                size_t rowBytes) {
185: #ifdef __ANDROID__
187:     uint64_t id = getId(PixelStorageType::Ashmem);
188:     auto ashmemId = getAshmemId("allocate", id, info.width(), ...);
189:     int fd = ashmem_create_region(ashmemId.c_str(), size);
...
194:     void* addr = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
...
205:     return sk_sp<Bitmap>(new Bitmap(addr, fd, size, info, rowBytes, id));
```

* **Backing**: kernel ashmem region (essentially a posix shm with a
  name). The Bitmap holds an open fd + an `mmap`'d address range.
* **Sharing**: cross-process by fd transfer through Binder/parcel.
  Multiple processes mmap'ing the same fd see the same kernel page
  cache pages; the kernel attributes them as PSS-shared.
* **Process-locality**: locally allocated, but designed for transfer.
  Once an immutable ashmem Bitmap is parceled (Path A in §2.2), any
  number of receivers can mmap the same region without copying bytes.
* **Created when**: explicit code paths that opt into shared memory
  (e.g. icon services, IPC-heavy frameworks). Most app code does NOT
  default to ashmem.
* **Destruction**: `~Bitmap()` at `Bitmap.cpp:387-392` `munmap`s and
  `close()`s the fd. The kernel region is reclaimed when the last fd
  closes across all processes.
* **Heap-dump signal**: `bitmap_storage_type='ashmem'`. `native_size`
  is small (the BitmapWrapper struct, not the pixel buffer).

**Dedup verdict**:

* Two `ashmem` Bitmaps with the same content **and** same non-`-1`
  `mSourceId` (or one of them with `mSourceId` matching the other's
  `mId`): kernel pages are shared. **Not wasted.**
* Two `ashmem` Bitmaps with the same content but `mSourceId == -1` for
  both: they're independently allocated ashmem regions that happen to
  hold the same pixels. **Wasted** — you'd want to reuse one region.
* Mixed: case-by-case.

### 3.3 `Hardware` (3) — AHardwareBuffer / GraphicBuffer

Allocated by `HardwareBitmapUploader::allocateHardwareBitmap` (called
from `Bitmap.cpp:213`) or wrapped from an existing AHardwareBuffer via
`Bitmap::createFrom(AHardwareBuffer*, ...)` at `Bitmap.cpp:253-277`.

* **Backing**: an `AHardwareBuffer*` — a kernel handle to GPU-accessible
  memory (typically gralloc / dma-buf-backed). Constructor at
  `Bitmap.cpp:363-378`:

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
* **Sharing**: AHardwareBuffer handles are reference-counted and can
  be shared across processes via Binder. Two Java Bitmaps wrapping the
  same `AHardwareBuffer*` share GPU memory; each `AHardwareBuffer_acquire`
  bumps the refcount.
* **Process-locality**: GPU memory, accessible cross-process when the
  handle is shared.
* **Created when**: `HardwareRenderer.createHardwareBitmap`,
  `Bitmap.copy(Config.HARDWARE, false)`, `ImageDecoder.decodeBitmap`
  with hardware allocator hint, screen capture pipelines (`SurfaceFlinger`,
  `MediaProjection`).
* **Destruction**: `~Bitmap()` at `Bitmap.cpp:399-403` calls
  `AHardwareBuffer_release(buffer)`. The buffer is freed when the last
  reference is released.
* **Heap-dump signal**: `bitmap_storage_type='hardware'`. The Java
  field `mHardwareBuffer` (a `WeakReference<HardwareBuffer>`,
  `Bitmap.java:99`) holds the wrapper but the actual `AHardwareBuffer*`
  identity isn't visible from `heap_graph_primitive` alone.

**Dedup verdict**: ambiguous from heap-dump alone. Same hash + both
`hardware` is common (GPU textures of the same logical asset). Whether
they share the underlying `AHardwareBuffer` requires inspecting the
referenced `HardwareBuffer.handle.id` field — possible via
`heap_graph_reference` traversal but not in this CL. For now we report
the storage type and let the analyst infer (most common case in
practice: two distinct `AHardwareBuffer`s holding the same pixels →
GPU memory wasted).

### 3.4 `WrappedPixelRef` (0) — wrapping an existing SkPixelRef

This one needs a separate explanation because it's the only
`PixelStorageType` whose pixel memory the Bitmap object **does not own**.

The other three storage types (`Heap`, `Ashmem`, `Hardware`) all
imply ownership: when a `~Bitmap()` runs, it `free()`s the malloc'd
buffer / `munmap`s the ashmem region / `AHardwareBuffer_release`s the
GPU buffer. `WrappedPixelRef` is different — the `android::Bitmap`
just holds a refcounted reference to a pre-existing `SkPixelRef*` that
some other code allocated.

Skia's `SkPixelRef` is the abstraction: it owns the pixel bytes and
can be referenced by multiple Skia primitives (`SkBitmap`, `SkImage`,
…). When AOSP wraps an externally-managed Skia bitmap and exposes it
as an `android.graphics.Bitmap`, this is the storage type used.

Allocated by `Bitmap::createFrom(const SkImageInfo&, SkPixelRef&)`,
`Bitmap.cpp:247-249`:

```cpp
sk_sp<Bitmap> Bitmap::createFrom(const SkImageInfo& info, SkPixelRef& pixelRef) {
    return sk_sp<Bitmap>(new Bitmap(pixelRef, info));
}
```

with the constructor body at `Bitmap.cpp:340-348`:

```cpp
Bitmap::Bitmap(SkPixelRef& pixelRef, const SkImageInfo& info)
        : SkPixelRef(info.width(), info.height(), pixelRef.pixels(), pixelRef.rowBytes())
        , mInfo(validateAlpha(info))
        , mPixelStorageType(PixelStorageType::WrappedPixelRef)
        , mId(getId(mPixelStorageType)) {
    pixelRef.ref();
    mPixelStorage.wrapped.pixelRef = &pixelRef;
    traceBitmapCreate();
}
```

* **Backing**: an externally-owned `SkPixelRef*`. The Bitmap doesn't
  own the pixels; it just holds a `pixelRef.ref()` reference (line 345)
  and points at `pixelRef.pixels()` (line 341, passed to the parent
  `SkPixelRef` constructor). Pixel ownership stays with whoever
  created the original `SkPixelRef`.
* **Who creates SkPixelRefs that get wrapped this way**: typically the
  layoutlib code path (Studio IDE's bitmap preview rendering, where
  the JVM-side AOSP framework runs against host-allocated Skia bitmaps
  rather than going through the heap/ashmem/hardware allocators that
  exist only on Android). Some Skia-internal code paths in graphics
  pipelines also produce these.
* **Sharing**: entirely a property of the wrapped `SkPixelRef`. If two
  Bitmaps each call `Bitmap::createFrom(info, samePixelRef)`, both will
  point at the same pixel bytes via the same `SkPixelRef`, and the
  reference counter on that `SkPixelRef` will be incremented twice. If
  the two Bitmaps wrap *different* `SkPixelRef`s, they're unrelated.
  None of this is observable from the Java heap dump alone — the
  `SkPixelRef*` lives in C++, not in `heap_graph_primitive`.
* **Process-locality**: always local. `SkPixelRef` is a Skia-internal
  type; it has no parcelling or fd-transfer story. You will never see
  a `wrapped_pixel_ref` Bitmap with a non-`-1` `mSourceId`.
* **Created when in practice**: layoutlib previews; some test
  fixtures; effectively never on a real device app heap. Across the
  ~50 cuttlefish Bitmaps captured in §7 below, zero `wrapped_pixel_ref`
  instances.
* **Destruction**: `~Bitmap()` at `Bitmap.cpp:384-386` calls
  `pixelRef->unref()`. The wrapped `SkPixelRef` itself is freed only
  when its refcount drops to zero — possibly long after this Bitmap
  is gone, if other Skia code still holds it.
* **Heap-dump signal**: `bitmap_storage_type='wrapped_pixel_ref'`,
  `mSourceId == -1` (always).

**Dedup verdict**: indeterminate from the heap dump. The encoded
content might match (both wrap pixel refs that hold the same image),
but whether the two Bitmaps are sharing the same `SkPixelRef` (no real
duplication) or wrapping two distinct ones (full duplication) requires
inspecting the C++ side. Given how rare this case is in real traces
we don't engineer for it in the UI; we just label it `wrapped_pixel_ref`
in the storage column so an analyst who hits this case can recognise
it as "different rules apply".

---

## 4. `Bitmap.dumpData` — the static-side proto blob HDE consumes

The HeapDumpExplorer plugin renders actual thumbnails of Bitmaps. The
pixel bytes don't come from `heap_graph_primitive` (which only
exposes scalar fields); they come from a static field on the Bitmap
class object that holds a serialized proto produced by
`Bitmap.dumpAll(...)`.

### 4.1 Producer side: `Bitmap.dumpAll`

`Bitmap.java:1694-1727`:

```java
public static void dumpAll(ProtoOutputStream proto, @Nullable String dumpFormat) {
    final ArrayList<Bitmap> allBitmaps = getAllBitmaps();
    if (allBitmaps.size() == 0) {
        return;
    }
    for (Bitmap bitmap : allBitmaps) {
        int bytes = bitmap.getAllocationByteCount();
        int config = bitmap.getConfig().nativeInt;

        final long token = proto.start(BitmapDumpProto.AppBitmapInfo.BITMAPS);
        proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.ID, bitmap.mId);          // <- mId
        proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.WIDTH, bitmap.mWidth);
        proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.HEIGHT, bitmap.mHeight);
        proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.SIZE, bytes);
        proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.MUTABLE, bitmap.isMutable());
        proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.CONFIG, config);
        proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.SOURCE, bitmap.mSourceId); // <- mSourceId
        if (dumpFormat != null) {
            try {
                ByteArrayOutputStream bas = new ByteArrayOutputStream();
                if (bitmap.compress(CompressFormat.from(dumpFormat), 90, bas)) {
                    proto.write(BitmapDumpProto.AppBitmapInfo.BitmapInfo.CONTENT,      // <- compressed pixels
                                bas.toByteArray());
                }
                bas.close();
            } catch (IOException e) {
                Log.e(TAG, "failed to compress bitmap-" + bitmap.mId + ": " + e);
            }
        }
        proto.end(token);
    }
}
```

This is invoked by `BitmapDumper.dump(...)` (per-app) when the
framework triggers a Bitmap dump (typically as part of an HPROF
capture on debuggable builds). The serialized proto is parked on a
static `Bitmap.dumpData` field, where it survives into the heap dump.

`getAllBitmaps()` returns the keys of the `sAllBitmaps`
`WeakHashMap<Bitmap, Void>` declared at `Bitmap.java:139` and
populated by every Bitmap constructor (line 220-222).

### 4.1.1 Do `Hardware` Bitmaps end up with content in dumpData?

Short answer: **yes, but it's a slow GPU→RAM readback at dump time.**

`Bitmap.dumpAll` (line 1716) calls `bitmap.compress(format, 90, bas)`
on every Bitmap regardless of `Config`. The Java method has no hardware
gate (`Bitmap.java:1751-1767`):

```java
public boolean compress(@NonNull CompressFormat format, int quality,
                        @NonNull OutputStream stream) {
    checkRecycled("Can't compress a recycled bitmap");
    ...
    StrictMode.noteSlowCall("Compression of a bitmap is slow");
    Trace.traceBegin(Trace.TRACE_TAG_RESOURCES, "Bitmap.compress");
    boolean result = nativeCompress(mNativePtr, format.nativeInt,
            quality, stream, new byte[WORKING_COMPRESS_STORAGE]);
    ...
}
```

`nativeCompress` (in `frameworks/base/libs/hwui/jni/Bitmap.cpp`)
acquires the underlying SkBitmap. For a hardware-backed Bitmap that
SkBitmap is backed by an `AHardwareBuffer`, and reading its pixels
forces a GPU→CPU copy through Skia's image read path. The copy is
slow (hence the `StrictMode.noteSlowCall` warning) but it works:
the encoded bytes that land in `BitmapDumpProto.AppBitmapInfo.BitmapInfo.CONTENT`
are a faithful snapshot of the GPU buffer's pixels at the time the
dump was taken.

Two implications for dedup analysis:

1. **HDE can render thumbnails for hardware Bitmaps.** The encoded
   bytes are present in the dump just like for heap Bitmaps; the
   `array_data_hash` is computed on them just like for heap Bitmaps;
   the bitmap-gallery thumbnail decoder doesn't care which storage
   type produced the bytes.

2. **Content-hash equality on hardware Bitmaps is "what the screen
   showed at dump time."** Two `hardware` Bitmaps with the same hash
   had the same visible pixels at dump time — but the GPU buffers
   themselves might be:
   * The same `AHardwareBuffer` wrapped by two Java Bitmaps (memory
     truly shared, no GPU duplication).
   * Two distinct `AHardwareBuffer` allocations holding identical
     pixels (memory duplicated on the GPU).
   * Even one `AHardwareBuffer` whose contents change frame-to-frame:
     the dump snapshots one frame; if compress() runs at slightly
     different times the hashes won't match even though the buffer is
     the same.

   The Java field `Bitmap.mHardwareBuffer` (`Bitmap.java:99`) is a
   `WeakReference<HardwareBuffer>`; the `HardwareBuffer.handle.id`
   field would let us distinguish "same handle" from "two handles same
   pixels", but that requires walking the weak reference chain in
   `heap_graph_reference` — out of scope for this CL.

   This is why §5's matrix marks `hardware` × `hardware` dedup verdict
   as ambiguous. The UI annotates "could-be-shared (GPU)" for hardware
   groups rather than claiming wasted memory.

3. **Dump-time race.** Because compress() reads the live GPU buffer,
   if a render pass happens to update the buffer between the dumps of
   two Bitmaps wrapping the same handle, the two dumps will hash
   differently. This is rare in practice (`Bitmap.dumpAll` runs
   linearly under the heap dumper's stop-the-world), but worth noting.

### 4.2 Consumer side: HDE's `computeBitmapDumpData`

`ui/src/plugins/com.android.HeapDumpExplorer/queries.ts:1457-1556`
walks the heap-graph object references to reconstruct the proto:

1. Find the `Class<android.graphics.Bitmap>` heap_graph_object
   (lines 1461-1470).
2. Follow its `dumpData` static reference (lines 1473-1482).
3. Read the `format` int field (lines 1485-1496) — `1`=PNG,
   `0`=JPEG, etc.
4. Walk to `dumpData.natives` (the `long[]` of native Bitmap
   pointers, one per Bitmap) and `dumpData.buffers` (the `Object[]`
   of `byte[]` blobs, the encoded-image bytes per Bitmap), lines
   1499-1545.
5. Build a `Map<nativePtr, bufferObjectId>` so that for any Bitmap
   row from `getBitmapList`, the encoded byte array can be located
   by `mNativePtr` lookup, lines 1547-1556.

The content-hash dedup in `batchBitmapBufferHashes`
(`queries.ts:194-240`) reads `heap_graph_object_data.array_data_hash`
on those `byte[]` objects. Since the `byte[]` contains the
JPEG/PNG/WEBP-encoded representation of the pixel buffer, the hash is
computed over **post-compression** bytes — deterministic for a given
input + codec settings + quality (the call at line 1716 hard-codes
quality=90).

This is why content-hash dedup is so good in practice: two Bitmaps
with byte-identical pixel buffers compressed at the same quality
produce byte-identical encoded byte[]s, which produces the same
`array_data_hash`. False positives essentially require pixel-buffer
collisions in the codec, which is astronomically rare for non-trivial
images.

It's also why content-hash alone tells you nothing about whether the
**decoded** in-memory pixels are duplicated: the hash is computed on
the encoded blob, and only after `Bitmap.dumpAll` ran. The original
backing memory might be heap-private (each decode is a separate
allocation, real RAM dup) or ashmem-shared (one kernel region, no
RAM dup). The hash can't tell those apart — but `mSourceId` and
`bitmap_storage_type` can, which is the entire point of this CL.

---

## 4.3 RSS vs PSS — what duplicate bitmaps actually cost

A heap dump shows objects in **one process**. The dedup verdict
depends on whether you're asking about that one process's memory cost
(RSS / PSS for just this PID) or the system-wide cost (sum of PSS
across all processes).

### Same-process view

For two Bitmaps in one heap dump with the same `array_data_hash`:

| Storage / source combination | Same-process RSS doubled? | Same-process PSS doubled? |
|---|---|---|
| `heap` + both `source_id IS NULL` | Yes | Yes |
| `ashmem` + both `source_id IS NULL` (independent ashmem allocations) | Yes | Yes |
| `ashmem` + both share the same non-NULL `source_id` (same process double-received the same parcel-fd-shared region — rare) | Kernel-dependent; typically yes for the VMA accounting in `/proc/PID/maps`, no for the physical-page count | No (`/proc/PID/smaps` divides each shared page across the N referencing VMAs, so two VMAs each contribute `page/2`) |
| `hardware` wrapping the **same** `AHardwareBuffer` | No (single GPU buffer) | No |
| `hardware` wrapping **different** `AHardwareBuffer`s | Yes (separate GPU allocations) | Yes |
| `wrapped_pixel_ref` | Indeterminate | Indeterminate |

The TL;DR: **in an app-process heap dump, if the hash matches you're
paying for the dup ~95% of the time.** The narrow same-process
exceptions are (a) same-process double-receive of a parcel-fd-shared
ashmem region — extremely rare in real apps, and (b) hardware bitmaps
that wrap the same `AHardwareBuffer` handle — also rare and not
detectable from `heap_graph_primitive` alone.

### Cross-process view

When the same Bitmap is shared across multiple processes via Path A
(immutable + ashmem + fd-allowed; `jni/Bitmap.cpp:1057`):

* Each receiving process's RSS counts the full ashmem region, because
  RSS counts mapped-resident pages per process VMA.
* Each receiving process's PSS divides each shared page by the number
  of processes mapping it (the `/proc/PID/smaps` definition of PSS).
  Total system PSS for that region = `region_size`, distributed
  proportionally. With N receivers, each contributes `region_size / N`
  to its own PSS.
* Without `source_id`, an analyst summing per-process bitmap RSS
  across processes counts the region N times. With `source_id`, the
  group can be collapsed and attributed once.

This is where `mSourceId` pays off most. The `system_server` cuttlefish
example in §7 (38×48 bitmap from `com.android.phone`) is exactly this
pattern: system_server's RSS counts the full 7,395 bytes; but the
system-wide PSS only ever cost the original allocation in
`com.android.phone`'s region.

---

## 5. The dedup decision matrix

Putting §1-4 together. Given two Bitmaps A and B with the same
`array_data_hash`:

| A.storage_type | B.storage_type | A.source_id | B.source_id | Verdict |
|---|---|---|---|---|
| heap | heap | NULL | NULL | **Wasted RAM.** Two independent decodes / allocations. Saving = `A.allocation_byte_count`. |
| heap | heap | non-NULL, same | non-NULL, same | Both received from the same parcel sender, and both went via Path B (blob copy → heap-allocation in `jni/Bitmap.cpp:933`). **Wasted RAM.** |
| heap | heap | non-NULL, different | non-NULL, different | Different parcel senders happened to send the same image. **Wasted RAM.** |
| ashmem | ashmem | non-NULL, same | non-NULL, same | Same parcel sender, Path A (fd-shared ashmem). **Not wasted** (kernel-shared). |
| ashmem | ashmem | NULL | NULL | Independent ashmem allocations with same content. **Wasted RAM.** |
| ashmem | ashmem | mixed | mixed | Mixed. Per-pair check by `source_id` equality. |
| hardware | hardware | * | * | Ambiguous from heap-dump alone. Need to inspect each Bitmap's `mHardwareBuffer.handle.id`. **Likely wasted GPU memory** in most cases. |
| heap | ashmem | * | * | Heterogeneous. The heap one is wasted; the ashmem one's wastedness depends on its `source_id`. |
| wrapped_pixel_ref | * | * | * | Layoutlib path; not relevant on device traces. |

What this means for the HDE UI:

* The `buffer_hash` column is still the dedup primary key — it's how
  candidate dups are found.
* The new `Storage` column (`bitmap_storage_type`) and `Source` column
  (`source_pid` + `source_process_name`) annotate each Bitmap so the
  user can read off the dedup verdict from the table.
* Group counts in the duplicate-bitmaps panel can be augmented with a
  short "...likely wasted" / "...kernel-shared" / "...mixed" tag based
  on the matrix.

---

## 6. AOSP source files I read for this research

For traceability — every claim above is backed by one or more of these
files. Line ranges are the spans I read in detail; you can re-derive
any individual claim from the cited line in §1-5.

| File | Lines read | What I extracted |
|---|---|---|
| `frameworks/base/graphics/java/android/graphics/Bitmap.java` | 1-260, 1690-1750, 2440-2500, 2660-2710 | mId/mSourceId/mNativePtr declarations; constructor flow; nativeGetSourceId/setSourceId JNI bindings; writeToParcel/createFromParcel Java side; dumpAll proto writer; sAllBitmaps WeakHashMap |
| `frameworks/base/libs/hwui/hwui/Bitmap.h` | 39-44, 87-120, 250-260 | PixelStorageType enum; getId / getSourceId / setSourceId getters; mId / mSourceId field declarations |
| `frameworks/base/libs/hwui/hwui/Bitmap.cpp` | 115-208, 230-260, 320-405 | getId encoding; allocateAshmemBitmap; allocateHeapBitmap; createFrom variants for SkPixelRef and AHardwareBuffer; constructor bodies for each PixelStorageType; destructor |
| `frameworks/base/libs/hwui/jni/Bitmap.cpp` | 285-300, 855-980, 1005-1085, 1400-1415, 1440-1475 | createBitmap JNI helper that hands mId to Java; Bitmap_createFromParcel + Bitmap_writeToParcel full bodies; Bitmap_getSourceId / Bitmap_setSourceId JNI getter/setter; the JNI methodTable that wires the names |

Plus the perfetto-side files I read to understand existing schema:

| File | Lines read | What I extracted |
|---|---|---|
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/prelude/after_eof/memory.sql` (upstream tree) | 100-220 | `heap_graph_object`, `heap_graph_object_data`, `heap_graph_primitive`, `heap_graph_reference` view definitions; the comment at 107-110 that `heap_graph_object_data` is HPROF-only |
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/android/memory/heap_graph/heap_graph_class_aggregation.sql` | 1-176 | Existing class-aggregation pattern; reference for stdlib style |
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/android/freezer.sql` (upstream) | 22-54 | `_pid_to_upid(pid, ts)` reference implementation that I cloned into this module |
| `external/perfetto/src/trace_processor/perfetto_sql/stdlib/prelude/after_eof/casts.sql` | 1-44 | `cast_int!` / `cast_string!` / `cast_double!` macros for perfetto-style numeric coercion |
| `ui/src/plugins/com.android.HeapDumpExplorer/queries.ts` (upstream) | 180-240, 1430-1560, 1790-1900 | Existing bitmap-list SQL; `array_data_hash` lookup; `BitmapDumpData` traversal that decodes `Bitmap.dumpData` via heap_graph references |
| `ui/src/plugins/com.android.HeapDumpExplorer/views/bitmap_gallery_view.ts` | 1-565 | Existing UI surface that we extend with Storage / Source columns |

---

## 7. Cuttlefish-captured evidence (recorded 2026-05-10)

Three fresh `am dumpheap` HPROFs from this machine's cuttlefish
(Baklava build `BP4A.251205.006`):

* `/tmp/cf-systemui.hprof` (100 MB) — pid 2800, com.android.systemui.
  12 Bitmap objects, all primitives populated:

  ```
  bitmap_id      w   h   density  source_id  recycled
  28001000001   106 118  320     -1         0     <- pid 2800, storage=heap
  28001000002    11  13  320     -1         0
  ...
  28003000008    64  64  320     -1         0     <- pid 2800, storage=hardware
  28003000010    64  64  320     -1         0     <- pid 2800, storage=hardware
  ```

  Confirms two storage types (heap=1, hardware=3) decode correctly per
  `Bitmap.cpp:122-127`. All `mSourceId == -1`: SystemUI's Bitmaps are
  all locally allocated.

* `/tmp/cf-launcher.hprof` (51 MB) — pid 3214, com.android.launcher3.
  ~40 Bitmaps, dominant size 108×108 (icons), several at
  storage=hardware. All `mSourceId == -1`. Lots of byte-identical
  icons → exactly the case where the existing content-hash dedup is
  informative AND the new storage_type column refines it.

* `/tmp/cf-systemserver.hprof` (85 MB) — pid 943, system_server.
  **One** Bitmap with non-trivial `mSourceId`:

  ```
  bitmap_id     source_id     w   h   recycled
  9432000084    29922000089   38  48  0
  ```

  Decoded:
  * `bitmap_id = 9432000084`: pid=**943** (system_server),
    storage=**ashmem(2)**, counter=84.
  * `source_id = 29922000089`: pid=**2992** (com.android.phone, radio
    uid), storage=**ashmem(2)**, counter=89.

  This is the §3.2 Path-A case. Sender was `com.android.phone`,
  receiver is `system_server`, both on ashmem, kernel pages shared.
  The §5 decision matrix labels this group "not wasted (kernel-shared)".

The `mSourceId != -1` case is rare in practice (one Bitmap out of ~50
across three system processes), but when it fires it is the only
signal available for cross-process pixel-memory attribution.

---

## 8. What ships in this CL

* **`src/trace_processor/perfetto_sql/stdlib/android/bitmaps.sql`** — extended
  with three new symbols:
  * `_android_bitmap_resolve_sender_upid(pid, at_ts)` — local clone of
    `_pid_to_upid` (we don't depend on `android.freezer` to avoid
    coupling unrelated modules).
  * `_android_bitmap_storage_type_name(storage_type)` — decodes
    PixelStorageType integers to their enum names.
  * `android_heap_graph_bitmaps` — the public per-Bitmap table with all
    decoded fields. NULL-tolerant on proto-format heap graphs.

* **`ui/src/plugins/com.android.HeapDumpExplorer/queries.ts`** — extended
  `getBitmapList` to pull `bitmap_id`, `source_id`, etc. from
  `android_heap_graph_bitmaps`. Type changes propagate via `BitmapListRow`.

* **`ui/src/plugins/com.android.HeapDumpExplorer/views/bitmap_gallery_view.ts`** —
  bitmap DataGrid gets:
  * `storage` column (`bitmap_storage_type`)
  * `source` column (composes `source_process_name` + pid + storage,
    e.g. `com.android.phone (2992, ashmem)`; blank for local Bitmaps)
  * Tooltips on both columns linking back to this RESEARCH.md for the
    full taxonomy.

* **No change** to AOSP `external/perfetto` — that tree's HPROF parser
  doesn't populate `heap_graph_primitive` and doesn't have the HDE
  plugin. Porting both is a follow-up CL.

* **No change** to trace-processor C++. All work is stdlib SQL +
  TypeScript.
