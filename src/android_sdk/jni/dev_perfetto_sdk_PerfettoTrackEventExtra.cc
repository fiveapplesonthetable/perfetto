/*
 * Copyright (C) 2025 The Android Open Source Project
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#include "src/android_sdk/jni/dev_perfetto_sdk_PerfettoTrackEventExtra.h"

#include <jni.h>
#include "src/android_sdk/jni/macros.h"
#include "src/android_sdk/jni/string_buffer.h"
#include "src/android_sdk/nativehelper/JNIHelp.h"
#include "src/android_sdk/nativehelper/scoped_utf_chars.h"
#include "src/android_sdk/perfetto_sdk_for_jni/tracing_sdk.h"

namespace perfetto {
namespace jni {

template <typename T>
inline static T* toPointer(jlong ptr) {
  return reinterpret_cast<T*>(static_cast<uintptr_t>(ptr));
}

template <typename T>
inline static jlong toJLong(T* ptr) {
  return static_cast<jlong>(reinterpret_cast<uintptr_t>(ptr));
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraNestedTracks_init(
    JNIEnv* env,
    jclass,
    jint root_type,
    jlong tid,
    jobjectArray names,
    jlongArray ids,
    jbooleanArray is_name_static,
    jbooleanArray is_counter) {
  const jsize n = env->GetArrayLength(names);
  std::vector<std::string> names_vec;
  names_vec.reserve(static_cast<size_t>(n));
  for (jsize i = 0; i < n; i++) {
    jstring s = static_cast<jstring>(env->GetObjectArrayElement(names, i));
    // Copies the bytes into the owning std::string immediately; the shared
    // thread-local view buffer can be reset right after the loop.
    names_vec.emplace_back(StringBuffer::utf16_to_ascii(env, s));
    env->DeleteLocalRef(s);
  }
  StringBuffer::reset();
  jlong* id_ptr = env->GetLongArrayElements(ids, nullptr);
  std::vector<uint64_t> ids_vec(reinterpret_cast<const uint64_t*>(id_ptr),
                                reinterpret_cast<const uint64_t*>(id_ptr) + n);
  env->ReleaseLongArrayElements(ids, id_ptr, JNI_ABORT);

  jboolean* st_ptr = env->GetBooleanArrayElements(is_name_static, nullptr);
  std::vector<bool> static_vec(st_ptr, st_ptr + n);
  env->ReleaseBooleanArrayElements(is_name_static, st_ptr, JNI_ABORT);

  jboolean* ct_ptr = env->GetBooleanArrayElements(is_counter, nullptr);
  std::vector<bool> counter_vec(ct_ptr, ct_ptr + n);
  env->ReleaseBooleanArrayElements(is_counter, ct_ptr, JNI_ABORT);

  return toJLong(new sdk_for_jni::NestedTracks(
      static_cast<sdk_for_jni::RootType>(root_type),
      static_cast<uint64_t>(tid), names_vec, ids_vec, static_vec, counter_vec));
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraNestedTracks_delete(
    PERFETTO_JNI_HOST_PARAMS) {
  return toJLong(&sdk_for_jni::NestedTracks::delete_track);
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraNestedTracks_get_extra_ptr(
    PERFETTO_JNI_HOST_PARAMS_COMMA jlong ptr) {
  sdk_for_jni::NestedTracks* track = toPointer<sdk_for_jni::NestedTracks>(ptr);
  return toJLong(track->get());
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraCounter_init(
    PERFETTO_JNI_HOST_PARAMS) {
  return toJLong(new sdk_for_jni::Counter());
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraCounter_delete(
    PERFETTO_JNI_HOST_PARAMS) {
  return toJLong(&sdk_for_jni::Counter::delete_counter);
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraCounter_get_extra_ptr(
    PERFETTO_JNI_HOST_PARAMS_COMMA jlong ptr) {
  sdk_for_jni::Counter* counter = toPointer<sdk_for_jni::Counter>(ptr);
  return toJLong(counter->get());
}

static void dev_perfetto_sdk_PerfettoTrackEventExtraCounter_set_value_int64(
    PERFETTO_JNI_HOST_PARAMS_COMMA jlong ptr,
    jlong val) {
  sdk_for_jni::Counter* counter = toPointer<sdk_for_jni::Counter>(ptr);
  auto& counter_int64 = counter->get()->counter_int64;
  counter_int64.header.type = PERFETTO_TE_HL_EXTRA_TYPE_COUNTER_INT64;
  counter_int64.value = val;
}

static void dev_perfetto_sdk_PerfettoTrackEventExtraCounter_set_value_double(
    PERFETTO_JNI_HOST_PARAMS_COMMA jlong ptr,
    jdouble val) {
  sdk_for_jni::Counter* counter = toPointer<sdk_for_jni::Counter>(ptr);
  auto& counter_double = counter->get()->counter_double;
  counter_double.header.type = PERFETTO_TE_HL_EXTRA_TYPE_COUNTER_DOUBLE;
  counter_double.value = val;
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtra_init(
    PERFETTO_JNI_HOST_PARAMS) {
  return toJLong(new sdk_for_jni::Extra());
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtra_delete(
    PERFETTO_JNI_HOST_PARAMS) {
  return toJLong(&sdk_for_jni::Extra::delete_extra);
}

static void dev_perfetto_sdk_PerfettoTrackEventExtra_add_arg(
    PERFETTO_JNI_HOST_PARAMS_COMMA jlong extra_ptr,
    jlong arg_ptr) {
  sdk_for_jni::Extra* extra = toPointer<sdk_for_jni::Extra>(extra_ptr);
  extra->push_extra(toPointer<PerfettoTeHlExtra>(arg_ptr));
}

static void dev_perfetto_sdk_PerfettoTrackEventExtra_clear_args(
    PERFETTO_JNI_HOST_PARAMS_COMMA jlong ptr) {
  sdk_for_jni::Extra* extra = toPointer<sdk_for_jni::Extra>(ptr);
  extra->clear_extras();
}

// Copies the Java-encoded body into the RawBody's native buffer (when present)
// and emits, both in this one @FastNative crossing. Folding the copy into emit
// removes a second JNI transition per body-bearing event; GetByteArrayRegion is
// a plain memcpy, and the bytes are spliced in as one RAW proto field by the
// RawBody extra already registered on extra_ptr.
static void dev_perfetto_sdk_PerfettoTrackEventExtra_emit(JNIEnv* env,
                                                          jclass,
                                                          jint type,
                                                          jlong cat_ptr,
                                                          jstring name,
                                                          jlong extra_ptr,
                                                          jlong raw_body_ptr,
                                                          jbyteArray body,
                                                          jint body_len) {
  auto* raw_body = toPointer<sdk_for_jni::RawBody>(raw_body_ptr);
  if (body_len > 0) {
    uint8_t* dst = raw_body->reserve_body(static_cast<size_t>(body_len));
    env->GetByteArrayRegion(body, 0, body_len, reinterpret_cast<jbyte*>(dst));
  }
  sdk_for_jni::Category* category = toPointer<sdk_for_jni::Category>(cat_ptr);
  trace_event(type, category->get(),
              StringBuffer::utf16_to_ascii(env, name).data(),
              toPointer<sdk_for_jni::Extra>(extra_ptr));
  StringBuffer::reset();
  raw_body->reset_after_emit();
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_init(
    PERFETTO_JNI_HOST_PARAMS) {
  return toJLong(new sdk_for_jni::RawBody());
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_delete(
    PERFETTO_JNI_HOST_PARAMS) {
  return toJLong(&sdk_for_jni::RawBody::delete_raw_body);
}

static jlong dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_get_extra_ptr(
    PERFETTO_JNI_HOST_PARAMS_COMMA jlong ptr) {
  return toJLong(toPointer<sdk_for_jni::RawBody>(ptr)->get());
}

static void dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_add_interned(
    JNIEnv* env,
    jclass,
    jlong ptr,
    jlong id,
    jstring val,
    jlong interned_type_id) {
  toPointer<sdk_for_jni::RawBody>(ptr)->add_interned(
      static_cast<uint32_t>(id), StringBuffer::utf16_to_ascii(env, val).data(),
      static_cast<uint32_t>(interned_type_id));
}

static const JNINativeMethod gRawBodyMethods[] = {
    {"native_init", "()J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_init},
    {"native_add_interned", "(JJLjava/lang/String;J)V",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_add_interned},
    {"native_delete", "()J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_delete},
    {"native_get_extra_ptr", "(J)J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraRawBody_get_extra_ptr}};

static const JNINativeMethod gExtraMethods[] = {
    {"native_init", "()J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtra_init},
    {"native_delete", "()J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtra_delete},
    {"native_add_arg", "(JJ)V",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtra_add_arg},
    {"native_clear_args", "(J)V",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtra_clear_args},
    {"native_emit", "(IJLjava/lang/String;JJ[BI)V",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtra_emit}};

static const JNINativeMethod gNestedTracksMethods[] = {
    {"native_init", "(IJ[Ljava/lang/String;[J[Z[Z)J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraNestedTracks_init},
    {"native_delete", "()J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraNestedTracks_delete},
    {"native_get_extra_ptr", "(J)J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraNestedTracks_get_extra_ptr},
};

static const JNINativeMethod gCounterMethods[] = {
    {"native_init", "()J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraCounter_init},
    {"native_delete", "()J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraCounter_delete},
    {"native_get_extra_ptr", "(J)J",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraCounter_get_extra_ptr},
    {"native_set_value_int64", "(JJ)V",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraCounter_set_value_int64},
    {"native_set_value_double", "(JD)V",
     (void*)dev_perfetto_sdk_PerfettoTrackEventExtraCounter_set_value_double}};

int register_dev_perfetto_sdk_PerfettoTrackEventExtra(JNIEnv* env) {
  int res = jniRegisterNativeMethods(
      env,
      TO_MAYBE_JAR_JAR_CLASS_NAME("dev/perfetto/sdk/PerfettoTrackEventExtra"),
      gExtraMethods, NELEM(gExtraMethods));
  LOG_ALWAYS_FATAL_IF(res < 0, "Unable to register extra native methods.");

  res = jniRegisterNativeMethods(
      env,
      TO_MAYBE_JAR_JAR_CLASS_NAME(
          "dev/perfetto/sdk/PerfettoTrackEventExtra$RawBody"),
      gRawBodyMethods, NELEM(gRawBodyMethods));
  LOG_ALWAYS_FATAL_IF(res < 0, "Unable to register raw body native methods.");

  res = jniRegisterNativeMethods(
      env,
      TO_MAYBE_JAR_JAR_CLASS_NAME(
          "dev/perfetto/sdk/PerfettoTrackEventExtra$NestedTracks"),
      gNestedTracksMethods, NELEM(gNestedTracksMethods));
  LOG_ALWAYS_FATAL_IF(res < 0,
                      "Unable to register nested tracks native methods.");

  res = jniRegisterNativeMethods(
      env,
      TO_MAYBE_JAR_JAR_CLASS_NAME(
          "dev/perfetto/sdk/PerfettoTrackEventExtra$Counter"),
      gCounterMethods, NELEM(gCounterMethods));
  LOG_ALWAYS_FATAL_IF(res < 0, "Unable to register counter native methods.");

  return 0;
}

}  // namespace jni
}  // namespace perfetto
