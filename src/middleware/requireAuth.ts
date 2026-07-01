import { NextFunction, Request, Response } from "express";
import jwt, { JwtHeader, JwtPayload, SigningKeyCallback } from "jsonwebtoken";
import jwksClient from "jwks-rsa";

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

// Supabase signs auth JWTs with ES256 (asymmetric, ECC P-256). We fetch the
// public verification keys from the project's JWKS endpoint and cache them, so
// no shared secret is stored on the backend.
const jwks = jwksClient({
  jwksUri:
    "https://cixtfdnuwbmxvilkvihv.supabase.co/auth/v1/.well-known/jwks.json",
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
    jwt.verify(token, getKey, { algorithms: ["ES256"] }, (err, decoded) => {
      if (err || !decoded || typeof decoded === "string") {
        return reject(err ?? new Error("Invalid token"));
      }
      resolve(decoded);
    });
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
