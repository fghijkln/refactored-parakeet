// Parakeet APKs run DSH on the host engine: Termux's Bionic node + bash, no PRoot,
// no Ubuntu. Two of upstream's native pieces are not shipped there:
//  - node-pty, behind the terminal page and the agent's terminal_* tools;
//  - sherpa-onnx, behind the on-device voice model (SenseVoice).
// So in an APK the terminal entries are hidden and voice input uses the phone's
// own recognition service only.
//
// tooling/parakeet-locale.sh flips [parakeetHostEngine] to true in the prepared
// (single-language) APK tree. The unprepared source tree (flutter test, flutter
// analyze) keeps upstream's behaviour, so the upstream tests still cover it.

/// Set to true by tooling/parakeet-locale.sh (false in the unprepared tree).
const bool parakeetHostEngine = false;
