// Single source of truth for GRANTED brand hex values.
//
// Every HEX consumer imports from here: the Tailwind config's brand.* tokens
// (which back all `brand-*` utilities), the contract PDF (@react-pdf can't read
// Tailwind), and the handful of inline chart/animation colors. Change a value
// here and it propagates to all of them.
//
// The semantic HSL tokens in app/globals.css mirror these (CSS cannot import TS),
// so their values are documented there with the hex they correspond to. If you
// change navy/orange/cream here, update the matching HSL comment block in
// globals.css too -- that is the one place the palette is duplicated.
export const BRAND = {
  navy: "#0B1E3A",        // primary
  navyHover: "#12305A",   // primary button hover, IntellEngine gradient end
  navyDeep: "#081627",    // darker navy for gradient ends
  // The ink direction's CHROME: the command band, both mastheads, and the IntellEngine
  // panel. A near-black with only a trace of blue, and deliberately NOT `navy`.
  //
  // Navy is a text colour first — it is INK.DEFAULT, it is on every heading and body
  // paragraph in the product — so it cannot be retuned to suit a dark surface without
  // repainting all of that. As a large dark FIELD it also reads hazy: white cards against
  // it look soft rather than crisp, which is most of what separated the first ink build
  // from the reference. Two tokens because they have two jobs.
  chrome: "#0A1420",
  orange: "#E4761F",      // accent / action
  orangeHover: "#C9631A", // orange button hover / press
  cream: "#faf7f2",       // legacy surface tint (pre-refresh cards / backgrounds)
  creamWarm: "#f4ecdf",   // warmer cream — legacy hub backdrop
  ink: "#1a1a1a",         // near-black body ink — PRINT ONLY (contract PDF)
  muted: "#5b6472",       // grey — secondary text (print)
  slate: "#334867",       // grey-navy — secondary accent (e.g. charts)
  taupe: "#c9c2b8",       // warm neutral — low-emphasis (e.g. charts)
  success: "#059669",     // status green — a functional signal, NOT the brand palette
  // Brand orange at the alpha the IntellEngine panel's radial bloom fades from. Here
  // rather than inline at the call site so the glow cannot drift into a second orange:
  // the gradient geometry belongs to the component, the COLOUR belongs to this file.
  orangeGlow: "rgba(228,118,31,0.32)",
  // Brand orange darkened until small type on a light ground is legible. #E4761F tops
  // out near 3:1 against white and worse against SURFACE.ground, so it CANNOT carry
  // 9–12px text however much the layout wants orange there. Use this for eyebrows,
  // micro-chips and urgent deadline labels on light surfaces; use `orange` for fills,
  // display figures, and anything on ink. They are not interchangeable — the pair exists
  // so "orange small text" has a right answer instead of being quietly illegible.
  orangeDeep: "#A8501A",
  // Brand orange as a FILL UNDER WHITE TEXT. The mirror of orangeDeep, one layer out:
  // orangeDeep exists because orange type on a light ground is illegible, this exists
  // because white type on an orange ground is too. White on #E4761F is 3.04:1 — every
  // primary button in the product sat there. #B85A17 takes it to 4.65:1 and is the
  // shallowest darkening that clears AA, so the buttons stay recognisably brand orange.
  //
  // NOT a replacement for `orange`. Use this ONLY where white (or cream) text sits on a
  // solid orange field: primary buttons, count badges, the active bucket pill. `orange`
  // stays the fill for anything with no text on it — bars, dials, dots, rules, ghost
  // figures, the left-edge accents — because those carry no contrast obligation and
  // darkening them would drain the accent out of the product for no gain.
  //
  // The pair is deliberately NOT `orangeHover`: that value (#C9631A, 3.97:1 under white)
  // was tuned as a press state for #E4761F and is itself below AA, so it cannot be the
  // hover for this one. `orangeFillHover` is the matching darker step.
  orangeFill: "#B85A17",
  orangeFillHover: "#9C4A12",
  // The warm accent ON INK, and the mirror image of orangeDeep — which is the part that
  // is easy to get backwards. On a light ground the accent must go DARKER to clear
  // contrast; on a dark one it must go LIGHTER. Brand orange on #0A1420 falls below AA,
  // so the verdict word on the fit-score panel is this. Same accent, opposite directions,
  // chosen by what is behind it.
  amberOnDark: "#E2B457",
  // Reject. Deliberately not `destructive` (the shadcn semantic red, tuned for
  // form-validation copy) and deliberately muted: rejecting a grant is a routine,
  // reversible call an analyst makes dozens of times a morning, not a destructive action
  // that should shout.
  reject: "#B4462F",
  // Completion green for use ON the navy IntellEngine gradient (its checklist ticks).
  // Deliberately NOT `success` (#059669): that value is tuned for dark-on-light and
  // does not clear contrast against navy, so the two are different tokens for
  // different backgrounds rather than one reused in a place it fails. The only colour
  // in the approved design that was not already in this file.
  successOnDark: "#4ADE80",
} as const;

