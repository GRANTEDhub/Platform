/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf-parse reads files at runtime; keep it out of the webpack bundle so it
  // works inside the serverless function. (Required for the Step-2 NOFO parse.)
  // @react-pdf/renderer is externalized too (native-ish deps); its embedded brand
  // fonts (.ttf) are traced into the sign route's serverless function so the
  // background PDF render can read them at runtime.
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "mammoth", "@react-pdf/renderer"],
    outputFileTracingIncludes: {
      "/api/sign/[token]": ["./lib/contracts/fonts/**"],
    },
  },
};

export default nextConfig;
