-- Hand-written data migration; the schema is unchanged.
-- Every role profile used to say "jurisdiction":"IN", whatever the role's
-- region. It now follows the region (GLOBAL meaning no single jurisdiction),
-- and a role without a region is blank. Only the old hard-coded value is
-- touched, so running this twice changes nothing the second time.
-- A correlated subquery rather than UPDATE ... FROM, so
-- server/tests/roleJurisdiction.test.ts can run the same statement on SQLite.

UPDATE "RoleScorecardVersion"
SET "profileJson" = replace(
  "profileJson",
  '"jurisdiction":"IN"',
  '"jurisdiction":"' || coalesce(upper((SELECT "regionCode" FROM "Role" WHERE "Role"."id" = "RoleScorecardVersion"."roleId")), '') || '"'
)
WHERE "profileJson" LIKE '%"jurisdiction":"IN"%';
