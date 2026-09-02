/*
 * Copyright (C) 2025 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#ifndef SRC_TRACE_PROCESSOR_IMPORTERS_ART_HPROF_ART_HPROF_MODEL_H_
#define SRC_TRACE_PROCESSOR_IMPORTERS_ART_HPROF_ART_HPROF_MODEL_H_

#include "src/trace_processor/importers/art_hprof/art_hprof_types.h"
#include "src/trace_processor/storage/trace_storage.h"

#include "perfetto/ext/base/flat_hash_map.h"
#include "perfetto/ext/base/no_destructor.h"
#include "perfetto/trace_processor/trace_blob_view.h"

#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <variant>
#include <vector>

namespace perfetto::trace_processor::art_hprof {

// Field class with value storage using std::variant
class Field {
 public:
  using ValueType = std::variant<std::monostate,  // For no value
                                 bool,            // BOOLEAN
                                 uint8_t,         // BYTE
                                 uint16_t,        // CHAR
                                 int16_t,         // SHORT
                                 int32_t,         // INT
                                 int64_t,         // LONG
                                 float,           // FLOAT
                                 double,          // DOUBLE
                                 uint64_t         // OBJECT (reference ID)
                                 >;

  Field(StringId name, FieldType type) : name_(name), type_(type) {}

  template <typename T>
  Field(StringId name, FieldType type, T value)
      : name_(name), type_(type), value_(value) {}

  Field(const Field&) = default;
  Field& operator=(const Field&) = default;
  Field(Field&&) = default;
  Field& operator=(Field&&) = default;
  ~Field() = default;

  StringId GetName() const { return name_; }
  FieldType GetType() const { return type_; }
  bool HasValue() const {
    return !std::holds_alternative<std::monostate>(value_);
  }

  // Template setter for all supported types
  template <typename T>
  void SetValue(T value) {
    value_ = value;
  }

  // Type-safe getter template
  template <typename T>
  std::optional<T> GetValue() const {
    if (const T* ptr = std::get_if<T>(&value_)) {
      return *ptr;
    }
    return std::nullopt;
  }

  // Get numeric value as int64_t (useful for sizes)
  int64_t GetNumericValue() const {
    return std::visit(
        [](auto&& val) -> int64_t {
          using T = std::decay_t<decltype(val)>;
          if constexpr (std::is_same_v<T, std::monostate>)
            return 0;
          else if constexpr (std::is_same_v<T, bool>)
            return val ? 1 : 0;
          else
            return static_cast<int64_t>(val);
        },
        value_);
  }

 private:
  StringId name_;
  FieldType type_;
  ValueType value_ = std::monostate{};
};

// Index of an object in the ObjectStore. Kept as a 32 bit index rather than
// an hprof object id so that following a reference is an array lookup instead
// of a hash map probe.
using ObjectIndex = uint32_t;
constexpr ObjectIndex kInvalidObjectIndex =
    std::numeric_limits<ObjectIndex>::max();

struct Reference {
  StringId field_name;
  // Index of the referred-to object, or kInvalidObjectIndex if the target is
  // not present in the dump.
  ObjectIndex target_index;
  // Referent of a weak/phantom/finalizer reference: not followed when
  // computing reachability.
  bool is_weak_referent;

  Reference(StringId name, ObjectIndex target, bool weak_referent = false)
      : field_name(name),
        target_index(target),
        is_weak_referent(weak_referent) {}
};

// A static field reference seen while parsing, before the objects it points at
// have been read.
struct PendingReference {
  StringId field_name;
  uint64_t target_id;

  PendingReference(StringId name, uint64_t target)
      : field_name(name), target_id(target) {}
};

class ClassDefinition {
 public:
  ClassDefinition(uint64_t id, std::string name)
      : id_(id), name_(std::move(name)) {}

  ClassDefinition() = default;

  ClassDefinition(const ClassDefinition&) = default;
  ClassDefinition& operator=(const ClassDefinition&) = default;
  ClassDefinition(ClassDefinition&&) = default;
  ClassDefinition& operator=(ClassDefinition&&) = default;
  ~ClassDefinition() = default;

  uint64_t GetId() const { return id_; }
  const std::string& GetName() const { return name_; }
  uint64_t GetSuperClassId() const { return super_class_id_; }
  uint32_t GetInstanceSize() const { return instance_size_; }
  const std::vector<Field>& GetInstanceFields() const {
    return instance_fields_;
  }

  void SetSuperClassId(uint64_t id) { super_class_id_ = id; }
  void SetInstanceSize(uint32_t size) { instance_size_ = size; }
  void SetInstanceFields(std::vector<Field> fields) {
    instance_fields_ = std::move(fields);
  }

  void AddInstanceField(Field field) {
    instance_fields_.push_back(std::move(field));
  }

 private:
  uint64_t id_ = 0;
  std::string name_;
  uint64_t super_class_id_ = 0;
  uint32_t instance_size_ = 0;
  std::vector<Field> instance_fields_;
};

// Payload that only class objects carry (static fields and their unresolved
// references), allocated lazily. Instances and arrays never allocate one:
// instances carry nothing extra, arrays keep their shape inline in the columns.
struct ObjectExtra {
  std::vector<Field> fields;
  std::vector<PendingReference> pending_references;
};

// Struct-of-arrays storage for every object in the dump. Replacing a vector of
// fat Object structs with one array per attribute removes the AoS padding and
// keeps the hot resolve/BFS passes touching only the columns they need. Objects
// are addressed by ObjectIndex (row); see the Object handle below.
struct ObjectColumns {
  std::vector<uint64_t> id;
  std::vector<uint64_t> class_id;
  std::vector<StringId> heap_type;
  // Instance field bytes / object-array element ids / primitive-array payload:
  // a view onto the (mmapped) trace, no copy on native builds.
  std::vector<TraceBlobView> raw_data;
  // CSR reference range into ObjectStore::edges_.
  std::vector<uint32_t> ref_begin;
  std::vector<uint32_t> ref_count;
  std::vector<uint32_t> array_element_count;
  std::vector<uint32_t> array_data_bytes;
  std::vector<int64_t> native_size;
  // Self size override, or -1 when unset.
  std::vector<int64_t> self_size;
  std::vector<int32_t> root_distance;
  std::vector<StringId> decoded_string;
  std::vector<ObjectType> type;
  std::vector<FieldType> array_element_type;
  // Root tag, valid only when the kRoot flag bit is set.
  std::vector<HprofHeapRootTag> root_type;
  std::vector<uint8_t> flags;
  // Non-null only for class objects.
  std::vector<std::unique_ptr<ObjectExtra>> extra;

  size_t size() const { return id.size(); }

  ObjectIndex Append(uint64_t oid, uint64_t cid, StringId heap, ObjectType t) {
    ObjectIndex i = static_cast<ObjectIndex>(id.size());
    id.push_back(oid);
    class_id.push_back(cid);
    heap_type.push_back(heap);
    raw_data.emplace_back();
    ref_begin.push_back(0);
    ref_count.push_back(0);
    array_element_count.push_back(0);
    array_data_bytes.push_back(0);
    native_size.push_back(0);
    self_size.push_back(-1);
    root_distance.push_back(-1);
    decoded_string.push_back(StringId::Null());
    type.push_back(t);
    array_element_type.push_back(FieldType::kObject);
    root_type.push_back(HprofHeapRootTag::kUnknown);
    flags.push_back(0);
    extra.emplace_back();
    return i;
  }

  void Clear() { *this = ObjectColumns(); }

  // Releases the scalar columns that are only read while populating the object
  // table (size/heap/root/reachability). Called once that table is written so
  // they are not resident while the large field-value tables are built.
  void ClearScalars() {
    self_size = std::vector<int64_t>();
    native_size = std::vector<int64_t>();
    root_distance = std::vector<int32_t>();
    heap_type = std::vector<StringId>();
    flags = std::vector<uint8_t>();
    root_type = std::vector<HprofHeapRootTag>();
  }
};

// Lightweight handle to one object's row in ObjectColumns. Cheap to copy (a
// pointer plus an index); owns nothing. Presents the same API the importer used
// when Object was a value type, so call sites are unchanged apart from binding
// it by value instead of by reference.
class Object {
 public:
  Object() = default;
  Object(ObjectColumns* cols, ObjectIndex idx) : cols_(cols), idx_(idx) {}

  bool valid() const { return cols_ != nullptr; }
  explicit operator bool() const { return cols_ != nullptr; }
  ObjectIndex index() const { return idx_; }

  uint64_t GetId() const { return cols_->id[idx_]; }
  uint64_t GetClassId() const { return cols_->class_id[idx_]; }
  StringId GetHeapType() const { return cols_->heap_type[idx_]; }
  ObjectType GetObjectType() const { return cols_->type[idx_]; }

  void SetId(uint64_t id) { cols_->id[idx_] = id; }
  void SetClassId(uint64_t id) { cols_->class_id[idx_] = id; }
  void SetObjectType(ObjectType t) { cols_->type[idx_] = t; }
  void SetHeapType(StringId heap) { cols_->heap_type[idx_] = heap; }

  void SetRootType(HprofHeapRootTag root_type) {
    cols_->root_type[idx_] = root_type;
    cols_->flags[idx_] |= kRoot;
  }
  void SetReachable() { cols_->flags[idx_] |= kReachable; }

  bool IsRoot() const { return (cols_->flags[idx_] & kRoot) != 0; }
  bool IsReachable() const { return (cols_->flags[idx_] & kReachable) != 0; }
  std::optional<HprofHeapRootTag> GetRootType() const {
    return IsRoot() ? std::make_optional(cols_->root_type[idx_]) : std::nullopt;
  }

  void SetRootDistance(int32_t d) { cols_->root_distance[idx_] = d; }
  int32_t GetRootDistance() const { return cols_->root_distance[idx_]; }

  // Instance data / object array element ids. This is a view onto the trace
  // bytes themselves: on native builds, where the trace is mmapped, no copy of
  // the data is ever made. Released when the graph is torn down.
  void SetRawData(TraceBlobView data) {
    cols_->raw_data[idx_] = std::move(data);
  }

  const uint8_t* GetRawData() const { return cols_->raw_data[idx_].data(); }
  size_t GetRawDataSize() const { return cols_->raw_data[idx_].size(); }
  const TraceBlobView& GetRawDataView() const { return cols_->raw_data[idx_]; }
  void ClearRawData() { cols_->raw_data[idx_] = TraceBlobView(); }

  void AddPendingReference(StringId field_name, uint64_t target_id) {
    EnsureExtra().pending_references.emplace_back(field_name, target_id);
  }
  const std::vector<PendingReference>& GetPendingReferences() const {
    const auto& e = cols_->extra[idx_];
    return e ? e->pending_references : EmptyPending();
  }

  // Array shape lives inline in the columns; the payload reuses raw_data_.
  void SetArrayElementCount(uint32_t count) {
    cols_->array_element_count[idx_] = count;
  }
  void SetArrayElementType(FieldType type) {
    cols_->array_element_type[idx_] = type;
  }
  void SetArrayDataBytes(uint32_t bytes) {
    cols_->array_data_bytes[idx_] = bytes;
  }
  uint32_t GetArrayDataBytes() const { return cols_->array_data_bytes[idx_]; }
  FieldType GetArrayElementType() const {
    return cols_->array_element_type[idx_];
  }

  void AddField(Field field) {
    EnsureExtra().fields.push_back(std::move(field));
  }
  void ReserveFields(size_t count) { EnsureExtra().fields.reserve(count); }
  const std::vector<Field>& GetFields() const {
    const auto& e = cols_->extra[idx_];
    return e ? e->fields : EmptyFields();
  }

  int64_t GetNativeSize() const { return cols_->native_size[idx_]; }
  void AddNativeSize(int64_t size) { cols_->native_size[idx_] += size; }

  void SetDecodedString(StringId str) { cols_->decoded_string[idx_] = str; }
  std::optional<StringId> GetDecodedString() const {
    StringId s = cols_->decoded_string[idx_];
    return s.is_null() ? std::nullopt : std::make_optional(s);
  }

  void SetSelfSizeOverride(size_t size) {
    cols_->self_size[idx_] = static_cast<int64_t>(size);
  }
  std::optional<size_t> GetSelfSizeOverride() const {
    int64_t s = cols_->self_size[idx_];
    return s < 0 ? std::nullopt : std::make_optional(static_cast<size_t>(s));
  }

  // Primitive array payload, decoded to native endianness at parse time. Reuses
  // the raw_data_ slot (a primitive array has no separate instance data), which
  // is never cleared for primitive arrays.
  void SetArrayData(TraceBlobView data, uint32_t element_count) {
    cols_->raw_data[idx_] = std::move(data);
    cols_->array_element_count[idx_] = element_count;
  }
  bool HasArrayData() const {
    return cols_->type[idx_] == ObjectType::kPrimitiveArray &&
           cols_->raw_data[idx_].size() > 0;
  }
  const TraceBlobView& GetArrayData() const { return cols_->raw_data[idx_]; }
  size_t GetArrayElementCount() const {
    return cols_->array_element_count[idx_];
  }

 private:
  static constexpr uint8_t kRoot = 1;
  static constexpr uint8_t kReachable = 2;

  ObjectExtra& EnsureExtra() {
    auto& e = cols_->extra[idx_];
    if (!e)
      e = std::make_unique<ObjectExtra>();
    return *e;
  }
  static const std::vector<Field>& EmptyFields() {
    static base::NoDestructor<std::vector<Field>> empty;
    return empty.ref();
  }
  static const std::vector<PendingReference>& EmptyPending() {
    static base::NoDestructor<std::vector<PendingReference>> empty;
    return empty.ref();
  }

  ObjectColumns* cols_ = nullptr;
  ObjectIndex idx_ = kInvalidObjectIndex;
};

// An object-typed field, at its fixed offset in the instance data.
struct ObjectFieldRef {
  StringId name;
  uint32_t offset;
  bool is_weak_referent;
};

// Fully qualified instance field layout of a class hierarchy. Computed once
// per class, never per object.
struct ClassFieldLayout {
  // All fields, in the order they appear in the instance data.
  std::vector<Field> fields;
  // Just the object-typed fields, with their offsets precomputed so that
  // reference extraction does not have to walk over the primitive ones.
  std::vector<ObjectFieldRef> object_fields;
};

using ClassFieldLayouts = base::FlatHashMap<uint64_t, ClassFieldLayout>;

// Stores all the objects in a dump column-wise, with a side map from hprof
// object id to row index. Object handles are cheap views over the columns.
class ObjectStore {
 public:
  Object Find(uint64_t id) {
    ObjectIndex* idx = index_.Find(id);
    return idx ? Object(&cols_, *idx) : Object();
  }

  Object Find(uint64_t id) const {
    const ObjectIndex* idx = index_.Find(id);
    return idx ? Object(const_cast<ObjectColumns*>(&cols_), *idx) : Object();
  }

  ObjectIndex FindIndex(uint64_t id) const {
    const ObjectIndex* idx = index_.Find(id);
    return idx ? *idx : kInvalidObjectIndex;
  }

  // Returns the object with `id`, appending a default row if it does not exist
  // yet. The caller sets the row's attributes through the returned handle.
  Object operator[](uint64_t id) {
    auto res = index_.Insert(id, static_cast<ObjectIndex>(cols_.size()));
    if (res.second) {
      cols_.Append(0, 0, StringId::Null(), ObjectType::kInstance);
    }
    return Object(&cols_, *res.first);
  }

  Object at(ObjectIndex index) { return Object(&cols_, index); }
  Object at(ObjectIndex index) const {
    return Object(const_cast<ObjectColumns*>(&cols_), index);
  }

  size_t size() const { return cols_.size(); }

  // Appends a new object row without touching the id index. Used during the
  // parse phase; the index is built once afterwards via BuildIndex(). This
  // avoids rehashing the id map as millions of objects are inserted.
  Object Append(uint64_t id,
                uint64_t class_id,
                StringId heap,
                ObjectType type) {
    return Object(&cols_, cols_.Append(id, class_id, heap, type));
  }

  // Builds the id->row index once, after all objects are appended. The
  // capacity is sized to the exact object count (rounded to a power of two, as
  // FlatHashMapV1 requires) so no rehash happens. First row wins on the (rare)
  // duplicate id, matching the previous get-or-create behaviour.
  void BuildIndex() {
    size_t n = cols_.size();
    size_t cap = 128;
    while (cap * 3 < n * 4)
      cap <<= 1;
    index_ = base::FlatHashMap<uint64_t, ObjectIndex>(cap);
    for (ObjectIndex i = 0; i < n; ++i)
      index_.Insert(cols_.id[i], i);
  }

  // A contiguous view of one object's references within edges_.
  struct RefSpan {
    const Reference* begin_;
    const Reference* end_;
    const Reference* begin() const { return begin_; }
    const Reference* end() const { return end_; }
    size_t size() const { return static_cast<size_t>(end_ - begin_); }
    bool empty() const { return begin_ == end_; }
  };

  // References are stored CSR-style: every object's references occupy a
  // contiguous run in edges_. Objects are resolved in index order and each
  // object's references are appended consecutively, so runs never interleave.
  void AddReference(Object& obj,
                    StringId field_name,
                    ObjectIndex target_index,
                    bool is_weak_referent = false) {
    ObjectIndex i = obj.index();
    if (cols_.ref_count[i] == 0)
      cols_.ref_begin[i] = static_cast<uint32_t>(edges_.size());
    edges_.emplace_back(field_name, target_index, is_weak_referent);
    ++cols_.ref_count[i];
  }

  RefSpan GetReferences(const Object& obj) const {
    ObjectIndex i = obj.index();
    const Reference* base = edges_.data();
    return {base + cols_.ref_begin[i],
            base + cols_.ref_begin[i] + cols_.ref_count[i]};
  }

  // Total number of reference edges across all objects. Known once the graph is
  // resolved; used to exactly size the reference output table.
  size_t edge_count() const { return edges_.size(); }

  // Releases the id->row map once nothing else needs id lookups (after the
  // class table is populated), so it is not resident while the large field/
  // reference tables are built.
  void ClearIndex() { index_ = base::FlatHashMap<uint64_t, ObjectIndex>(); }

  // Releases the CSR edge array once references have been written out.
  void ClearEdges() { edges_ = std::vector<Reference>(); }

  // Releases the object scalar columns once the object table is populated.
  void ClearScalars() { cols_.ClearScalars(); }

  void Clear() {
    index_.Clear();
    cols_.Clear();
    edges_.clear();
    edges_.shrink_to_fit();
  }

 private:
  base::FlatHashMap<uint64_t, ObjectIndex> index_;
  ObjectColumns cols_;
  // CSR reference edges shared by all objects; see AddReference.
  std::vector<Reference> edges_;
};

}  // namespace perfetto::trace_processor::art_hprof

#endif  // SRC_TRACE_PROCESSOR_IMPORTERS_ART_HPROF_ART_HPROF_MODEL_H_
