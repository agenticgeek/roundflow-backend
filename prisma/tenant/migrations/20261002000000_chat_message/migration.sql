CREATE TABLE "ChatMessage" (
  "id"              TEXT        NOT NULL,
  "roundId"         TEXT        NOT NULL,
  "senderProfileId" TEXT        NOT NULL,
  "body"            TEXT,
  "type"            TEXT        NOT NULL DEFAULT 'TEXT',
  "visitId"         TEXT,
  "createdAt"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ChatMessage_roundId_fkey"
    FOREIGN KEY ("roundId") REFERENCES "Round"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ChatMessage_roundId_createdAt_idx" ON "ChatMessage"("roundId", "createdAt");
CREATE INDEX "ChatMessage_senderProfileId_idx"   ON "ChatMessage"("senderProfileId");
