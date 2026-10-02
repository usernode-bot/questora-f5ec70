// The universal verification status enum. Every chain adapter, whatever its
// family, reports one of these nine values; the engine maps it to a coarse
// task_submissions.status that the existing quest/reward code already
// understands. The enum, not the coarse value, is always stored on
// verification_attempts and task_submissions.verification_status.
//
// The classification encodes the platform's "infrastructure failure is not
// user failure" rule: only VERIFIED, FAILED and EXPIRED are terminal
// verdicts; an RPC that is down never reads as a rejection.

const STATUSES = [
  'VERIFIED',
  'FAILED',
  'EXPIRED',
  'PENDING',
  'WAITING_CONFIRMATIONS',
  'INDEXING_DELAY',
  'RPC_UNAVAILABLE',
  'MANUAL_REVIEW',
  'INVALID_CONFIGURATION',
];

const CLASSIFICATION = {
  VERIFIED: {
    storedStatus: 'verified', isUserFailure: false, awardsCompletion: true,
    label: 'Verified', tone: 'emerald',
    defaultReason: 'Verified on chain.',
  },
  FAILED: {
    storedStatus: 'rejected', isUserFailure: true, awardsCompletion: false,
    label: 'Not met', tone: 'red',
    defaultReason: 'The on-chain evidence does not meet this task.',
  },
  EXPIRED: {
    storedStatus: 'rejected', isUserFailure: true, awardsCompletion: false,
    label: 'Expired', tone: 'zinc',
    defaultReason: 'The verification window has closed.',
  },
  PENDING: {
    storedStatus: 'pending', isUserFailure: false, awardsCompletion: false,
    label: 'Pending', tone: 'amber',
    defaultReason: 'Waiting for the chain.',
  },
  WAITING_CONFIRMATIONS: {
    storedStatus: 'pending', isUserFailure: false, awardsCompletion: false,
    label: 'Waiting for confirmations', tone: 'amber',
    defaultReason: 'Waiting for more confirmations before this counts.',
  },
  INDEXING_DELAY: {
    storedStatus: 'pending', isUserFailure: false, awardsCompletion: false,
    label: 'Indexing delay', tone: 'sky',
    defaultReason: 'The chain has not shown this yet. Try again shortly.',
  },
  RPC_UNAVAILABLE: {
    storedStatus: 'pending', isUserFailure: false, awardsCompletion: false,
    label: 'Temporarily unavailable', tone: 'amber',
    defaultReason: 'The network could not be reached. Try again shortly.',
  },
  MANUAL_REVIEW: {
    storedStatus: 'pending', isUserFailure: false, awardsCompletion: false,
    label: 'Manual review', tone: 'amber',
    defaultReason: 'This task is reviewed by the project team.',
  },
  INVALID_CONFIGURATION: {
    storedStatus: 'invalid', isUserFailure: false, awardsCompletion: false,
    label: 'Not set up', tone: 'zinc',
    defaultReason: 'This task is not configured correctly.',
  },
};

function isStatus(status) {
  return STATUSES.includes(status);
}

// Map an enum value to its coarse behaviour. An unknown value is treated as
// infrastructure (never a user failure), so a future adapter that reports a
// status this build does not know cannot reject a participant.
function classify(status) {
  return CLASSIFICATION[status] || CLASSIFICATION.RPC_UNAVAILABLE;
}

// The coarse task_submissions.status for an enum value. New writer: the
// submit route tolerates the new 'invalid' value.
function coarseStatus(status) {
  return classify(status).storedStatus;
}

// Convenience for the UI layer: the short label for a stored coarse status.
function labelFor(status) {
  return classify(status).label;
}

module.exports = { STATUSES, CLASSIFICATION, isStatus, classify, coarseStatus, labelFor };
