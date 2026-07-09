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
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        // Scoped to the dashboard via the font-var classes on its wrapper.
        serif: ["var(--font-source-serif)", "Source Serif 4", "serif"],
        tight: ["var(--font-inter-tight)", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
