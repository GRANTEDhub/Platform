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
  subtle: "#8A93A0",  // labels, metadata, counts of hidden rows
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
// warning-state label text; never render the raw stage color as small type.
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
  client: { color: "#C9962B", tint: "rgba(201,150,43,0.14)", text: "#A87A1B", muted: "#DCC9A0" },
  approved: { color: "#2E7D91", tint: "rgba(46,125,145,0.06)", border: "rgba(46,125,145,0.13)", muted: "#8FBAC4" },
  pursuit: { color: "#0B7A5A", tint: "rgba(11,122,90,0.10)", muted: "#A3C6B8" },
  passed: { color: "#C9C2B8", tint: "rgba(11,30,58,0.06)", muted: "#DCD6CC" },
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
