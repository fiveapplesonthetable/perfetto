// Buggy native lib: every allocate() call mallocs N KiB and never frees it.

#include <jni.h>
#include <stdlib.h>
#include <string.h>

// Plain-C dynamic array. No STL → no libc++_shared dependency.
static void**  g_leaked = NULL;
static size_t  g_count  = 0;
static size_t  g_cap    = 0;

extern "C"
JNIEXPORT void JNICALL
Java_com_example_perfetto_nativeheap_NativeHeapActivity_allocate(
        JNIEnv* env, jobject thiz, jint kib) {
    void* p = malloc((size_t)kib * 1024);
    memset(p, 0xAB, (size_t)kib * 1024);          // touch the pages
    if (g_count == g_cap) {
        g_cap = g_cap ? g_cap * 2 : 64;
        g_leaked = (void**)realloc(g_leaked, g_cap * sizeof(void*));
    }
    g_leaked[g_count++] = p;                       // pin forever
}
