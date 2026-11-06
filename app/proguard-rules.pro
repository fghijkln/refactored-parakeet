# Parakeet R8 rules. The app has no reflection of its own; AndroidX Security
# (Tink) and WebKit ship their consumer rules. Keep stack traces readable.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
# Tink's protobuf-lite messages are looked up reflectively by field name.
-keepclassmembers class * extends com.google.crypto.tink.shaded.protobuf.GeneratedMessageLite { <fields>; }
-dontwarn com.google.errorprone.annotations.**
-dontwarn javax.annotation.**
