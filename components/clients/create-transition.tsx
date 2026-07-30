"use client";

import { useEffect, useState } from "react";
import { BRAND } from "@/lib/brand";

// Full-screen transition shown while a client/prospect record is being created, so
// the click has a visible consequence instead of a frozen button followed by an
// abrupt dashboard.
//
// HONEST BY DESIGN: every line describes work that is really happening on the
// server during this window -- the insert, then the background enrichment chain
// (enrichClient: USASpending -> IRS 990 -> RUCC -> the profile refine + community
// context). No invented steps, and no artificial delay: the overlay lives exactly as
// long as the request does, and the redirect tears it down whenever the save
// finishes. If that is fast, the user simply sees fewer lines -- which is the
// truthful outcome, not a padded one.
const PHRASES = [
  "Saving the organization profile…",
  "Kicking off enrichment — federal award history, IRS 990 financials…",
  "Deriving rurality and community context…",
  "Preparing the dashboard…",
];

const PHRASE_MS = 1600;

export function CreateTransition({ kindLabel }: { kindLabel: string }) {
  const [i, setI] = useState(0);

  useEffect(() => {
    // Advance through the phrases, holding on the last one until the redirect
    // unmounts this (never loop back -- a restarting list reads as a hang).
    const t = setInterval(() => setI((n) => (n < PHRASES.length - 1 ? n + 1 : n)), PHRASE_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-brand-navy px-6 text-center"
    >
      <div className="ct-pulse flex h-16 w-16 items-center justify-center rounded-full ring-1 ring-white/20">
        <svg viewBox="0 0 24 24" className="h-7 w-7" fill="none" aria-hidden="true">
          <path
            d="M12 3v18M3 12h18"
            stroke={BRAND.orange}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      </div>

      <h2 className="mt-8 font-serif text-2xl font-semibold text-white">
        Building the {kindLabel} dashboard
      </h2>

      {/* Cross-fade the current line; keyed so each phrase re-runs the animation. */}
      <p key={i} className="ct-fade mt-3 max-w-md text-sm text-white/70">
        {PHRASES[i]}
      </p>

      <div className="mt-8 h-1 w-56 overflow-hidden rounded-full bg-white/15">
        <div className="ct-bar h-full rounded-full" style={{ background: BRAND.orange }} />
      </div>

      <style jsx>{`
        .ct-pulse {
          animation: ct-pulse 2s ease-in-out infinite;
        }
        .ct-fade {
          animation: ct-fade 0.5s ease-out;
        }
        .ct-bar {
          width: 40%;
          animation: ct-slide 1.4s ease-in-out infinite;
        }
        @keyframes ct-pulse {
          0%,
          100% {
            transform: scale(1);
            opacity: 0.85;
          }
          50% {
            transform: scale(1.06);
            opacity: 1;
          }
        }
        @keyframes ct-fade {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes ct-slide {
          0% {
            transform: translateX(-100%);
          }
          100% {
            transform: translateX(250%);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .ct-pulse,
          .ct-fade,
          .ct-bar {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
