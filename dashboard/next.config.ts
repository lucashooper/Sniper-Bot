import type { NextConfig } from "next";

// Every page is a client component talking to the engine, so the dashboard ships as a static site (dashboard/out):
// no server on Netlify, nothing secret in it. NEXT_PUBLIC_* values are inlined at build time.
const config: NextConfig = { reactStrictMode: true, output: "export", images: { unoptimized: true }, trailingSlash: true };
export default config;
