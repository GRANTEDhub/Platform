import { BRAND } from "@/lib/brand";

// Warm-cream page backdrop with faint topographic contour lines — de-stales the
// hub body surfaces (dashboard, grant report) without a competing photo. Sits
// behind the content (absolute inset-0); decorative only. The map photo stays an
// accent in hero bands / cards; this is the ambient texture for the page itself.
export function PageBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden bg-brand-creamWarm">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 1440 1200"
        preserveAspectRatio="xMidYMid slice"
      >
        <g fill="none" stroke={BRAND.navy} strokeOpacity="0.06" strokeWidth="1.5">
          <path d="M-40,110 C300,55 520,175 780,115 C1020,60 1220,150 1500,90" />
          <path d="M-40,185 C300,130 520,250 780,190 C1020,135 1220,225 1500,165" />
          <path d="M-40,300 C320,245 520,365 780,305 C1020,250 1220,340 1500,280" />
          <path d="M-40,430 C320,375 520,495 780,435 C1020,380 1220,470 1500,410" />
          <path d="M-40,560 C320,505 520,625 780,565 C1020,510 1220,600 1500,540" />
          <path d="M-40,700 C320,645 520,765 780,705 C1020,650 1220,740 1500,680" />
          <path d="M-40,850 C320,795 520,915 780,855 C1020,800 1220,890 1500,830" />
          <path d="M-40,1010 C320,955 520,1075 780,1015 C1020,960 1220,1050 1500,990" />
        </g>
        <g fill="none" stroke={BRAND.orange} strokeOpacity="0.13" strokeWidth="1.5">
          <path d="M-40,245 C320,190 520,310 780,250 C1020,195 1220,285 1500,225" />
          <path d="M-40,760 C320,705 520,825 780,765 C1020,710 1220,800 1500,740" />
        </g>
      </svg>
    </div>
  );
}
