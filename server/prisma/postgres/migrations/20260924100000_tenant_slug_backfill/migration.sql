-- Sign-in now starts by choosing your organisation, and the search deliberately
-- skips any organisation without a slug, on the reasoning that it cannot be
-- signed into. That held while a slug was only a vanity link — but an
-- organisation created before slugs existed then became invisible to its own
-- people, who were told "we can't find that organisation" while looking at the
-- only place they have an account. Data only; no schema change.

-- 1. The readable name, where nothing else already holds it.
UPDATE "Tenant" AS t
SET slug = s.stem
FROM (
  SELECT id, left(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 38) AS stem
  FROM "Tenant"
  WHERE slug IS NULL
) AS s
WHERE t.id = s.id
  AND s.stem <> ''
  AND NOT EXISTS (SELECT 1 FROM "Tenant" o WHERE o.slug = s.stem);

-- 2. Anything still without one — two organisations whose names reduce to the
--    same text — keeps a readable stem and takes a short suffix from its id.
UPDATE "Tenant"
SET slug = left(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 30) || '-' || right(id, 6)
WHERE slug IS NULL
  AND trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')) <> '';
