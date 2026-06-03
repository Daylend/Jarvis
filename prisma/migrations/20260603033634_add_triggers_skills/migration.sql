-- CreateTable
CREATE TABLE "Skill" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ownerId" TEXT NOT NULL,
    "guildId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "playbook" TEXT NOT NULL,
    "autoStart" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Trigger" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "ownerId" TEXT NOT NULL,
    "guildId" TEXT,
    "channelId" TEXT,
    "skillId" INTEGER,
    "type" TEXT NOT NULL,
    "label" TEXT,
    "instruction" TEXT NOT NULL,
    "fireAt" DATETIME,
    "repeatSeconds" INTEGER,
    "phrases" TEXT,
    "speakers" TEXT NOT NULL DEFAULT 'anyone',
    "cooldownSeconds" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "oneShot" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastFiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Trigger_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "Skill" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Skill_ownerId_name_key" ON "Skill"("ownerId", "name");

-- CreateIndex
CREATE INDEX "Trigger_type_status_idx" ON "Trigger"("type", "status");

-- CreateIndex
CREATE INDEX "Trigger_ownerId_status_idx" ON "Trigger"("ownerId", "status");
