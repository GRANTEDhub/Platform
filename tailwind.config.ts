import type { Config } from "tailwindcss";
import { BRAND, SURFACE, INK, LINE, STAGE, ELEVATION, RADIUS, MOTION } from "./lib/brand";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    // OVERRIDE, not extend -- this deletes Tailwind's `shadow-<color>` utilities.
    //
    // They collide with our elevation names and silently win. Tailwind derives
    // boxShadowColor from theme.colors, so because a color named `card` exists (the
    // shadcn --card token), `shadow-card` generated BOTH our box-shadow and a
    // shadow-COLOR utility. The color one is emitted later, and it reassigns
    // `--tw-shadow: var(--tw-shadow-colored)` against `--tw-shadow-color: hsl(var(--card))`
    // -- i.e. a WHITE shadow. Every card on the default elevation rendered with no
    // visible shadow at all, which is exactly the "flat white cards read as holes"
    // symptom this refresh is supposed to fix.
    //
    // Nothing in the app uses a shadow-color utility (verified across app/ and
    // components/), so removing the whole family is the root fix rather than dodging
    // it by renaming our token -- and it means no future token name can be shadowed
    // by a same-named color.
    boxShadowColor: {},
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        // GRANTED brand primitives, sourced from lib/brand.ts (single source of
        // truth). The semantic tokens above (--primary etc.) now resolve to this
        // same navy/orange/cream palette, so brand utilities and app chrome agree.
        brand: {
          navy: BRAND.navy,
          navyHover: BRAND.navyHover,
          navyDeep: BRAND.navyDeep,
          chrome: BRAND.chrome,
          orange: BRAND.orange,
          orangeHover: BRAND.orangeHover,
          orangeDeep: BRAND.orangeDeep,
          // Solid orange UNDER WHITE TEXT only — see the note in lib/brand.ts. `orange`
          // stays the fill for anything with no type on it.
          orangeFill: BRAND.orangeFill,
          orangeFillHover: BRAND.orangeFillHover,
          amberOnDark: BRAND.amberOnDark,
          // Green reversed out of navy chrome (GrantBot's live badge). NOT `success` --
          // see the note in lib/brand.ts: that value fails contrast on a dark ground.
          successOnDark: BRAND.successOnDark,
          reject: BRAND.reject,
          cream: BRAND.cream,
          creamWarm: BRAND.creamWarm,
        },
        // Surfaces. `page` is flat -- there is no page texture (see lib/brand.ts).
        page: SURFACE.page,
        ground: SURFACE.ground,
        surface: {
          DEFAULT: SURFACE.card,
          sunken: SURFACE.sunken,
        },
        // Screen text scale. NOT BRAND.ink, which is the print ink for the contract
        // PDF -- see the note in lib/brand.ts.
        ink: {
          DEFAULT: INK.DEFAULT,
          muted: INK.muted,
          subtle: INK.subtle,
          faint: INK.faint,
        },
        hairline: {
          DEFAULT: LINE.hairline,
          strong: LINE.hairlineStrong,
        },
        edge: LINE.edge,
        // Pipeline stages. One color per stage, used only for that stage.
        stage: {
          triage: STAGE.triage.color,
          "triage-tint": STAGE.triage.tint,
          client: STAGE.client.color,
          "client-tint": STAGE.client.tint,
          "client-text": STAGE.client.text,
          "client-deep": STAGE.client.deep,
          approved: STAGE.approved.color,
          "approved-tint": STAGE.approved.tint,
          "approved-on-dark": STAGE.approved.onDark,
          pursuit: STAGE.pursuit.color,
          "pursuit-tint": STAGE.pursuit.tint,
          passed: STAGE.passed.color,
          "passed-tint": STAGE.passed.tint,
        },
      },
      // THREE radii, by role (lib/brand.ts RADIUS), plus `sharp` for the ink direction's
      // squared card — see the note on RADIUS.sharp. Tailwind's own `none` and `full`
      // survive because this is an `extend` block -- `full` is still what count
      // badges and status chips use.
      //
      // The size names are collapsed onto the three roles rather than kept as a
      // ladder: sm/md/lg all resolve to the control radius, and xl through 4xl all
      // resolve to the card radius. That is what makes five different radii on
      // sibling elements impossible to reintroduce by picking the "next size up".
      borderRadius: {
        DEFAULT: RADIUS.control,
        sm: RADIUS.control,
        md: RADIUS.control,
        lg: RADIUS.control,
        pill: RADIUS.pill,
        sharp: RADIUS.sharp,
        xl: RADIUS.card,
        "2xl": RADIUS.card,
        "3xl": RADIUS.card,
        "4xl": RADIUS.card,
      },
      boxShadow: {
        // TWO steps (lib/brand.ts ELEVATION), plus the card's hover state.
        card: ELEVATION.card,
        "card-hover": ELEVATION.cardHover,
        overlay: ELEVATION.overlay,
        // Panels floating over a full page of content, not anchored popovers. One call
        // site (the GrantBot launcher) — see the note in lib/brand.ts.
        floating: ELEVATION.floating,
        // DEPRECATED ALIASES. The old scale had four rest-state elevations
        // (soft / softer / card / grounded) plus `lift`, which is most of why
        // sibling cards looked like they came from different designs. They are
        // aliased into the two-step scale rather than deleted so that no call site
        // silently loses its shadow: an unknown Tailwind class produces no CSS and
        // no build error, so removing these outright would fail invisibly.
        //
        // Do not use them in new code. They collapse as PRs touch their call sites.
        soft: ELEVATION.card,
        softer: ELEVATION.card,
        grounded: ELEVATION.card,
        lift: ELEVATION.overlay,
      },
      transitionTimingFunction: {
        // One curve for entrances and layout. Nothing bounces.
        entrance: MOTION.entrance,
      },
      // AMBIENT loops, all three from GrantBot's full-page chrome and all three used
      // behind `motion-safe:` so a reduced-motion preference gets a static panel. Nothing
      // here signals state -- the pulse and the drift are decoration, and the typing dots
      // duplicate a text label that says the same thing.
      keyframes: {
        "pulse-ring": {
          "0%, 100%": { opacity: "0.55", transform: "scale(1)" },
          "50%": { opacity: "0", transform: "scale(1.55)" },
        },
        "typing-dot": {
          "0%, 80%, 100%": { opacity: "0.25", transform: "translateY(0)" },
          "40%": { opacity: "1", transform: "translateY(-2px)" },
        },
        "bloom-drift": {
          "0%, 100%": { transform: "translate(0, 0)" },
          "50%": { transform: "translate(-18px, 14px)" },
        },
      },
      animation: {
        "pulse-ring": "pulse-ring 2.4s ease-out infinite",
        "typing-dot": "typing-dot 1.1s ease-in-out infinite",
        "bloom-drift": "bloom-drift 14s ease-in-out infinite",
      },
      fontFamily: {
        // Body / default. Tailwind's preflight sets `html { font-family: sans }`,
        // so DM Sans is the base font for every page once the CSS var is applied
        // at the root layout.
        sans: ["var(--font-dm-sans)", "system-ui", "sans-serif"],
        // Headings (`font-serif`) — Libre Baskerville, editorial display serif.
        serif: ["var(--font-libre-baskerville)", "Georgia", "serif"],
        // Legacy alias: some wrappers still carry `font-tight`. Point it at the
        // body font so it stays consistent with the platform default.
        tight: ["var(--font-dm-sans)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
