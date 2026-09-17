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
  navy: "#0C121F",        // primary — 2026 handoff: a cooler, less-saturated near-black (was #0B1E3A)
  navyHover: "#1C2740",   // primary button hover, IntellEngine gradient end
  navyDeep: "#070B14",    // darker navy for gradient ends
  // The ink direction's CHROME: the command band, both mastheads, and the IntellEngine
  // panel. A near-black with only a trace of blue, and historically distinct from `navy`.
  //
  // The 2026 refresh pulled `navy` itself down to a cooler near-black (#0C121F), so the
  // old reason chrome existed — the mid-navy #0B1E3A read hazy as a large dark FIELD, and
  // white cards on it looked soft rather than crisp — is largely gone: the new navy is
  // crisp as a field. chrome is KEPT as its own token (now near-identical to navy) rather
  // than folded in, so nothing that reads `chrome` shifts; collapsing the two into one
  // dark is a deliberate later cleanup, not this PR.
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
  // The client Grant Alert view's two orange glows (card halo + Interested-button lift) and
  // its navy scrim over the road photo — named here for the SAME reason orangeGlow is: the
  // shadow/gradient geometry belongs to the component, the colour belongs to this file, so a
  // call-site alpha can't drift into a third and fourth orange. Navy = the locked brand navy.
  orangeGlowCard: "rgba(228,118,31,0.35)",
  orangeGlowAction: "rgba(228,118,31,0.5)",
  alertScrim: "linear-gradient(180deg,rgba(11,30,58,.82),rgba(11,30,58,.7) 55%,rgba(11,30,58,.88))",
  // Brand orange at the three alphas the GrantBot panel needs, named here for exactly the
  // reason `orangeGlow` is: an alpha invented at a call site is how a second orange gets
  // into the product.
  //   · orangeWash     — a fill on white (the panel's prompt card)
  //   · orangeWashEdge — that fill's 1px rule. NOT a tidier spelling of the same value: a
  //     tint at fill alpha vanishes as a line, so an edge needs roughly double. Same
  //     pairing STAGE documents for its tinted panel headers.
  //   · orangeTileOnInk — an icon tile reversed out of `chrome`/`navy`, where the ground is
  //     dark so the accent needs more alpha to register at all.
  // These are DECORATION and deliberately not STAGE.triage's tint/border, whose numbers are
  // similar: a stage colour means one stage and nothing else, and reusing it here would make
  // the funnel unreadable the moment someone reads this card as a triage surface.
  orangeWash: "rgba(228,118,31,0.07)",
  orangeWashEdge: "rgba(228,118,31,0.18)",
  orangeTileOnInk: "rgba(228,118,31,0.16)",
  // The same icon tile ON A LIGHT GROUND (GrantBot's answer avatar, which sits on white
  // rather than on the navy header). A pair for the same reason orangeDeep/orange and
  // successOnDark/success are pairs: the alpha that reads as a tile depends on what is
  // behind it, and one value cannot serve both. Distinct from `orangeWash`, which is a
  // large fill area -- a 26px tile at wash alpha disappears.
  orangeTile: "rgba(228,118,31,0.14)",
  // Brand orange darkened until small type on a light ground is legible. #E4761F tops
  // out near 3:1 against white and worse against SURFACE.ground, so it CANNOT carry
  // 9–12px text however much the layout wants orange there. Use this for eyebrows,
  // micro-chips and urgent deadline labels on light surfaces; use `orange` for fills,
  // display figures, and anything on ink. They are not interchangeable — the pair exists
  // so "orange small text" has a right answer instead of being quietly illegible.
  orangeDeep: "#A8501A",
  // Brand orange for ACCENT ON LIGHT that is neither small text nor a white-label fill:
  // large orange text (≥24px / ≥19px bold), and rules or icons that carry or sit beside a
  // DARK label on the light surface. #C4651F is 3.76:1 on SURFACE.page — it clears the
  // 3:1 bar for large text and non-text UI, but NOT the 4.5:1 body-text floor, so it is
  // never correct under 24px (use orangeDeep) and never under a white label (use
  // orangeFill). `orange` #E4761F still owns no-text marks (bars/dots/rules with no label)
  // on any ground and the accent on dark; this is the one-step-darker answer for when
  // orange must carry weight on light. (2026 palette handoff.)
  orangeOnLight: "#C4651F",
  // Brand orange as a FILL UNDER WHITE TEXT. The mirror of orangeDeep, one layer out:
  // orangeDeep exists because orange type on a light ground is illegible, this exists
  // because white type on an orange ground is too. White on #E4761F is 3.04:1 — every
  // primary button in the product sat there. #A8501A takes it to 5.49:1 (2026 handoff),
  // and deliberately COINCIDES with orangeDeep so "small orange text on light" and
  // "orange fill under white" have one burnt-orange answer instead of two.
  //
  // NOT a replacement for `orange`. Use this ONLY where white (or cream) text sits on a
  // solid orange field: primary buttons, count badges, the active bucket pill. `orange`
  // stays the fill for anything with no text on it — bars, dials, dots, rules, ghost
  // figures, the left-edge accents — because those carry no contrast obligation and
  // darkening them would drain the accent out of the product for no gain.
  //
  // Press states are the handoff's light-ground button ramp: hover #8F430F, active
  // #6F340B. (orangeHover #C9631A stays the dark-ground accent press.)
  orangeFill: "#A8501A",
  orangeFillHover: "#8F430F",
  orangeFillActive: "#6F340B",
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
  page: "#FAF7F2",   // page background — flat, no texture (2026 handoff; = legacy BRAND.cream value, left in place)
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
  DEFAULT: "#0C121F", // primary text (= navy)
  muted: "#3C4150",   // body / secondary text — 2026 handoff neutral (9.52:1 on page)
  // Labels, metadata, counts of hidden rows. The 2026 handoff caption grey #6E6F78
  // (4.67:1 on SURFACE.page) replaces the prior #6E7683 — effectively the same value on a
  // cooler-neutral hue, and still the lightest grey that clears the 4.5 floor for small
  // type, so the step between `muted` and `subtle` survives.
  //
  // It still does NOT clear AA on SURFACE.ground. That is by design and not a gap to close
  // by darkening further — ground-level small type uses `muted`, and the ink screens
  // already do. See the note at the top of components/clients/portfolio-browser.tsx.
  subtle: "#6E6F78",
  faint: "#B0B6BF",   // placeholder text, disabled chevrons
} as const;

