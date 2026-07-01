// GRANTED brand fonts, loaded once as reusable primitives. Exposed as CSS
// variables so a consumer can scope them to a subtree (attach `.variable` to a
// wrapper) rather than forcing them app-wide. Applied on the client dashboard
// this pass; app-wide adoption is later opt-in.
//
// next/font/google fetches at BUILD time (fine on Vercel). If a build ever runs
// air-gapped, switch to next/font/local with vendored font files.
import { Inter_Tight, Source_Serif_4 } from "next/font/google";

export const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
  display: "swap",
});

export const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  variable: "--font-source-serif",
  display: "swap",
});
