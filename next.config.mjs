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
    },
  },
};

export default nextConfig;
