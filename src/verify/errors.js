// Typed errors the engine understands. A chain adapter throws one of these
// and the engine maps it to a status; anything else becomes a conservative
// MANUAL_REVIEW rather than a fabricated verdict.

class RpcUnavailableError extends Error {
  constructor(message, { tried = [], lastError = null } = {}) {
    super(message || 'All RPC endpoints are unavailable');
    this.name = 'RpcUnavailableError';
    this.tried = tried;
    this.lastError = lastError;
  }
}

class IndexingDelayError extends Error {
  constructor(message) {
    super(message || 'The chain has not indexed this yet');
    this.name = 'IndexingDelayError';
  }
}

class InvalidConfigurationError extends Error {
  constructor(message) {
    super(message || 'This task is not configured correctly');
    this.name = 'InvalidConfigurationError';
  }
}

module.exports = { RpcUnavailableError, IndexingDelayError, InvalidConfigurationError };
