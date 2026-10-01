// SocialVerifier is the seam real OAuth adapters (X, Discord, YouTube,
// GitHub) will plug into later. Phase 1 ships only ManualSocialVerifier,
// which NEVER reports verified on its own: a user-confirmed click or visit
// is Pending review, and a project reviewer decides. A future OAuth
// subclass would override verify() to return 'verified' only after a real
// provider check.
class SocialVerifier {
  constructor(name) { this.name = name; }
  verify(ctx) {
    throw new Error('SocialVerifier subclasses must implement verify()');
  }
}

class ManualSocialVerifier extends SocialVerifier {
  constructor() { super('manual-social'); }
  verify(ctx) {
    return { result: 'pending', detail: { via: 'review', verifier: this.name } };
  }
}

const manualSocialVerifier = new ManualSocialVerifier();

module.exports = { SocialVerifier, ManualSocialVerifier, manualSocialVerifier };
