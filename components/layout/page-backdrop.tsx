import { BRAND } from "@/lib/brand";

// Warm-cream page backdrop with faint topographic contour lines — de-stales the
// hub body surfaces (dashboard, grant report) without a competing photo. Fixed to
// the viewport (not the page's scrollable/padded content box) so it spans true
// edge-to-edge — behind the sidebar and out to every screen edge — rather than
// being boxed in by the app shell's own padding. Decorative only, negative
// z-index. The map photo stays an accent in hero bands / cards; this is the
// ambient texture for the page itself.
export function PageBackdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-brand-creamWarm">
      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 1440 1200"
        preserveAspectRatio="xMidYMid slice"
      >
        <g fill="none" stroke={BRAND.navy} strokeOpacity="0.06" strokeWidth="1.5">
          <path d="M-40,80 C300,30 520,145 780,85 C1020,32 1220,120 1500,62" />
          <path d="M-40,140 C300,90 520,205 780,148 C1020,95 1220,182 1500,122" />
          <path d="M-40,205 C300,155 520,270 780,210 C1020,155 1220,245 1500,185" />
          <path d="M-40,285 C320,235 520,350 780,290 C1020,235 1220,325 1500,265" />
          <path d="M-40,365 C320,315 520,430 780,370 C1020,315 1220,405 1500,345" />
          <path d="M-40,450 C320,400 520,515 780,455 C1020,400 1220,490 1500,430" />
          <path d="M-40,535 C320,485 520,600 780,540 C1020,485 1220,575 1500,515" />
          <path d="M-40,625 C320,575 520,690 780,630 C1020,575 1220,665 1500,605" />
          <path d="M-40,715 C320,665 520,780 780,720 C1020,665 1220,755 1500,695" />
          <path d="M-40,810 C320,760 520,875 780,815 C1020,760 1220,850 1500,790" />
          <path d="M-40,905 C320,855 520,970 780,910 C1020,855 1220,945 1500,885" />
          <path d="M-40,1005 C320,955 520,1070 780,1010 C1020,955 1220,1045 1500,985" />
          <path d="M-40,1110 C320,1060 520,1175 780,1115 C1020,1060 1220,1150 1500,1090" />
        </g>
        <g fill="none" stroke={BRAND.orange} strokeOpacity="0.12" strokeWidth="1.5">
          <path d="M-40,245 C320,195 520,310 780,250 C1020,195 1220,285 1500,225" />
          <path d="M-40,580 C320,530 520,645 780,585 C1020,530 1220,620 1500,560" />
          <path d="M-40,950 C320,900 520,1015 780,955 C1020,900 1220,990 1500,930" />
        </g>
      </svg>
    </div>
  );
}
