/*
 * Copyright (C) 2026 The Android Open Source Project
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

#include "src/android_sdk/jni/dev_perfetto_sdk_PerfettoEvent.h"

#include <jni.h>

#include <cstdint>

#include "perfetto/base/build_config.h"
#include "src/android_sdk/jni/macros.h"
#include "src/android_sdk/nativehelper/JNIHelp.h"

namespace perfetto {
namespace jni {

// Returns the stable native address of a direct ByteBuffer. Called once per
// buffer (and on growth), never on the hot path, so a normal @FastNative is
// fine. The buffer backs the hybrid emit's off-heap body staging.
static jlong dev_perfetto_sdk_EmitBuffer_nativeAddress(JNIEnv* env,
                                                       jclass,
                                                       jobject buffer) {
  return static_cast<jlong>(reinterpret_cast<uintptr_t>(
      env->GetDirectBufferAddress(buffer)));
}

static const JNINativeMethod gBufferMethods[] = {
    {"nativeAddress", "(Ljava/nio/ByteBuffer;)J",
     (void*)dev_perfetto_sdk_EmitBuffer_nativeAddress},
};

int register_dev_perfetto_sdk_PerfettoEvent(JNIEnv* env) {
  int res = jniRegisterNativeMethods(
      env, TO_MAYBE_JAR_JAR_CLASS_NAME("dev/perfetto/sdk/EmitBuffer"),
      gBufferMethods, NELEM(gBufferMethods));
  LOG_ALWAYS_FATAL_IF(res < 0,
                      "Unable to register EmitBuffer native methods.");
  return 0;
}

}  // namespace jni
}  // namespace perfetto
