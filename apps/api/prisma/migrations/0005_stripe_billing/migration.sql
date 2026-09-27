ALTER TABLE "Tenant" ADD COLUMN "stripeCustomerId" TEXT;
CREATE UNIQUE INDEX "Tenant_stripeCustomerId_key" ON "Tenant"("stripeCustomerId");