// ── Surfaces ────────────────────────────────────────────────────────────────
// The page is a FLAT warm neutral and cards are white. There is deliberately no
// page texture: the old topo-map wash sat on top of the hierarchy, so flat white
// cards read as holes punched in the page rather than as surfaces above it.
export const SURFACE = {
  page: "#F1EEE8",   // page background — flat, no texture
  card: "#FFFFFF",   // every card
  sunken: "#FBFAF8", // inset fields inside white cards
  // The "ink" direction's page ground — a full step darker and greyer than `page`.
  // PORTFOLIO ONLY today (design/portfolio/, the v4 mockup). It is a separate token
  // rather than a new value for `page` on purpose: flipping the global ground would
  // repaint the approved client dashboard too, and that surface has not been redrawn.
  // If Design carries the ink direction across the rest of the console this collapses
  // into `page` and this token goes away.
  ground: "#E9E7E0",
} as const;

// ── Text ────────────────────────────────────────────────────────────────────
// A four-step scale, darkest to lightest.
//
// NOTE this is the SCREEN ink scale and is deliberately separate from BRAND.ink
// (#1a1a1a), which is the print ink used by the contract PDF. Different values for
// different media, so they are not folded into one token -- naming them both "ink"
// is the trap this comment exists to flag.
export const INK = {
  DEFAULT: "#0B1E3A", // primary text (= navy)
  muted: "#5B6472",   // body / secondary text
  // Labels, metadata, counts of hidden rows. Was #8A93A0, which is 3.11:1 on white and
  // failed AA at every one of the ~30 places it appears — all of them small type, which
  // is the worst case for it. #6E7683 is 4.58:1 on white: the lightest value on this hue
  // that clears the 4.5 floor, so the step between `muted` and `subtle` survives.
  //
  // It still does NOT clear AA on SURFACE.ground (3.70:1). That is by design and not a
  // gap to close by darkening further — ground-level small type uses `muted`, and the
  // ink screens already do. See the note at the top of components/clients/portfolio-browser.tsx.
  subtle: "#6E7683",
  faint: "#B0B6BF",   // placeholder text, disabled chevrons
} as const;

// ── Lines ───────────────────────────────────────────────────────────────────
// Three weights, by job. Kept as rgba rather than flattened to hex so they compose
// over both white cards and the warm page.
export const LINE = {
  hairline: "rgba(11,30,58,0.06)",       // row dividers inside cards
  hairlineStrong: "rgba(11,30,58,0.09)", // section / header bottom borders
  edge: "rgba(11,30,58,0.13)",           // secondary button + input borders
} as const;

