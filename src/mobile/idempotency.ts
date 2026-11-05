import { NextFunction, Request, Response } from "express";
import type { Prisma } from "../generated/tenant-client";
import type { TenantPrismaClient } from "../lib/tenant-prisma-manager";

// Offline-replay dedup for /mobile/visits/:id/* writes (A8). The app queues
// actions while offline and replays them with the same X-Idempotency-Key, so a
// request that already succeeded must not run twice.
//
// - No header: the request runs normally.
// - Stored key, same technician + same route: the stored status and body are
//   replayed without re-executing the handler (Idempotent-Replay: true).
// - Stored key, different technician: 403 IDEMPOTENCY_KEY_CONFLICT.
// - Stored key, same technician but another route/visit: 409 IDEMPOTENCY_KEY_REUSED.
// Only 2xx responses are stored, so a request that failed validation (or
// with a 5xx) can be retried with the same key once it is fixed.
//
// Must run after requireTechnician (needs req.technician).

export const IDEMPOTENCY_HEADER = "x-idempotency-key";
export const IDEMPOTENCY_TTL_DAYS = 7;
const MAX_KEY_LENGTH = 200;

function routeOf(req: Request): string {
  return `${req.method} ${req.originalUrl.split("?")[0]}`;
}

export function idempotency() {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const key = req.header(IDEMPOTENCY_HEADER);
    if (key === undefined) return next();
    if (key.trim() === "" || key.length > MAX_KEY_LENGTH) {
      res.status(400).json({
        error: `${IDEMPOTENCY_HEADER} must be 1-${MAX_KEY_LENGTH} characters`,
        code: "INVALID_IDEMPOTENCY_KEY",
      });
      return;
    }

    try {
      const tp = req.tenantPrisma!;
      const technicianId = req.technician!.id;
      const route = routeOf(req);

      const existing = await tp.idempotencyRecord.findUnique({ where: { key } });
      if (existing) {
        if (existing.technicianId !== technicianId) {
          res.status(403).json({ error: "Idempotency key belongs to another user", code: "IDEMPOTENCY_KEY_CONFLICT" });
          return;
        }
        if (existing.route !== route) {
          res.status(409).json({ error: "Idempotency key was already used for a different request", code: "IDEMPOTENCY_KEY_REUSED" });
          return;
        }
        res.setHeader("Idempotent-Replay", "true");
        res.status(existing.responseStatus).json(existing.responseBody);
        return;
      }

      // Capture the handler's JSON response; persist it (2xx only) before sending.
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (res.statusCode < 200 || res.statusCode >= 300) return originalJson(body);
        const responseBody = JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue;
        tp.idempotencyRecord
          .create({ data: { key, technicianId, route, responseStatus: res.statusCode, responseBody } })
          .catch((err: unknown) => console.error("[idempotency] failed to store response:", err))
          .finally(() => originalJson(body));
        return res;
      }) as Response["json"];

      next();
    } catch (err) {
      next(err);
    }
  };
}

// Nightly purge (7-day TTL). Returns the number of records deleted.
export async function purgeIdempotencyRecords(tp: TenantPrismaClient, olderThan: Date): Promise<number> {
  const { count } = await tp.idempotencyRecord.deleteMany({ where: { createdAt: { lt: olderThan } } });
  return count;
}
