/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf-parse reads files at runtime; keep it out of the webpack bundle so it
  // works inside the serverless function. (Required for the Step-2 NOFO parse.)
  // @react-pdf/renderer is externalized too (native-ish deps); its embedded brand
  // fonts (.ttf) are traced into the sign route's serverless function so the
  // background PDF render can read them at runtime.
  experimental: {
    // @sparticuz/chromium + puppeteer-core are externalized (the Chromium binary
    // must not go through webpack); they load only in the alert render/send routes.
    serverComponentsExternalPackages: ["pdf-parse", "mammoth", "@react-pdf/renderer", "@sparticuz/chromium", "puppeteer-core"],
    outputFileTracingIncludes: {
      "/api/sign/[token]": ["./lib/contracts/fonts/**"],
      // The discovery-invite route reads the engagement flyer at runtime; trace
      // the fixed asset into its serverless function (same as the fonts above).
      "/api/leads/[id]/send-discovery-invite": ["./lib/email/assets/**"],
      // The grant-alert routes read the vendored template + logo assets at render,
      // and need the @sparticuz/chromium binary (its bin/ dir) traced into the
      // function -- externalizing keeps it out of webpack, but the binary must
      // still ship in the bundle or executablePath() can't find/decompress it.
      "/api/alerts/[cardId]/pdf": [
        "./lib/alerts/template/**",
        "./lib/alerts/assets/**",
        "./lib/contracts/fonts/**",
        "./node_modules/@sparticuz/chromium/**",
      ],
      "/api/alerts/[cardId]/send": [
        "./lib/alerts/template/**",
        "./lib/alerts/assets/**",
        "./lib/contracts/fonts/**",
        "./node_modules/@sparticuz/chromium/**",
      ],
      // The draft GET / regenerate POST also render (getOrCreateDraftAlert), so a
      // first render routed through this route needs the same Chromium + asset
      // trace -- otherwise executablePath() 500s exactly like the batch route did.
      "/api/alerts/[cardId]/draft": [
        "./lib/alerts/template/**",
        "./lib/alerts/assets/**",
        "./lib/contracts/fonts/**",
        "./node_modules/@sparticuz/chromium/**",
      ],
      // The aggregate-send PREPARE round renders missing drafts (getOrCreateDraftAlert),
      // so it needs the same Chromium + asset trace as the single-send render routes.
      // (send-batch never renders -- it loads saved PDFs + merges via pdf-lib -- so it
      // needs no trace-include here.)
      "/api/clients/[id]/prepare-batch": [
        "./lib/alerts/template/**",
        "./lib/alerts/assets/**",
        "./lib/contracts/fonts/**",
        "./node_modules/@sparticuz/chromium/**",
      ],
    },
  },
  async redirects() {
    return [
      // Consolidated: the old dashboard + portfolio pages are now the single
      // /clients hub. Redirect old links/bookmarks so nothing dead-ends.
      { source: "/dashboard", destination: "/clients", permanent: true },
      { source: "/portfolio", destination: "/clients", permanent: true },
    ];
  },
};

export default nextConfig;
