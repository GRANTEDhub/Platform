import { Card } from "@/components/ui/card";
import { formatIncome, type Availability, type CommunityView } from "@/lib/clients/community";
import { INK, STAGE } from "@/lib/brand";

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

export function ClientCommunityContext({
  view,
  variant = "portal",
}: {
  view: CommunityView;
  variant?: "console" | "portal";
}) {
  const { placeLabel, income, shortage, vintage, unpulled } = view;

  if (variant === "console") return <ConsoleGeographyCard view={view} />;

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

// ── Console variant — the approved design ───────────────────────────────────
//
// "Eligibility geography": the 76px county tile over four evidence rows. THE 76px IS
// LOAD-BEARING -- the design sizes it so this rail and the left column end level at
// 1440x900 with no page scroll. Changing it means re-checking that.
//
// ALL FOUR ROWS ALWAYS RENDER, even when empty, for two reasons. One, they now come from
// two different sources: income and shortage are read from client_profile.community_context
// (a geo pull), while rurality and SAM.gov live on the client record itself -- so the
// portal card's single "not pulled yet" line would be wrong here, hiding two facts that
// may well be present. Two, a card whose height depends on how much data resolved cannot
// hold a column alignment.
//
// The scrim over the image is left as an inline gradient rather than a brand token: its
// opacities are tuned to the photograph's luminance so white caption text clears
// contrast, which is a property of the image, not a value the palette should own.
function ConsoleGeographyCard({ view }: { view: CommunityView }) {
  const { placeLabel, income, shortage, rurality, sam } = view;
  return (
    <section className="shrink-0 overflow-hidden rounded-sharp border border-edge bg-white">
      <div className="relative h-[76px]">
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundImage: "url('/map-bg.jpg')",
            backgroundSize: "cover",
            backgroundPosition: "38% 42%",
            filter: "grayscale(0.5) contrast(1.05)",
          }}
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ background: "linear-gradient(180deg, rgba(11,30,58,0.18), rgba(11,30,58,0.72))" }}
        />
        <div className="absolute bottom-3 left-[18px] right-[18px]">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.13em] text-white/60">
            Eligibility geography
          </p>
          {/* The caption is a TEXT LABEL of the client's stored county -- not a claim that
              the photograph depicts it. Do not reword this to imply otherwise. */}
          <p className="mt-[3px] truncate text-[14px] font-semibold text-white">
            {placeLabel ?? "Location not set"}
          </p>
        </div>
      </div>

      <dl className="px-[18px] pb-3 pt-2.5">
        <GeoRow
          label="Rurality (RUCC)"
          state={rurality.state}
          value={rurality.label}
          title={rurality.detail}
        />
        <GeoRow
          label="HRSA shortage area"
          state={shortage.state}
          // A real negative is a finding, not a blank: the address WAS tested against the
          // polygons and falls in none, so it says so rather than showing a dash.
          value={shortage.state === "value" ? "Qualifies" : shortage.state === "none" ? "Not designated" : null}
          dot={shortage.state === "value" ? STAGE.pursuit.color : undefined}
          valueColor={shortage.state === "value" ? STAGE.pursuit.color : undefined}
          title={shortage.lines.join(" · ") || null}
        />
        <GeoRow
          label="Median household income"
          state={income.state}
          value={income.amount != null ? formatIncome(income.amount) : null}
          title={income.geographyName}
        />
        <GeoRow
          label="SAM.gov"
          state={sam.state}
          value={sam.label}
          dot={sam.ok ? STAGE.pursuit.color : STAGE.client.color}
          // stage-client's raw hue fails contrast as small type, so its text companion is
          // used for the label while the dot keeps the true stage colour.
          valueColor={sam.ok ? STAGE.pursuit.color : STAGE.client.text}
          last
        />
      </dl>
    </section>
  );
}

function GeoRow({
  label,
  state,
  value,
  dot,
  valueColor,
  title,
  last,
}: {
  label: string;
  state: Availability;
  value: string | null;
  dot?: string;
  valueColor?: string;
  title?: string | null;
  last?: boolean;
}) {
  const resolved = state !== "unchecked" && value !== null;
  return (
    <div className={`flex items-center justify-between gap-3 py-1.5 ${last ? "" : "border-b border-hairline"}`}>
      {/* shrink-0 on the label and a cap on the value: a long rurality string ("unknown
          — verify; <county>") used to squeeze the label out of the row entirely, so the
          row lost the one word that said what the number was. The full value stays
          recoverable on hover. */}
      <dt className="shrink-0 text-[12px] text-ink-muted">{label}</dt>
      <dd
        className="flex min-w-0 max-w-[58%] items-center gap-[5px] text-[12px] font-semibold"
        style={{ color: resolved ? valueColor ?? INK.DEFAULT : INK.faint }}
        title={resolved ? [value, title].filter(Boolean).join(" · ") : undefined}
      >
        {resolved && dot && (
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: dot }} />
        )}
        <span className="truncate">{resolved ? value : "\u2014"}</span>
        {!resolved && <span className="sr-only">not available</span>}
      </dd>
    </div>
  );
}
