import {
  PrismaClient,
  UserRole,
  RoundStatus,
  DayOfWeek,
  CleaningFrequency,
} from "@prisma/client";

const prisma = new PrismaClient();

// Minimal seed: enough rows to boot the app and render the Round Planner
// without empty-state errors. Uses fixed IDs + upserts so it is idempotent
// (safe to re-run). Auth identity now lives in Supabase Auth — we seed a
// Profile (the public-schema mirror of auth.users), not a password.
async function main() {
  // 1. BusinessSettings — the single config row (DB-guarded via uniqueId).
  const settings = await prisma.businessSettings.upsert({
    where: { uniqueId: "singleton" },
    update: {},
    create: {
      uniqueId: "singleton",
      businessName: "RoundFlow Demo Co",
      phone: "+44 1665 000000",
      email: "hello@roundflow.test",
      vatRegistered: false,
      defaultWorkingDays: ["MON", "TUE", "WED", "THU", "FRI"],
      timezone: "Europe/London",
      currency: "GBP",
      defaultCycleLength: 28, // days (4-week cycle)
      bankDetails: { sortCode: "00-00-00", accountNumber: "00000000" },
    },
  });

  // 2. One ADMIN Profile.
  //    DEV-ONLY: supabaseUserId is a placeholder — there is no matching
  //    auth.users row yet. Replace it with the real Supabase user id once an
  //    admin signs up through Supabase Auth. Do not ship this seed to prod.
  const adminProfile = await prisma.profile.upsert({
    where: { supabaseUserId: "dev-placeholder-admin-no-supabase-user" },
    update: {},
    create: {
      supabaseUserId: "dev-placeholder-admin-no-supabase-user",
      role: UserRole.ADMIN,
      name: "Admin User",
    },
  });

  // 3. One Technician linked to the admin Profile.
  //    Boot convenience only: a real technician gets its OWN Profile (role
  //    TECHNICIAN). We reuse the admin profile here so the Round below stays
  //    assigned to a technician for local development.
  const technician = await prisma.technician.upsert({
    where: { id: "seed-tech-1" },
    update: {},
    create: {
      id: "seed-tech-1",
      profileId: adminProfile.id,
      role: "Senior",
      phone: "+44 7700 900000",
      active: true,
    },
  });

  // 4. Two service areas.
  const alnwick = await prisma.serviceArea.upsert({
    where: { id: "seed-area-alnwick" },
    update: {},
    create: {
      id: "seed-area-alnwick",
      name: "Alnwick",
      postcodeSector: "NE66",
      isDefault: true,
    },
  });
  const morpeth = await prisma.serviceArea.upsert({
    where: { id: "seed-area-morpeth" },
    update: {},
    create: {
      id: "seed-area-morpeth",
      name: "Morpeth",
      postcodeSector: "NE61",
      isDefault: false,
    },
  });

  // 5. One DRAFT round in Alnwick, assigned to the seed technician.
  const round = await prisma.round.upsert({
    where: { id: "seed-round-1" },
    update: {},
    create: {
      id: "seed-round-1",
      name: "Alnwick Monday",
      defaultDay: DayOfWeek.MON,
      frequency: CleaningFrequency.FOUR_WEEKLY,
      description: "Seed round for local development.",
      status: RoundStatus.DRAFT,
      serviceAreaId: alnwick.id,
      technicianId: technician.id,
    },
  });

  console.log("Seed complete:");
  console.table({
    businessSettings: settings.uniqueId,
    adminProfile: `${adminProfile.name} [${adminProfile.role}] (supabaseUserId ${adminProfile.supabaseUserId})`,
    technician: `${technician.id} (profileId ${technician.profileId})`,
    serviceAreas: `${alnwick.name}, ${morpeth.name}`,
    round: `${round.name} [${round.status}]`,
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