// ── Pipeline stage scale ────────────────────────────────────────────────────
// A SEMANTIC scale, not a palette: warm at the front of the funnel, cool at the
// back, taupe at the end. Each color means exactly one stage and is used only for
// that stage -- as its dot, its tinted panel header, and its bar segment. Never as
// decoration, because a stage color appearing anywhere else makes the funnel
// unreadable.
//
// `client.text` exists because #C9962B does not clear contrast on white. Use it for
// warning-state label text; never render the raw stage color as small type. `client.deep`
// is the same job one background further down: on SURFACE.ground even `text` falls under
// the small-text floor, so the Portfolio index's deadline dates use `deep`. Two values
// because the required contrast depends on what is behind the type, which is the same
// reason BRAND.successOnDark exists.
//
// `approved.onDark` is the mirror case: the teal reversed out of the navy masthead.
// #2E7D91 on that chrome is unreadable, so the light twin is named here rather than
// invented inline.
//
// `border` is a SEPARATE token from `tint`, not a tidier way of spelling it. A tint is a
// fill covering an area; a 1px rule in the same hue disappears at that alpha, so a
// tinted panel header needs roughly double to read as an edge. Both stage headers in the
// approved design pair the two, so the pairing is named here rather than reinvented as a
// one-off rgba at each call site -- which is how a second, undocumented orange gets in.
//
// `muted` is the SAME scale desaturated, for pipeline bars on rows that need no
// attention (the Portfolio's no-action grid). It exists so a quiet client's bar still
// reads as the same funnel rather than a different chart, while receding behind the
// rows that are actually asking for something -- the alternative, reusing the live
// colours at lower opacity, would let a large taupe segment on a quiet client out-shout
// a small orange one on a client that needs work.
//
// triage / approved / passed are taken from the approved design. client and pursuit are
// DERIVED to the same lightness and chroma: the design's sample roster happened to
// contain no quiet client sitting at those two stages, so they were never drawn. If a
// future mockup specifies them, that value wins over these.
export const STAGE = {
  triage: { color: "#E4761F", tint: "rgba(228,118,31,0.07)", border: "rgba(228,118,31,0.14)", muted: "#E4C4A3" },
  client: { color: "#C9962B", tint: "rgba(201,150,43,0.14)", text: "#A87A1B", deep: "#856210", muted: "#DCC9A0" },
  approved: { color: "#2E7D91", tint: "rgba(46,125,145,0.06)", border: "rgba(46,125,145,0.13)", onDark: "#7FC4D4", muted: "#8FBAC4" },
  pursuit: { color: "#0B7A5A", tint: "rgba(11,122,90,0.10)", muted: "#A3C6B8" },
  passed: { color: "#C9C2B8", tint: "rgba(11,30,58,0.06)", muted: "#DCD6CC" },
} as const;

// THE CLIENT-FACING STAGE PALETTE. A partial override of STAGE, applied only on the portal
// (see stageTone) so the console is untouched.
//
// WHY IT DIFFERS AT ALL. STAGE's gold, teal and green are not brand colours -- they
// accumulated because five staff stages needed telling apart. On the client side there are
// only FOUR stages, every one carries a written label, and `pursuit` never renders at all
// (rollUpPortal does not use it, and their Report folds approved-and-pursuing into
// "Pursuing"). So hue is reinforcement there rather than the signal, and it can be
// brand-only:
//
//   orange  you owe something   (triage -- unchanged, and it matches the masthead's rule
//                                that the leading figure is the one that is owed)
//   navy    in motion           (client, then approved a step lighter)
//   grey    closed              (passed -- unchanged)
//
// It also fixes a real defect rather than only a taste one. STAGE.client's gold fails
// contrast as a small glyph on its own tint, which is why STAGE.client.text exists as a
// darker companion -- a workaround for a value never checked against that use. Navy is the
// darkest thing in the palette, so both of these clear it comfortably.
export const STAGE_PORTAL = {
  client: { color: "#0B1E3A", tint: "rgba(11,30,58,0.07)", border: "rgba(11,30,58,0.14)", text: "#0B1E3A" },
  approved: { color: "#3F5B7A", tint: "rgba(63,91,122,0.08)", border: "rgba(63,91,122,0.16)" },
} as const;

// A stage's presentation for one actor. Anything STAGE_PORTAL does not override falls
// through to STAGE, so triage and passed are literally the same values on both sides.
//
// `glyph` is separate from `color` because "a fill that passes on its own tint" and "a fill
// that reads as a 3px rule" are different questions. On the console it stays
// STAGE.client.text for the client stage (the rule the pipeline dots already follow).
export function stageTone(
  key: keyof typeof STAGE,
  variant: "console" | "portal" = "console",
): { color: string; tint: string; border: string; glyph: string } {
  const base = STAGE[key] as { color: string; tint: string; border?: string; text?: string };
  const over = variant === "portal" ? (STAGE_PORTAL as Record<string, typeof base | undefined>)[key] : undefined;
  const src = over ?? base;
  return {
    color: src.color,
    tint: src.tint,
    border: src.border ?? "rgba(11,30,58,0.12)",
    glyph: src.text ?? src.color,
  };
}

