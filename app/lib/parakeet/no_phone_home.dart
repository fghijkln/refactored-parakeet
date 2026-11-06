// Parakeet: no telemetry, no update checks, no share/forum/community servers.
//
// The upstream endpoints are already replaced with `parakeet.invalid` in the
// sources; this is the second fence. Every dart:io HttpClient (package:http on
// IO uses it too) refuses blocked hosts before any DNS lookup or connection.
import 'dart:io';

/// Hosts this build never talks to (upstream dsh-Go services and its CDNs/mirrors).
const parakeetBlockedHosts = <String>{
  'parakeet.invalid',
  'dsh-otel-collector.deepseeksvc.com',
};

bool parakeetBlocked(Uri url) {
  final host = url.host.toLowerCase();
  if (host.endsWith('.invalid')) return true;
  return parakeetBlockedHosts.contains(host);
}

class _NoPhoneHomeOverrides extends HttpOverrides {
  _NoPhoneHomeOverrides(this._previous);

  final HttpOverrides? _previous;

  @override
  HttpClient createHttpClient(SecurityContext? context) {
    final client = _previous?.createHttpClient(context) ?? super.createHttpClient(context);
    // Blocked hosts are sent to a dead loopback proxy (discard port): the request
    // fails locally, no DNS lookup, nothing leaves the phone. Others are untouched.
    client.findProxy = (url) => parakeetBlocked(url) ? 'PROXY 127.0.0.1:9' : HttpClient.findProxyFromEnvironment(url);
    return client;
  }
}

void installNoPhoneHome() {
  HttpOverrides.global = _NoPhoneHomeOverrides(HttpOverrides.current);
}