// ── Lines ───────────────────────────────────────────────────────────────────
// Light-ground hairlines are WARM SOLID literals from the 2026 handoff, not derived from
// the primary: the refreshed primary #0C121F is much less saturated than the old navy, so
// a hairline tinted from it comes out cool and near-neutral — wrong against the warm page.
// The two warm values (subtle #EFE8DC, stronger #D9D2C3) keep every rule on the cream
// surface warm. Dark-ground dividers can't take a warm line, so `onDark` (#27334A, from
// the primary) is their separate token — never put a warm hairline on a navy/chrome field,
// and never put `onDark` on the light surface.
export const LINE = {
  hairline: "#EFE8DC",       // row dividers inside cards / subtle rules on light
  hairlineStrong: "#D9D2C3", // section / header bottom borders on light
  edge: "#D9D2C3",           // secondary button + input borders on light
  onDark: "#27334A",         // dividers / borders on the dark ground
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
  client: { color: "#0C121F", tint: "rgba(12,18,31,0.07)", border: "rgba(12,18,31,0.14)", text: "#0C121F" },
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
// RATING IS CARRIED BY HOW MANY SEGMENTS ARE FILLED, NOT BY HUE ALONE. The previous build ran
// green / gold / red side by side, which is close to worst-case for red-green colour blindness —
// the three ratings were distinguishable only by the one channel a red-green viewer cannot use.
// Counting filled segments works for everyone, and the word underneath says it in text as well.
// These neutral `filled`/`empty` tints are the default for a rating bar (e.g. match-score.tsx).
//
// EXCEPTION — the grant review console's Fit-factors bars (2026-08-18, Design's direction):
// there the filled segments are hued — orange for a weak (one-of-three) bar, navy for a two/three
// bar. That does NOT reintroduce the green/gold/red problem: hue is REDUNDANT there (the segment
// count and the "Weak"/"Strong" word already carry the rating), and orange vs navy differ in
// LUMINANCE, not just the red-green channel — they stay apart in grayscale, unlike green vs red.
// So it is safe for a red-green viewer. Keep hue redundant with count wherever a rating bar is
// hued; never let hue become the only channel.
export const RATING = {
  filled: "#8F8B82", // a filled segment on a neutral (non-hued) row
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
  // A THIRD rest-state elevation, and the only thing in the product that earns one: a panel
  // floating over a full page of its own content (the GrantBot launcher). `overlay` is tuned
  // for menus and popovers — things anchored to the control that opened them, a few hundred
  // pixels tall, gone on the next click. At 404x588 over a live dashboard that reads as a
  // card that failed to land. The near shadow keeps the edge crisp; the far one is the long
  // cast that says "above the page" rather than "on it".
  //
  // Not a licence to reintroduce a shadow ladder — see the deprecated aliases in
  // tailwind.config.ts for what that cost. Cards use `card`; menus use `overlay`.
  floating: "0 4px 12px rgba(11,30,58,0.12), 0 30px 70px -20px rgba(11,30,58,0.45)",
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
