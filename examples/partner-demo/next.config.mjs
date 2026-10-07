/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  poweredByHeader: false,
  // the SDK ships TypeScript source inside the monorepo; a normal install uses its built dist
  transpilePackages: ["@converge/sdk"],
};

export default config;
