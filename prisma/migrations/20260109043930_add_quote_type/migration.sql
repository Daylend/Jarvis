-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Quote" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "text" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'funny',
    "addedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Quote" ("addedBy", "createdAt", "id", "text") SELECT "addedBy", "createdAt", "id", "text" FROM "Quote";
DROP TABLE "Quote";
ALTER TABLE "new_Quote" RENAME TO "Quote";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
