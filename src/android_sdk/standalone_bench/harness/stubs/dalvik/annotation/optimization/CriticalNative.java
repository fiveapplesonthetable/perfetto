package dalvik.annotation.optimization;
import java.lang.annotation.*;
// CLASS retention: descriptor stays on the method so ART (boot classpath) applies
// the real CriticalNative calling convention; this stub class is NOT dexed.
@Retention(RetentionPolicy.CLASS) @Target(ElementType.METHOD)
public @interface CriticalNative {}
