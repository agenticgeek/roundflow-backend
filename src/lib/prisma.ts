import { PrismaClient } from "@prisma/client";

// Shared Prisma client singleton.
//
// Prisma 6 reads DATABASE_URL (and directUrl for migrations) from the env
// automatically via the datasource block in schema.prisma. We cache the
// instance on globalThis so that dev hot-reload (tsx watch, nodemon) doesn't
// open a new connection pool on every reload and exhaust Postgres connections.
const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
