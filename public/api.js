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

  async function request(path, options = {}) {
    // Cancel a read that belongs to a navigation the user has already left.
    var signal = options.signal || (window.QV && window.QV.__ctx && window.QV.__ctx.signal);
    var res = await fetch(path, {
      ...options,
      signal: signal,
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
    if (inflight.has(p)) return inflight.get(p);
    var promise = request(p, opts).then((data) => {
      cache.set(p, { at: Date.now(), data: data });
      return data;
    }).finally(() => { inflight.delete(p); });
    inflight.set(p, promise);
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

  window.QuestoraAPI = { api, TOKEN };
})();
