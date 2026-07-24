import type { Config } from "tailwindcss";
import { BRAND } from "./lib/brand";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
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
          navyDeep: BRAND.navyDeep,
          orange: BRAND.orange,
          cream: BRAND.cream,
          creamWarm: BRAND.creamWarm,
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
        "4xl": "1.75rem",
      },
      boxShadow: {
        // Design-system elevation scale (visual refresh, epic #92). Warm navy-
        // tinted soft shadows for the floating-card language.
        soft: "0 10px 40px -14px rgba(11,30,58,0.16)",
        softer: "0 6px 22px -12px rgba(11,30,58,0.13)",
        lift: "0 26px 70px -24px rgba(11,30,58,0.30)",
        // Lifted card: a defined drop (not a diffuse halo) so cards sit clearly on
        // the warmer hub backdrop (dashboard / report).
        card: "0 2px 4px -1px rgba(11,30,58,0.14), 0 10px 26px -8px rgba(11,30,58,0.30)",
        // Darker/denser navy drop for cards over the busy detail-page photo
        // backdrop, where `card` read too faint (a pale border ring, not a shadow).
        grounded: "0 4px 10px -2px rgba(8,20,45,0.35), 0 16px 36px -12px rgba(8,20,45,0.45)",
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
