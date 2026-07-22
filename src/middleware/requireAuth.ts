import { NextFunction, Request, Response } from "express";
import jwt, { JwtHeader, JwtPayload, SigningKeyCallback } from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import type { Profile } from "@prisma/client";

// The authenticated user derived from a verified Supabase JWT.
// Role is intentionally absent — Supabase's JWT role claim is always
// "authenticated" (useless for authorisation). The app role (ADMIN/MANAGER/
// TECHNICIAN) is read from Profile.role via requireTenantAccess on every request.
export interface AuthUser {
  supabaseUserId: string;
  email: string;
}

// Augment Express's Request so req.user (set by requireAuth) and req.profile
// (set by requireRole) are typed across the app.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      profile?: Profile;
    }
  }
}

// The Supabase project's auth issuer (the `iss` claim on its JWTs, and the base
// of the JWKS endpoint). Kept as a single constant so it's easy to find/change
// when the project moves — used for both JWKS fetch and issuer verification.
const SUPABASE_ISSUER = "https://cixtfdnuwbmxvilkvihv.supabase.co/auth/v1";

// Supabase signs auth JWTs with ES256 (asymmetric, ECC P-256). We fetch the
// public verification keys from the project's JWKS endpoint and cache them, so
// no shared secret is stored on the backend.
const jwks = jwksClient({
  jwksUri: `${SUPABASE_ISSUER}/.well-known/jwks.json`,
  cache: true,
  cacheMaxAge: 10 * 60 * 60 * 1000, // 10 hours
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

// Resolve the public signing key for the token's `kid` (used by jwt.verify).
function getKey(header: JwtHeader, callback: SigningKeyCallback) {
  if (!header.kid) {
    return callback(new Error("Token header missing 'kid'"));
  }
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err || !key) {
      return callback(err ?? new Error("Signing key not found"));
    }
    callback(null, key.getPublicKey());
  });
}

function verifyToken(token: string): Promise<JwtPayload> {
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        algorithms: ["ES256"],
        // Reject tokens minted for a different audience or by another Supabase
        // project (prevents cross-project token replay against this API).
        audience: "authenticated",
        issuer: SUPABASE_ISSUER,
      },
      (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          return reject(err ?? new Error("Invalid token"));
        }
        resolve(decoded);
      }
    );
  });
}

// Verifies the `Authorization: Bearer <token>` header against Supabase's JWKS
// (ES256). On success attaches req.user and calls next(); on missing/invalid
// token returns 401.
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = header.slice("Bearer ".length).trim();

  try {
    const payload = await verifyToken(token);
    // A token without a subject cannot identify a user — reject rather than
    // continue with an empty-string user id.
    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    if (!sub) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.user = {
      supabaseUserId: sub,
      email: typeof payload.email === "string" ? payload.email : "",
    };
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}
