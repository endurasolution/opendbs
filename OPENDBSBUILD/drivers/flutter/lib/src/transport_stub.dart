import 'package:http/http.dart' as http;

/// HTTP client for the web. The browser checks certificates itself, so
/// `ignoreSSL` has no effect there.
http.Client createHttpClient({bool ignoreSSL = false}) => http.Client();

/// Browsers don't say whether a failed request reached the server.
bool notSent(Object e) => false;
