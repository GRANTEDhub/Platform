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
  navy: "#0B1E3A",      // primary
  navyDeep: "#081627",  // darker navy for gradient ends
  orange: "#E4761F",    // accent / action
  cream: "#faf7f2",     // background / surface
  ink: "#1a1a1a",       // near-black body ink (print)
  muted: "#5b6472",     // grey — secondary text
  slate: "#334867",     // grey-navy — secondary accent (e.g. charts)
  taupe: "#c9c2b8",     // warm neutral — low-emphasis (e.g. charts)
  success: "#059669",   // status green — a functional signal, NOT the brand palette
} as const;
