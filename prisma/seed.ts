// Seed is pending a rewrite for schema-per-tenant.
// The old seed wrote directly to public-schema singleton tables
// (BusinessSettings, Technician, ServiceArea, Round) which have moved
// to per-tenant schemas. A new seed will provision a Tenant + Profile
// via POST /auth/signup and then write operational rows to the tenant schema.
