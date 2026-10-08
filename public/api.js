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

  // True when a rejection is a cancelled request, not a failure: fetch's own
  // AbortError (a DOMException, so the name survives the throw), or the signal
  // that governed the call has aborted. Cancelled reads never render an error.
  function isAbort(err, signal) {
    return !!(err && err.name === 'AbortError') || !!(signal && signal.aborted);
  }

  async function request(path, options = {}) {
    // Only a caller-passed signal can cancel a request here. The navigation
    // signal is resolved by get() for reads; writes carry no signal, so an
    // action the user starts is never cancelled by a route change.
    var res = await fetch(path, {
      ...options,
      signal: options.signal || undefined,
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
    opts = opts || {};
    // Reads belong to a navigation: an explicit `signal` key wins (null means
    // no signal), otherwise the read rides the current navigation's signal.
    var signal = 'signal' in opts
      ? opts.signal
      : (window.QV && window.QV.__ctx && window.QV.__ctx.signal) || null;
    var cached = cache.get(p);
    if (cached && Date.now() - cached.at < CACHE_MS) return Promise.resolve(cached.data);
    if (inflight.has(p)) return inflight.get(p);
    var promise = request(p, { ...opts, signal: signal || undefined }).then((data) => {
      cache.set(p, { at: Date.now(), data: data });
      return data;
    }).finally(() => { inflight.delete(p); });
    inflight.set(p, promise);
    // `.finally` deletes the inflight entry a microtask late; drop it as soon
    // as the signal aborts so a newer navigation never reuses an aborted read.
    if (signal) {
      signal.addEventListener('abort', () => {
        if (inflight.get(p) === promise) inflight.delete(p);
      }, { once: true });
    }
    return promise;
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

  window.QuestoraAPI = { api, TOKEN, isAbort };
})();
