// API client: forwards the iframe token from the URL into x-usernode-token.
'use strict';
(function () {
  var params = new URLSearchParams(window.location.search);
  var TOKEN = params.get('token') || '';

  // GETs are deduped two ways: concurrent identical reads share one in-flight
  // promise, and a settled read is reused for a short window. Any write clears
  // the whole cache so a caller that just changed state reads fresh data.
  var inflight = new Map();
  var cache = new Map();
  var CACHE_MS = 2000;

  function clearCache() { cache.clear(); }

  // The navigation context (see app.js beginNav) owns an AbortSignal that
  // cancels reads when the visitor leaves the screen. Two navigations may ask
  // for the same path, but they must NOT share one request: the older one's
  // signal is aborted on the next navigation, and reusing its promise would
  // reject the newer, still-current read with the browser's raw abort text.
  function navSignal(opts) {
    if (opts && opts.signal) return opts.signal;
    return (window.QV && window.QV.__ctx && window.QV.__ctx.signal) || null;
  }

  // A cancelled read is not a failure: an AbortError (or an already-aborted
  // signal) means the request was superseded, so callers must swallow it
  // rather than render it as an error.
  function isCancelled(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    return /abort/i.test(String(err.message || ''));
  }

  async function request(path, options = {}) {
    // Cancel a read that belongs to a navigation the user has already left.
    var signal = navSignal(options);
    var res = await fetch(path, {
      ...options,
      signal: signal || undefined,
      headers: {
        'Content-Type': 'application/json',
        'x-usernode-token': TOKEN,
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) throw new Error('You need to sign in through Homeroom');
    var data = await res.json().catch(() => ({}));
    if (!res.ok) {
      var err = new Error(data.error || 'Something went wrong');
      err.code = data.code; err.status = res.status;
      throw err;
    }
    return data;
  }

  function get(p, opts) {
    var cached = cache.get(p);
    if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.data);
    var signal = navSignal(opts);
    // Reuse an in-flight read only when it belongs to the SAME navigation
    // context. A different (or absent) signal always starts a fresh request,
    // so a newer navigation never inherits the older one's cancellation.
    var existing = inflight.get(p);
    if (existing && existing.signal === signal) return existing.promise;
    var entry = { signal: signal };
    entry.promise = request(p, Object.assign({}, opts, { signal: signal })).then((data) => {
      // Never cache a response the visitor's navigation already abandoned.
      if (!signal || !signal.aborted) cache.set(p, { at: Date.now(), data: data });
      return data;
    }).finally(() => { if (inflight.get(p) === entry) inflight.delete(p); });
    inflight.set(p, entry);
    return entry.promise;
  }

  function write(method, p, body, opts) {
    // A write can change anything a cached read returned, so drop the cache.
    clearCache();
    return request(p, { ...(opts || {}), method: method, body: JSON.stringify(body || {}) });
  }

  const api = {
    get: (p, opts) => get(p, opts),
    post: (p, body, opts) => write('POST', p, body, opts),
    patch: (p, body, opts) => write('PATCH', p, body, opts),
    del: (p, body, opts) => write('DELETE', p, body, opts),
    invalidate: clearCache,
  };

  window.QuestoraAPI = { api, TOKEN, isCancelled };
})();
