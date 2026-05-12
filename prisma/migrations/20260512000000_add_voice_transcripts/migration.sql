-- CreateTable
CREATE TABLE "VoiceSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "startedBy" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Transcript" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "sessionId" TEXT NOT NULL,
    "guildId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "textRaw" TEXT NOT NULL,
    "textNormalized" TEXT NOT NULL,
    "confidence" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transcript_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "VoiceSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TermAlias" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "canonical" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "VoiceSession_guildId_startedAt_idx" ON "VoiceSession"("guildId", "startedAt");

-- CreateIndex
CREATE INDEX "Transcript_sessionId_startMs_idx" ON "Transcript"("sessionId", "startMs");

-- CreateIndex
CREATE INDEX "Transcript_userId_createdAt_idx" ON "Transcript"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Transcript_channelId_createdAt_idx" ON "Transcript"("channelId", "createdAt");

-- CreateIndex
CREATE INDEX "Transcript_guildId_createdAt_idx" ON "Transcript"("guildId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TermAlias_canonical_alias_key" ON "TermAlias"("canonical", "alias");

-- CreateIndex
CREATE INDEX "TermAlias_alias_idx" ON "TermAlias"("alias");
