import { PaymentStatus } from "../generated/tenant-client";

// BE-07: the Payment state machine. Every status change goes through canTransition(); a transition that is not
// listed is ignored by webhooks (a late or replayed event must never move money backwards) and rejected with 409
// by manual actions.
//
//   NOT_DUE / PENDING / OVERDUE -> PROCESSING | PAID | FAILED | CANCELLED   (PENDING/NOT_DUE may also go OVERDUE)
//   PROCESSING (direct debit being collected) -> PAID | FAILED | CANCELLED
//   FAILED -> PAID (a retry succeeded) | PROCESSING (a retry is in flight)
//   PAID is terminal except REFUNDED and DISPUTED
//   DISPUTED -> PAID (dispute won) | REFUNDED
//   CANCELLED and REFUNDED are terminal
const S = PaymentStatus;

export const ALLOWED_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  [S.NOT_DUE]: [S.PENDING, S.PROCESSING, S.PAID, S.FAILED, S.CANCELLED, S.OVERDUE],
  [S.PENDING]: [S.PROCESSING, S.PAID, S.FAILED, S.CANCELLED, S.OVERDUE],
  [S.OVERDUE]: [S.PROCESSING, S.PAID, S.FAILED, S.CANCELLED],
  [S.PROCESSING]: [S.PAID, S.FAILED, S.CANCELLED],
  [S.FAILED]: [S.PAID, S.PROCESSING],
  [S.PAID]: [S.REFUNDED, S.DISPUTED],
  [S.DISPUTED]: [S.PAID, S.REFUNDED],
  [S.CANCELLED]: [],
  [S.REFUNDED]: [],
};

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

/** Direct debit that has been created or accepted and is still being collected (ACT-07). */
export const COLLECTING_STATUSES: readonly PaymentStatus[] = [S.PENDING, S.PROCESSING];

/** A person recording the payment by hand (mark-paid) may settle these; DISPUTED / REFUNDED are decided by the provider. */
export const MANUALLY_SETTLEABLE: readonly PaymentStatus[] = [S.NOT_DUE, S.PENDING, S.OVERDUE, S.PROCESSING, S.FAILED, S.CANCELLED];
