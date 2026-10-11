import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Packages that must run as plain Node modules on the server, not bundled.
  serverExternalPackages: ["@prisma/client", "pg", "mammoth", "exceljs"],
};

export default nextConfig;
