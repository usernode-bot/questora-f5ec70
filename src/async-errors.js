// Express 4 routes a handler's thrown error through the error middleware, but
// a rejected promise from an `async` handler is silently dropped: it becomes
// an unhandled rejection and kills the process. This bridges the gap by
// sending a handler's rejection to `next(err)`, the same mechanism the
// express-async-errors package uses. Express 5 does this natively, so this
// module can be deleted once the app upgrades.
const Layer = require('express/lib/router/layer');

Layer.prototype.handle_request = function handle_request(req, res, next) {
  var fn = this.handle;

  if (fn.length > 3) {
    // not a standard request handler
    return next();
  }

  try {
    var ret = fn(req, res, next);
    if (ret && typeof ret.catch === 'function') {
      ret.catch(next);
    }
  } catch (err) {
    next(err);
  }
};