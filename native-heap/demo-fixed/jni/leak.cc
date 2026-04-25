// Fixed native lib: every allocate() call mallocs and frees inside the call.

#include <jni.h>
#include <stdlib.h>
#include <string.h>

extern "C"
JNIEXPORT void JNICALL
Java_com_example_perfetto_nativeheap_NativeHeapActivity_allocate(
        JNIEnv* env, jobject thiz, jint kib) {
    void* p = malloc(static_cast<size_t>(kib) * 1024);
    memset(p, 0xAB, static_cast<size_t>(kib) * 1024);
    free(p);                                           // <-- the fix
}
