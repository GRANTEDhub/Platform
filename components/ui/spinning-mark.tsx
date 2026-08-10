// The GRANTED logomark as a loading indicator.
//
// WHY A SQUARE BOX. granted-mark-light.svg declares viewBox="17 17 262 354" -- taller
// than it is wide. Rendered at `h-16 w-auto` the element box is about 47x64, and rotating
// a tall box about its own centre sweeps an ellipse rather than a circle: the mark appears
// to wobble, like a buckled wheel. A SQUARE element with object-contain fixes THAT half --
// the SVG letterboxes inside the square and preserveAspectRatio's default (xMidYMid)
// centres the viewBox in it.
//
// WHY THE ORIGIN IS NOT 50% 50%. Centring the viewBox is not the same as centring the
// artwork, because this file is the full LOCKUP with the viewBox cropped down to the mark:
// the wordmark and tagline paths are still in it, sitting out at x ~320-1470, clipped away
// by the viewport. What that leaves behind is ~100 units of empty space along the bottom of
// the viewBox where the wordmark's row used to be. So the visible ink spans y 30.7-270.9
// (centre 150.8) while the viewBox centre is 194 -- and rotating about the element centre
// pivots ~43 units BELOW the mark's real centre, roughly 12% of the element height. Hence
// the egg.
//
// The origin below is that measured centre, mapped through the contain letterboxing:
//   x = (100 - 262/354*100)/2 + (150.22 - 17)/354*100 = 50.6%
//   y =                         (150.79 - 17)/354*100 = 37.8%
// Both percentages assume a SQUARE element, which is why aspect-square is pinned on rather
// than left to the caller's className.
//
// The durable alternative is to re-export the asset cropped to the mark alone (viewBox
// ~"30.6 30.7 239.2 240.2"), which would make 50% 50% correct by construction -- but the
// same file is also used by components/intellengine/logo.tsx, so retightening it there
// changes that logo's size and position too. Not worth it for a spinner.
export function SpinningMark({ className = "h-16 w-16" }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a plain <img> keeps the
          transform on one element; next/image wraps it in a sized span. */}
      <img
        src="/granted-mark-light.svg"
        alt=""
        aria-hidden="true"
        className={`gm-spin aspect-square object-contain ${className}`}
      />
      <style jsx>{`
        .gm-spin {
          transform-origin: 50.6% 37.8%;
          animation: gm-spin 1.6s linear infinite;
        }
        @keyframes gm-spin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .gm-spin {
            animation: none;
          }
        }
      `}</style>
    </>
  );
}
