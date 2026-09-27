CREATE TABLE "QuestionnaireAnswer" (
  "id" TEXT NOT NULL,
  "questionnaireId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "playerId" TEXT NOT NULL,
  "selectedIndex" INTEGER NOT NULL,
  "correct" BOOLEAN NOT NULL,
  "points" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "QuestionnaireAnswer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuestionnaireAnswer_questionnaireId_fkey" FOREIGN KEY ("questionnaireId") REFERENCES "Questionnaire"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuestionnaireAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuestionnaireAnswer_playerId_fkey" FOREIGN KEY ("playerId") REFERENCES "Player"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "QuestionnaireAnswer_questionnaireId_questionId_playerId_key" ON "QuestionnaireAnswer"("questionnaireId", "questionId", "playerId");
CREATE INDEX "QuestionnaireAnswer_questionnaireId_playerId_idx" ON "QuestionnaireAnswer"("questionnaireId", "playerId");
