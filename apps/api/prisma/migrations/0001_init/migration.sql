CREATE TYPE "TenantStatus" AS ENUM ('ACTIVE', 'SUSPENDED');
CREATE TYPE "MatchStatus" AS ENUM ('WAITING', 'RUNNING', 'FINISHED', 'CANCELLED');
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MANAGER', 'OPERATOR');
CREATE TYPE "TenantPlan" AS ENUM ('FREE_TRIAL', 'STARTER_10', 'GROWTH_25', 'UNLIMITED', 'RESORTS');

CREATE TABLE "Tenant" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "plan" "TenantPlan" NOT NULL DEFAULT 'FREE_TRIAL',
  "status" "TenantStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "trialEndsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

CREATE TABLE "TenantSettings" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "primaryHex" TEXT NOT NULL DEFAULT '#f4b942',
  "logoUrl" TEXT,
  "displayName" TEXT,
  CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TenantSettings_tenantId_key" UNIQUE ("tenantId"),
  CONSTRAINT "TenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "Device" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "lastSeenAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Device_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Device_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "Device_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Device_tenantId_idx" ON "Device"("tenantId");

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "UserRole" NOT NULL DEFAULT 'OPERATOR',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");
CREATE INDEX "User_email_idx" ON "User"("email");

CREATE TABLE "Player" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "nickname" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Player_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Player_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Player_tenantId_nickname_idx" ON "Player"("tenantId", "nickname");

CREATE TABLE "Match" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "deviceId" TEXT,
  "code" TEXT NOT NULL,
  "gameKey" TEXT NOT NULL DEFAULT 'burger-rush',
  "maxPlayers" INTEGER NOT NULL DEFAULT 8,
  "durationSeconds" INTEGER NOT NULL DEFAULT 180,
  "stateJson" JSONB,
  "status" "MatchStatus" NOT NULL DEFAULT 'WAITING',
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Match_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Match_code_key" UNIQUE ("code"),
  CONSTRAINT "Match_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Match_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Match_tenantId_status_idx" ON "Match"("tenantId", "status");

CREATE TABLE "MatchPlayer" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "seat" INTEGER NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MatchPlayer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MatchPlayer_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MatchPlayer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MatchPlayer_matchId_playerId_key" ON "MatchPlayer"("matchId", "playerId");
CREATE UNIQUE INDEX "MatchPlayer_matchId_seat_key" ON "MatchPlayer"("matchId", "seat");

CREATE TABLE "PlayerSession" (
  "id" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlayerSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PlayerSession_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "PlayerSession_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PlayerSession_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PlayerSession_matchId_expiresAt_idx" ON "PlayerSession"("matchId", "expiresAt");
CREATE INDEX "PlayerSession_playerId_expiresAt_idx" ON "PlayerSession"("playerId", "expiresAt");

CREATE TABLE "ScoreEvent" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "matchId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScoreEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ScoreEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ScoreEvent_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ScoreEvent_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ScoreEvent_tenantId_createdAt_idx" ON "ScoreEvent"("tenantId", "createdAt");
CREATE INDEX "ScoreEvent_tenantId_playerId_createdAt_idx" ON "ScoreEvent"("tenantId", "playerId", "createdAt");
