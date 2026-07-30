// The GRANTED logomark as a loading indicator.
//
// WHY A SQUARE BOX. granted-mark-light.svg has a viewBox of 262x354 -- noticeably
// taller than it is wide. Rendered at `h-16 w-auto` the element box is about 47x64, and
// rotating a tall box about its own centre sweeps an ellipse rather than a circle: the
// mark appears to wobble, like a buckled wheel, even though the origin is dead centre.
//
// Forcing a SQUARE element with object-contain fixes it: the SVG letterboxes inside the
// square and preserveAspectRatio's default (xMidYMid) centres the viewBox in it, so the
// artwork's own centre sits exactly on the element's centre and the sweep is circular.
//
// The mark carries no wordmark, which is what makes rotating it acceptable at all --
// spinning a lockup would put the word upside down twice a second.
export function SpinningMark({ className = "h-16 w-16" }: { className?: string }) {
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- a plain <img> keeps the
          transform on one element; next/image wraps it in a sized span. */}
      <img
        src="/granted-mark-light.svg"
        alt=""
        aria-hidden="true"
        className={`gm-spin object-contain ${className}`}
      />
      <style jsx>{`
        .gm-spin {
          transform-origin: 50% 50%;
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
