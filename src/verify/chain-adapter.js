// Phase 1 has no RPC, so on-chain state is explicitly unsupported rather
// than faked. Tasks that need it route to manual review.
class NullChainAdapter {
  async getBalance() { return { supported: false }; }
  async getNftOwnership() { return { supported: false }; }
  async getTxCount() { return { supported: false }; }
  async verifyContractCall() { return { supported: false }; }
}

module.exports = { NullChainAdapter };