// ── Stage on ink ────────────────────────────────────────────────────────────
// The five stages rendered on the dark masthead — and deliberately NOT the STAGE scale.
//
// COLOUR MEANS SIGNAL, NOT CATEGORY. On the masthead, orange means "this is owed" and
// everything past it is a neutral ramp, so clearing a triage backlog literally drains
// colour off the page. Rendering each stage in its own hue would make a settled client
// as loud as a backlogged one and turn the bar into a chart nobody reads twice. Stage is
// carried by position and label; only urgency is carried by hue.
//
// NEVER BELOW .34. A swatch under roughly 3:1 on this chrome is invisible, and the swatch
// is the only thing tying a zero-count stage to its segment in the bar.
//
// THE RAMP IS MONOTONIC, brightest just past triage and fading to the end of the funnel:
// .55 → .47 → .40 → .34. The mockup drew `client` and `passed` at the same .34 — its
// sample roster had zero at the with-client stage, so the two were never adjacent and the
// collision was invisible. On a real client sitting at both, two different stages rendered
// as the same grey and the bar stopped being readable left-to-right, which is the one job
// a neutral ramp has. `client` takes the top of the ramp because it is the stage nearest
// the thing that is owed; the three behind it step down in funnel order.
//
// Stage order (triage → client → approved → pursuit → passed) is the ramp order. Adding a
// stage means re-spacing the whole ramp, not squeezing a sixth value in between two.
export const STAGE_ON_INK: Record<"triage" | "client" | "approved" | "pursuit" | "passed", string> = {
  triage: "#E4761F",
  client: "rgba(255,255,255,0.55)",
  approved: "rgba(255,255,255,0.47)",
  pursuit: "rgba(255,255,255,0.40)",
  passed: "rgba(255,255,255,0.34)",
};

// ── Rating segments ─────────────────────────────────────────────────────────
// The three-segment bars on the grant-review fit factors.
//
// RATING IS CARRIED BY HOW MANY SEGMENTS ARE FILLED, NOT BY HUE. The previous build ran
// green / gold / red side by side, which is close to worst-case for red-green colour
// blindness — the three ratings were distinguishable only by the one channel a red-green
// viewer cannot use. Counting filled segments works for everyone, and the word underneath
// says it in text as well.
//
// Exactly ONE row on a screen is allowed to light orange: the single worst factor, which
// is the thing the reviewer is being pointed at. Spreading it to every weak factor is how
// a highlight stops being a highlight.
export const RATING = {
  filled: "#8F8B82", // a filled segment on a neutral row
  empty: "#E0DCD5",  // an unfilled segment
} as const;

// ── Elevation ───────────────────────────────────────────────────────────────
// TWO steps, plus a hover state on the card step. Not three levels: `cardHover` is
// what a card does when you point at it, not a rung of its own -- nothing renders
// at that value at rest.
//
// What this replaces: cards variously used a border, a border AND a shadow, a heavy
// shadow alone, or a flat tinted fill, often on sibling elements. A card now gets a
// border or a shadow, never both.
export const ELEVATION = {
  card: "0 1px 2px rgba(11,30,58,0.05), 0 2px 6px -1px rgba(11,30,58,0.07)",
  cardHover: "0 2px 4px rgba(11,30,58,0.06), 0 6px 14px -4px rgba(11,30,58,0.10)",
  overlay: "0 8px 24px -6px rgba(11,30,58,0.18), 0 2px 6px rgba(11,30,58,0.08)",
} as const;

// ── Radius ──────────────────────────────────────────────────────────────────
// THREE values by role, plus fully-round for badges and chips. Five different radii
// on sibling elements is most of what made the console read as unfinished.
export const RADIUS = {
  control: "8px", // buttons, inputs, nav items, icon tiles
  pill: "9px",    // inline pill buttons inside card rows
  card: "14px",   // all cards
  // The ink direction's card corner — effectively square, paired with a 1px LINE.edge
  // rule and NO shadow. A fourth value rather than a re-spelling of `card`: this is a
  // different card treatment, not a different size of the same one, and the two coexist
  // while only the Portfolio has been redrawn. Same scoping note as SURFACE.ground.
  sharp: "2px",
} as const;

// ── Motion ──────────────────────────────────────────────────────────────────
// One easing curve for entrances and layout, one linear curve for spinners.
// Nothing bounces, nothing slides in from off-screen.
export const MOTION = {
  entrance: "cubic-bezier(0.16, 1, 0.3, 1)",
  hoverMs: 120,
  pressMs: 80,
  panelMs: 140,
  tweenMs: 400,
} as const;
