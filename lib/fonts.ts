// GRANTED brand fonts, loaded once as reusable primitives and applied
// platform-wide from the root layout (app/layout.tsx). Exposed as CSS variables
// so Tailwind's fontFamily can resolve them:
//   --font-dm-sans          -> fontFamily.sans  (body / default: Tailwind's
//                              preflight sets `html { font-family: sans }`, so
//                              this becomes the base font for every page)
//   --font-libre-baskerville -> fontFamily.serif (headings via `font-serif`)
//
// The pairing (Libre Baskerville headings + DM Sans body) matches the design
// direction: relaxed, editorial serif display over a clean humanist sans.
//
// next/font/google fetches at BUILD time (fine on Vercel). If a build ever runs
// air-gapped, switch to next/font/local with vendored font files.
import { DM_Sans, Libre_Baskerville } from "next/font/google";

export const dmSans = DM_Sans({
  subsets: ["latin"],
  variable: "--font-dm-sans",
  display: "swap",
});

// Libre Baskerville ships only regular (400) and bold (700) — no variable axis.
// Headings use `font-serif`; weight is chosen per-heading in the markup.
export const libreBaskerville = Libre_Baskerville({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-libre-baskerville",
  display: "swap",
});
