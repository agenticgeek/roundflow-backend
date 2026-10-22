import { it, expect, vi } from "vitest";
import { seedTenantDefaults, DEFAULT_SERVICES, DEFAULT_MESSAGE_TEMPLATES } from "../tenant-defaults";

function makePrisma(overrides: { serviceCount?: number; templateCount?: number } = {}) {
  return {
    service: {
      count: vi.fn().mockResolvedValue(overrides.serviceCount ?? 0),
      createMany: vi.fn().mockResolvedValue({ count: DEFAULT_SERVICES.length }),
    },
    messageTemplate: {
      count: vi.fn().mockResolvedValue(overrides.templateCount ?? 0),
      createMany: vi.fn().mockResolvedValue({ count: DEFAULT_MESSAGE_TEMPLATES.length }),
    },
  } as unknown as Parameters<typeof seedTenantDefaults>[0];
}

it("seeds both tables when the tenant schema is empty", async () => {
  const prisma = makePrisma();

  await seedTenantDefaults(prisma);

  expect(prisma.service.createMany).toHaveBeenCalledWith({
    data: DEFAULT_SERVICES.map((s) => ({ ...s })),
  });
  expect(prisma.messageTemplate.createMany).toHaveBeenCalledWith({
    data: DEFAULT_MESSAGE_TEMPLATES.map((t) => ({ ...t })),
  });
});

it("skips seeding Services when the tenant already has at least one", async () => {
  const prisma = makePrisma({ serviceCount: 3 });

  await seedTenantDefaults(prisma);

  expect(prisma.service.createMany).not.toHaveBeenCalled();
  expect(prisma.messageTemplate.createMany).toHaveBeenCalled();
});

it("skips seeding MessageTemplates when the tenant already has at least one", async () => {
  const prisma = makePrisma({ templateCount: 5 });

  await seedTenantDefaults(prisma);

  expect(prisma.messageTemplate.createMany).not.toHaveBeenCalled();
  expect(prisma.service.createMany).toHaveBeenCalled();
});

it("writes nothing when the tenant already has both", async () => {
  const prisma = makePrisma({ serviceCount: 1, templateCount: 1 });

  await seedTenantDefaults(prisma);

  expect(prisma.service.createMany).not.toHaveBeenCalled();
  expect(prisma.messageTemplate.createMany).not.toHaveBeenCalled();
});
