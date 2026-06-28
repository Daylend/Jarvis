-- Drop STT hallucinations: "Jean-Paul" is a frequent Whisper/Granite phantom
-- output during silence/noise. Remove any persisted transcript rows that
-- contain it (case-insensitive). SQLite LIKE is case-insensitive for ASCII by
-- default, so a single pattern covers "Jean-Paul", "jean-paul", etc.

DELETE FROM "Transcript"
WHERE "textRaw" LIKE '%Jean-Paul%'
   OR "textNormalized" LIKE '%Jean-Paul%';
