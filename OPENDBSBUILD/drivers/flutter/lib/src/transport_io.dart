import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

/// HTTP client for platforms with dart:io (Android, iOS, desktop, server).
http.Client createHttpClient({bool ignoreSSL = false}) {
  if (!ignoreSSL) return http.Client();
  final io = HttpClient()
    ..badCertificateCallback =
        (X509Certificate cert, String host, int port) => true;
  return IOClient(io);
}

/// True when [e] means the request never reached a server (safe to retry, even writes).
bool notSent(Object e) {
  final s = e.toString().toLowerCase();
  return s.contains('refused') ||
      s.contains('failed host lookup') ||
      s.contains('unreachable') ||
      s.contains('no route to host');
}
