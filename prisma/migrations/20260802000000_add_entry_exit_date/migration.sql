-- AlterTable: split single `date` into distinct entryDate / exitDate
-- Both nullable so existing rows (which only have `date`) remain valid.
-- `date` is left untouched for backward compatibility with existing
-- sort/filter code; new imports and manual entries populate all three.
ALTER TABLE "Trade" ADD COLUMN "entryDate" TEXT;
ALTER TABLE "Trade" ADD COLUMN "exitDate" TEXT;
