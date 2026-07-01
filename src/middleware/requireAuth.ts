import { NextFunction, Request, Response } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";

// The authenticated user derived from a verified Supabase JWT.
export interface AuthUser {
  supabaseUserId: string;
  email: string;
  role: string;
}

// Augment Express's Request so req.user is typed across the app.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

// Verifies the `Authorization: Bearer <token>` header against the Supabase JWT
// secret (HS256, symmetric). On success attaches req.user and calls next();
// on missing/invalid token returns 401.
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = header.slice("Bearer ".length).trim();

  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    // Server misconfiguration, not an auth failure — don't mask it as 401.
    console.error("SUPABASE_JWT_SECRET is not set");
    return res.status(500).json({ error: "Auth is not configured" });
  }

  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ["HS256"],
    }) as JwtPayload;

    req.user = {
      supabaseUserId: String(payload.sub ?? ""),
      email: typeof payload.email === "string" ? payload.email : "",
      role: typeof payload.role === "string" ? payload.role : "",
    };
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
