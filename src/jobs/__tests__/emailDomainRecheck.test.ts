import { beforeEach, describe, expect, it, vi } from "vitest";

const tenantFindMany = vi.fn();
vi.mock("../../lib/prisma", () => ({ prisma: { tenant: { findMany: (...a: unknown[]) => tenantFindMany(...a) } } }));
const clients: Record<string, any> = {};
vi.mock("../../lib/tenant-prisma-manager", () => ({ getTenantPrismaForSchema: (s: string) => clients[s] }));
const status = vi.fn();
vi.mock("../../services/email-domain.service", () => ({ createEmailDomainService: () => ({ status: (...a: unknown[]) => status(...a) }) }));

import { runEmailDomainRecheck } from "../emailDomainRecheck";

const tp = (s: string | null) => ({ businessSettings: { findFirst: vi.fn().mockResolvedValue(s === null ? null : { emailDomainStatus: s }) } });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SES_REGION = "eu-west-2";
  process.env.SES_FROM_DOMAIN_ADDRESS = "n@mail.roundflow.ai";
  delete process.env.EMAIL_DISABLED;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  status.mockResolvedValue({});
});

describe("runEmailDomainRecheck", () => {
  it("does nothing when SES is not configured", async () => {
    delete process.env.SES_REGION;
    expect(await runEmailDomainRecheck()).toEqual({ checked: 0, failed: 0 });
    expect(tenantFindMany).not.toHaveBeenCalled();
  });
  it("re-checks tenants with a domain (PENDING, VERIFIED, FAILED) and skips NONE / no settings", async () => {
    tenantFindMany.mockResolvedValue(["a", "b", "c", "d", "e"].map((n) => ({ schemaName: `t_${n}` })));
    Object.assign(clients, { t_a: tp("PENDING"), t_b: tp("VERIFIED"), t_c: tp("FAILED"), t_d: tp("NONE"), t_e: tp(null) });
    expect(await runEmailDomainRecheck()).toEqual({ checked: 3, failed: 0 });
    expect(status).toHaveBeenCalledTimes(3);
  });
  it("one tenant failing does not stop the rest", async () => {
    tenantFindMany.mockResolvedValue([{ schemaName: "t_a" }, { schemaName: "t_b" }]);
    Object.assign(clients, { t_a: tp("PENDING"), t_b: tp("PENDING") });
    status.mockRejectedValueOnce(new Error("ses down")).mockResolvedValueOnce({});
    expect(await runEmailDomainRecheck()).toEqual({ checked: 1, failed: 1 });
    expect(console.error).toHaveBeenCalled();
  });
});
