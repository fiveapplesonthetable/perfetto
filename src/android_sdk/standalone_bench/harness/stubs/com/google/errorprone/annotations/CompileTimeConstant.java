package com.google.errorprone.annotations;
import java.lang.annotation.*;
// SOURCE retention: vanishes after compile, no dex/runtime trace.
@Retention(RetentionPolicy.SOURCE) @Target({ElementType.PARAMETER, ElementType.FIELD})
public @interface CompileTimeConstant {}
