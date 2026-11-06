import { randomUUID } from "crypto";
import type { NextFunction, Request, Response } from "express";

// BE-09: every request gets an id, echoed in the X-Request-Id response header and in error bodies (`requestId`) so
// a user report can be matched to a log line. A well-formed incoming X-Request-Id (from a proxy / the web app) is
// kept; anything else is replaced.

export const REQUEST_ID_HEADER = "X-Request-Id";
const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestId() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.header(REQUEST_ID_HEADER);
    const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
    res.locals.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

export const getRequestId = (res: Response): string | undefined => res.locals?.requestId as string | undefined;
