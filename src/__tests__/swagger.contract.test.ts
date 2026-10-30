import { describe, it, expect } from "vitest";
import { createApp, buildPathMethodMap, findBlockingEntry } from "../server/bootstrap";
import { openApiDocument, resolveServers } from "../swagger";

// Contract test: every route the Express app registers is documented in the
// OpenAPI spec with that method, every documented operation is served, and
// the spec-driven 405 pre-filter (src/server/bootstrap.ts) never blocks a
// method the code actually serves. Building the app touches no DB/network.

interface Layer {
  route?: { path: string; methods: Record<string, boolean> };
  regexp: RegExp;
  handle: { stack?: Layer[] };
}

// Express 4 mount regexps look like /^\/settings\/kpi-thresholds\/?(?=\/|$)/i.
function mountPrefix(re: RegExp): string {
  return re.source
    .replace(/^\^/, "")
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, "")
    .replace(/\\\//g, "/");
}

function collectRoutes(stack: Layer[], prefix: string, out: Set<string>): Set<string> {
  for (const layer of stack) {
    if (layer.route) {
      const path = prefix + (layer.route.path === "/" ? "" : layer.route.path);
      for (const method of Object.keys(layer.route.methods)) out.add(`${method.toUpperCase()} ${path}`);
    } else if (layer.handle.stack) {
      collectRoutes(layer.handle.stack, prefix + mountPrefix(layer.regexp), out);
    }
  }
  return out;
}

// Served but intentionally not part of the API contract.
const UNDOCUMENTED = new Set(["GET /openapi.json"]);
const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

// :id / {id} → {} so parameter names don't have to match between code and spec.
const normalise = (route: string) => route.replace(/:\w+/g, "{}").replace(/\{[^}]+\}/g, "{}");

const app = createApp({ allowedOrigins: [], readiness: { ready: true } });
const registered = [
  ...collectRoutes((app as unknown as { _router: { stack: Layer[] } })._router.stack, "", new Set()),
].filter((r) => !UNDOCUMENTED.has(r));

const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;
const documented = Object.entries(paths)
  .filter(([p]) => !p.startsWith("/auth/v1/")) // Supabase-hosted, not served here
  .flatMap(([p, item]) => Object.keys(item).filter((k) => HTTP_METHODS.has(k)).map((m) => `${m.toUpperCase()} ${p}`));

describe("OpenAPI contract", () => {
  it("derives mount prefixes from Express mount regexps", () => {
    expect(mountPrefix(/^\/settings\/kpi-thresholds\/?(?=\/|$)/i)).toBe("/settings/kpi-thresholds");
    expect(registered).toContain("GET /settings/kpi-thresholds");
    expect(registered).toContain("PATCH /mobile/visits/:id/complete");
  });

  it("documents every registered route with its method", () => {
    const docSet = new Set(documented.map(normalise));
    expect(registered.filter((r) => !docSet.has(normalise(r))).sort()).toEqual([]);
  });

  it("serves every documented operation", () => {
    const routeSet = new Set(registered.map(normalise));
    expect(documented.filter((d) => !routeSet.has(normalise(d))).sort()).toEqual([]);
  });

  it("the 405 pre-filter never blocks a registered method", () => {
    const map = buildPathMethodMap(paths);
    const blocked = registered.filter((r) => {
      const [method, path] = r.split(" ");
      return findBlockingEntry(map, method, path.replace(/:\w+/g, "sample-id")) !== undefined;
    });
    expect(blocked).toEqual([]);
  });

  it("resolves Swagger servers from PUBLIC_API_URL, then RAILWAY_PUBLIC_DOMAIN, else localhost only", () => {
    const local = { url: "http://localhost:3000", description: "Local dev" };
    expect(resolveServers({ PUBLIC_API_URL: "https://api.x" })).toEqual([{ url: "https://api.x", description: "Deployed" }, local]);
    expect(resolveServers({ RAILWAY_PUBLIC_DOMAIN: "rf.up.railway.app" })[0].url).toBe("https://rf.up.railway.app");
    expect(resolveServers({})).toEqual([local]);
  });
});
