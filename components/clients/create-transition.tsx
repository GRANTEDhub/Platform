"use client";

import { BRAND } from "@/lib/brand";

// Full-screen transition shown while a client/prospect record is being created, so
// the click has a visible consequence instead of a frozen button followed by an
// abrupt dashboard.
//
// SCOPE OF THE CLAIM: this window covers the INSERT and nothing else. It used to
// rotate four phrases on a 1600ms timer, narrating the enrichment chain (USASpending
// -> IRS 990 -> RUCC -> profile refine) as though it were finishing here. It was not:
// enrichClient is dispatched via waitUntil and runs AFTER the response, so those
// lines described work that had merely been kicked off, advanced on a clock that was
// not measuring anything, and could not report a failure. The real per-step status
// now has its own screen (the API-data confirm step this redirects to), driven by
// observed artifacts.
//
// So: one honest line, and an indeterminate bar -- which promises motion, not a
// percentage we cannot compute. The overlay lives exactly as long as the request.
export function CreateTransition({ kindLabel }: { kindLabel: string }) {
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
        Saving the {kindLabel}
      </h2>

      <p className="ct-fade mt-3 max-w-md text-sm text-white/70">
        Next you&apos;ll review what the public data sources return.
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
