-- Domestic-only mandate: flag international opportunities so they can be
-- excluded from the default Grant Intel feed (and skipped during matching).
-- Defaults to true so existing rows remain visible until re-evaluated.
alter table grants add column if not exists is_domestic boolean not null default true;

create index if not exists grants_is_domestic_idx on grants(is_domestic);

-- One-time backfill: flag already-ingested international opportunities so they
-- drop out of the default feed. Mirrors the looksInternational() heuristic in
-- lib/grants/engine.ts. Safe to re-run.
update grants
set is_domestic = false
where (coalesce(funder, '') || ' ' || coalesce(title, '')) ilike any (array[
  '%u.s. mission%', '%u.s. embassy%', '%u.s. consulate%', '%american embassy%',
  '%usaid%', '%agency for international development%',
  '%bureau of african affairs%', '%bureau of near eastern affairs%',
  '%bureau of east asian%', '%bureau of south and central asian%',
  '%bureau of western hemisphere affairs%', '%bureau of european and eurasian%',
  '%bureau of international%', '%bureau of democracy, human rights%',
  '%bureau of population, refugees%', '%bureau of oceans and international%',
  '%global health center%', '%-ghc%', '%global aids%', '%office of global%',
  '%overseas%', '%foreign assistance%'
]);
