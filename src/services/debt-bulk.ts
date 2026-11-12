import type { MessageChannel } from "../generated/tenant-client";
import { AppError } from "../lib/app-error";
import type { createDebtService } from "./debt.service";
import { ChannelUnavailableError } from "./email.service";

// Debt board bulk actions: POST /debt/bulk { ids, action }. Each id is an
// invoice id (the debt board row id) and goes through the same per-debt
// service call the single-row endpoints use, one at a time, so one bad row
// (no contact details, GHL not connected, unknown invoice) is reported in
// `results` without stopping the rest. Weather hold, disputed debt etc. are
// out of scope here.

export const BULK_DEBT_ACTIONS = ["remind", "hold", "bad-debt"] as const;
export type BulkDebtAction = (typeof BULK_DEBT_ACTIONS)[number];
export const MAX_BULK_DEBT_IDS = 100;

export interface BulkDebtOptions {
  channel?: MessageChannel;
  message?: string;
  reason?: string;
  notify?: boolean;
  /** Called with the customer id after each successful reminder (GHL debt.overdue event). */
  onReminded?: (customerId: string) => void;
}

export interface BulkDebtResultRow {
  id: string;
  ok: boolean;
  error?: string;
  code?: string;
  /** true = not an error: the customer could not be messaged (see reason). */
  skipped?: boolean;
  /** CUSTOMER_OPTED_OUT | NO_AVAILABLE_CHANNEL when skipped. */
  reason?: "CUSTOMER_OPTED_OUT" | "NO_AVAILABLE_CHANNEL";
}

function skipReason(err: unknown): BulkDebtResultRow["reason"] {
  if (err instanceof ChannelUnavailableError || (err instanceof AppError && err.code === "NO_CONTACT_FOR_CHANNEL")) return "NO_AVAILABLE_CHANNEL";
  if (err instanceof AppError && err.code === "CUSTOMER_OPTED_OUT") return "CUSTOMER_OPTED_OUT";
  return undefined;
}

export interface BulkDebtResult {
  action: BulkDebtAction;
  total: number;
  succeeded: number;
  failed: number;
  results: BulkDebtResultRow[];
}

export function parseBulkDebtRequest(body: Record<string, unknown>): { ids: string[]; action: BulkDebtAction } {
  const action = body.action;
  if (typeof action !== "string" || !(BULK_DEBT_ACTIONS as readonly string[]).includes(action)) {
    throw new AppError(400, `action must be one of: ${BULK_DEBT_ACTIONS.join(", ")}`);
  }
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== "string" || i === "")) {
    throw new AppError(400, "ids must be a non-empty array of invoice ids");
  }
  if (ids.length > MAX_BULK_DEBT_IDS) {
    throw new AppError(400, `ids must not contain more than ${MAX_BULK_DEBT_IDS} items`);
  }
  return { ids: [...new Set(ids as string[])], action: action as BulkDebtAction };
}

export async function runBulkDebtAction(
  debt: ReturnType<typeof createDebtService>,
  ids: string[],
  action: BulkDebtAction,
  opts: BulkDebtOptions = {}
): Promise<BulkDebtResult> {
  const results: BulkDebtResultRow[] = [];
  for (const id of ids) {
    try {
      if (action === "remind") {
        const sent = await debt.sendReminder(id, { channel: opts.channel, message: opts.message });
        opts.onReminded?.(sent.customerId);
      } else if (action === "hold") {
        await debt.flagHold(id, true, { reason: opts.reason, notify: opts.notify, message: opts.message });
      } else {
        await debt.flagBadDebt(id, true);
      }
      results.push({ id, ok: true });
    } catch (err) {
      const reason = skipReason(err);
      results.push({
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof AppError && err.code ? { code: err.code } : {}),
        ...(reason ? { skipped: true, reason } : {}),
      });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  return { action, total: ids.length, succeeded, failed: ids.length - succeeded, results };
}
