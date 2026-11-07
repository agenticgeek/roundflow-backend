import { NextFunction, Request, RequestHandler, Response } from "express";
import { Prisma } from "../generated/tenant-client";

// BE-17: atomic request idempotency, shared by the mobile offline queue (X-Idempotency-Key) and admin writes
// (Idempotency-Key). The key row is INSERTED FIRST (state IN_PROGRESS); the primary key is the lock, so two
// concurrent requests with the same key cannot both execute:
//
//   claim ok              -> run the handler; on 2xx store the response (state DONE); otherwise release the key
//   key exists, DONE      -> replay the stored status/body (Idempotent-Replay: true), handler not run
//   key exists, IN_PROGRESS (younger than IDEMPOTENCY_STALE_MS) -> 409 IDEMPOTENCY_IN_PROGRESS + Retry-After: 1
//   key exists, IN_PROGRESS but stale (the first request died) -> take it over and run
//   other owner -> 403 IDEMPOTENCY_KEY_CONFLICT; other route -> 409 IDEMPOTENCY_KEY_REUSED
//
// Only 2xx responses are stored, so a request that failed validation (or a 5xx) can be retried with the same key.

export const IDEMPOTENCY_TTL_DAYS = 7;
export const IDEMPOTENCY_STALE_MS = 2 * 60_000;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_CLAIM_ATTEMPTS = 3;

export interface IdempotencyOwner {
  technicianId?: string;
  actorId?: string;
}

export interface IdempotencyConfig {
  /** Header names, lower-case, first one present wins. */
  headers: string[];
  owner: (req: Request) => IdempotencyOwner;
  /** Stored primary key for a client-supplied key; defaults to the client key itself. */
  storageKey?: (req: Request, clientKey: string) => string;
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const routeOf = (req: Request) => `${req.method} ${req.originalUrl.split("?")[0]}`;

export function createIdempotency(config: IdempotencyConfig): RequestHandler {
  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const clientKey = config.headers.map((h) => req.header(h)).find((v) => v !== undefined);
    if (clientKey === undefined) return next();
    if (clientKey.trim() === "" || clientKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      res.status(400).json({
        error: `${config.headers[0]} must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
        code: "INVALID_IDEMPOTENCY_KEY",
      });
      return;
    }

    try {
      const tp = req.tenantPrisma!;
      const owner = config.owner(req);
      const key = config.storageKey ? config.storageKey(req, clientKey) : clientKey;
      const route = routeOf(req);

      for (let attempt = 0; ; attempt++) {
        try {
          await tp.idempotencyRecord.create({
            data: { key, technicianId: owner.technicianId, actorId: owner.actorId, route, state: "IN_PROGRESS" },
          });
          break;
        } catch (err) {
          if (!isUniqueViolation(err) || attempt >= MAX_CLAIM_ATTEMPTS - 1) throw err;
          const existing = await tp.idempotencyRecord.findUnique({ where: { key } });
          if (!existing) continue; // released between our insert and our read: claim again
          if ((existing.technicianId ?? null) !== (owner.technicianId ?? null) || (existing.actorId ?? null) !== (owner.actorId ?? null)) {
            res.status(403).json({ error: "Idempotency key belongs to another user", code: "IDEMPOTENCY_KEY_CONFLICT" });
            return;
          }
          if (existing.route !== route) {
            res.status(409).json({ error: "Idempotency key was already used for a different request", code: "IDEMPOTENCY_KEY_REUSED" });
            return;
          }
          if (existing.state === "DONE") {
            res.setHeader("Idempotent-Replay", "true");
            res.status(existing.responseStatus as number).json(existing.responseBody);
            return;
          }
          const staleBefore = new Date(Date.now() - IDEMPOTENCY_STALE_MS);
          if (existing.createdAt >= staleBefore) {
            res.setHeader("Retry-After", "1");
            res.status(409).json({ error: "A request with this idempotency key is still being processed", code: "IDEMPOTENCY_IN_PROGRESS" });
            return;
          }
          await tp.idempotencyRecord.deleteMany({ where: { key, state: "IN_PROGRESS", createdAt: { lt: staleBefore } } });
        }
      }

      // We own the key. Capture the handler's JSON response; persist (2xx) or release before sending.
      let settled = false;
      const release = async () => {
        try {
          await tp.idempotencyRecord.deleteMany({ where: { key } });
        } catch (err) {
          console.error("[idempotency] failed to release key:", err);
        }
      };
      const originalJson = res.json.bind(res);
      res.json = ((body: unknown) => {
        if (settled) return res; // a second call, or the client already went away: the first response wins
        settled = true;
        const work =
          res.statusCode >= 200 && res.statusCode < 300
            ? tp.idempotencyRecord
                .update({
                  where: { key },
                  data: {
                    state: "DONE",
                    responseStatus: res.statusCode,
                    responseBody: JSON.parse(JSON.stringify(body)) as Prisma.InputJsonValue,
                  },
                })
                .then(
                  () => undefined,
                  async (err: unknown) => {
                    console.error("[idempotency] failed to store response:", err);
                    await release();
                  }
                )
            : release();
        void work.finally(() => originalJson(body));
        return res;
      }) as Response["json"];
      // A response that never goes through res.json (204, a stream, a dropped connection) must not leave the key locked.
      res.on("close", () => {
        if (!settled) {
          settled = true;
          void release();
        }
      });

      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Admin writes: optional `Idempotency-Key` (or `X-Idempotency-Key`); keys are namespaced per profile. */
export function adminIdempotency(): RequestHandler {
  return createIdempotency({
    headers: ["idempotency-key", "x-idempotency-key"],
    owner: (req) => ({ actorId: req.profile!.id }),
    storageKey: (req, clientKey) => `admin:${req.profile!.id}:${clientKey}`,
  });
}

/** Applies `mw` to POST requests only (for routers where every write should be idempotent-capable). */
export function onlyPosts(mw: RequestHandler): RequestHandler {
  return (req, res, next) => (req.method === "POST" ? mw(req, res, next) : next());
}
