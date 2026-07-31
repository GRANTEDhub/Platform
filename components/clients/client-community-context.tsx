import { Card } from "@/components/ui/card";
import { formatIncome, type Availability, type CommunityView } from "@/lib/clients/community";

// Community context — the rail's standing reference: where this org sits, what the
// community's median household income is, and whether the address falls inside a
// federal shortage area.
//
// All of it is READ from client_profile.community_context, which lib/geo/census.ts and
// lib/geo/hrsa.ts already populate at intake / refresh. Until now that data only fed
// the LLM enrichment narrative; nothing rendered it, so an account manager could not
// see the need signals their own outreach was citing.
//
// THE MAP TILE IS TEXTURE, NOT CARTOGRAPHY. /map-bg.jpg is the same photo behind the
// Grant Report's hero band, treated the same way (desaturated under a navy wash), and
// it is aria-hidden decoration. The caption over it is a TEXT LABEL of the client's
// stored county/state — it is not a claim that the image depicts that county, and
// nothing here should be reworded to imply that it does. The location fact lives in
// the text; the photo is the surface it sits on.

export function ClientCommunityContext({ view }: { view: CommunityView }) {
  const { placeLabel, income, shortage, vintage, unpulled } = view;

  return (
    <Card className="overflow-hidden shadow-grounded">
      {placeLabel && (
        <div className="relative h-[76px]">
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              backgroundImage: "url('/map-bg.jpg')",
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "grayscale(0.35)",
            }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{ background: "linear-gradient(120deg, rgba(8,22,39,0.88), rgba(11,30,58,0.68))" }}
          />
          <div className="relative flex h-full flex-col justify-end px-6 pb-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.1em] text-white/60">Community context</p>
            <p className="truncate font-serif text-[16px] font-semibold text-white">{placeLabel}</p>
          </div>
        </div>
      )}

      <div className="p-6 sm:p-7">
        {/* No location at all: the tile is dropped above, so the card still needs its
            own heading here. */}
        {!placeLabel && (
          <h2 className="mb-4 font-serif text-[20px] font-semibold text-brand-navy">Community context</h2>
        )}

        {unpulled ? (
          // ONE line, not three unchecked rows -- there is a single fact ("this has not
          // been pulled"), and stating it three times would read as three problems.
          <p className="text-sm text-muted-foreground">
            Community data hasn&rsquo;t been pulled for this record yet.
          </p>
        ) : (
          <dl className="space-y-4">
            <Row
              label="Median household income"
              state={income.state}
              value={income.amount != null ? formatIncome(income.amount) : null}
              note={
                income.geographyName
                  ? `${income.geographyName}${vintage ? ` · ACS ${vintage}` : ""}`
                  : vintage
                    ? `ACS ${vintage}`
                    : null
              }
              noneNote="ACS did not publish a median for this geography."
              uncheckedNote="Location did not resolve to a Census geography."
            />

            <Row
              label="Federal shortage area"
              state={shortage.state}
              value={shortage.lines.length > 0 ? shortage.lines : null}
              note="HRSA, at the org's address"
              // A real negative, and said as one -- the address WAS tested.
              noneNote="Address is not in a designated shortage area."
              // HRSA needs a street address to geocode to a tract, so this gap is
              // fixable and named rather than shown as a negative result.
              uncheckedNote="Needs a street address on the profile to check."
            />
          </dl>
        )}
      </div>
    </Card>
  );
}

function Row({
  label,
  state,
  value,
  note,
  noneNote,
  uncheckedNote,
}: {
  label: string;
  state: Availability;
  value: string | string[] | null;
  note: string | null;
  noneNote: string;
  uncheckedNote: string;
}) {
  const values = value == null ? [] : Array.isArray(value) ? value : [value];
  return (
    <div>
      <dt className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-subtle">{label}</dt>
      <dd className="mt-1">
        {state === "value" ? (
          <>
            {values.map((v, i) => (
              <p
                key={i}
                className={
                  i === 0
                    ? "text-[19px] font-semibold leading-tight text-brand-navy"
                    : "mt-0.5 text-[12.5px] text-ink-muted"
                }
              >
                {v}
              </p>
            ))}
            {note && <p className="mt-1 text-[11.5px] text-ink-subtle">{note}</p>}
          </>
        ) : (
          <p className="text-[12.5px] text-muted-foreground">
            {state === "none" ? noneNote : uncheckedNote}
          </p>
        )}
      </dd>
    </div>
  );
}
