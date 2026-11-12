import { it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { AppError, ValidationError } from "../app-error";
import { appErrorBody, errorHandler } from "../error-handler";

class ExtraError extends AppError {
  constructor(public readonly fields: Record<string, string>, public readonly hint?: string) {
    super(400, "bad", "BAD");
    this.name = "ExtraError";
  }
}

function appThrowing(err: unknown) {
  const app = express();
  app.use(express.json());
  app.all("/", () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

it("appErrorBody: error only, code when set, extra own fields (undefined skipped), never stack/name", () => {
  expect(appErrorBody(new AppError(404, "nope"))).toEqual({ error: "nope" });
  expect(appErrorBody(new AppError(409, "dup", "DUP"))).toEqual({ error: "dup", code: "DUP" });
  expect(appErrorBody(new ExtraError({ a: "x" }))).toEqual({ error: "bad", code: "BAD", fields: { a: "x" } });
  expect(appErrorBody(new ExtraError({}, "h"))).toEqual({ error: "bad", code: "BAD", fields: {}, hint: "h" });
});

it("maps AppError to its status + body", async () => {
  const res = await request(appThrowing(new ExtraError({ p1: "x" }))).get("/");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "bad", code: "BAD", fields: { p1: "x" } });
});

it("maps body-parser SyntaxError to 400", async () => {
  const res = await request(appThrowing(new Error("unused"))).post("/").set("Content-Type", "application/json").send("{x");
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ error: "Invalid JSON in request body." });
});

it("maps Prisma P2003 to 409", async () => {
  const err = new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "x" });
  const res = await request(appThrowing(err)).get("/");
  expect(res.status).toBe(409);
});

it("maps anything else (incl. a plain SyntaxError and other Prisma codes) to 500", async () => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const err of [
    new Error("x"),
    new SyntaxError("x"),
    new Prisma.PrismaClientKnownRequestError("x", { code: "P2002", clientVersion: "x" }),
  ]) {
    const res = await request(appThrowing(err)).get("/");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal Server Error" });
  }
  spy.mockRestore();
});

// ---- Wave 2B-1: requestId, fields[], 413 (BE-09 / BE-13 foundation) ----
import { requestId } from "../request-id";

function appWithRequestId(err: unknown) {
  const app = express();
  app.use(requestId());
  app.use(express.json({ limit: "10b" }));
  app.all("/", () => {
    throw err;
  });
  app.use(errorHandler);
  return app;
}

it("ValidationError carries a fields[] array into the body", async () => {
  const fields = [{ path: "email", code: "INVALID_EMAIL", message: "Invalid email" }];
  expect(appErrorBody(new ValidationError("bad", fields))).toEqual({
    error: "bad",
    code: "VALIDATION_FAILED",
    fields,
  });
  const res = await request(appWithRequestId(new ValidationError("bad", fields, "CUSTOM_CODE"))).get("/");
  expect(res.status).toBe(400);
  expect(res.body).toMatchObject({ code: "CUSTOM_CODE", fields });
});

it("includes requestId (matching the header) on AppError, JSON, FK, DB and 500 responses", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fk = new Prisma.PrismaClientKnownRequestError("fk", { code: "P2003", clientVersion: "x" });
  const dbDown = Object.assign(new Error("down"), { name: "PrismaClientInitializationError" });
  for (const err of [new AppError(404, "nope"), fk, dbDown, new Error("boom")]) {
    const res = await request(appWithRequestId(err)).get("/");
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  }
  const bad = await request(appWithRequestId(new Error("x"))).post("/").set("Content-Type", "application/json").send("{x");
  expect(bad.status).toBe(400);
  expect(bad.body.requestId).toBe(bad.headers["x-request-id"]);
});

it("maps an oversized JSON body to 413 PAYLOAD_TOO_LARGE", async () => {
  const res = await request(appWithRequestId(new Error("unused")))
    .post("/")
    .set("Content-Type", "application/json")
    .send(JSON.stringify({ a: "x".repeat(100) }));
  expect(res.status).toBe(413);
  expect(res.body).toMatchObject({ error: "Request body is too large.", code: "PAYLOAD_TOO_LARGE" });
  expect(res.body.requestId).toBe(res.headers["x-request-id"]);
});
