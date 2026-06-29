/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // pdf-parse reads files at runtime; keep it out of the webpack bundle so it
  // works inside the serverless function. (Required for the Step-2 NOFO parse.)
  experimental: {
    serverComponentsExternalPackages: ["pdf-parse", "mammoth"],
  },
};

export default nextConfig;
