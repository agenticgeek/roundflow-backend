import { it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Prisma } from "@prisma/client";
import { AppError } from "../app-error";
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
