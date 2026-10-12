import type { NextConfig } from "next";

/**
 * Browsers may only talk to this app and to the file bucket (uploads and previews go there
 * directly). Next.js needs inline scripts and styles for hydration, so those stay allowed.
 */
function contentSecurityPolicy(): string {
  const bucket = process.env.FILES_S3_ENDPOINT?.trim();
  let bucketOrigin = "https:";
  try {
    if (bucket) bucketOrigin = new URL(bucket).origin;
  } catch {
    // Reported by /api/health; keep the permissive fallback so a typo cannot lock the app.
  }
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    // Company logos may be hosted anywhere; previews are served from the bucket.
    `img-src 'self' data: blob: https:`,
    `connect-src 'self' ${bucketOrigin}`,
    `frame-src 'self' ${bucketOrigin}`,
    "upgrade-insecure-requests",
  ].join("; ");
}

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy() },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Packages that must run as plain Node modules on the server, not bundled.
  serverExternalPackages: ["@prisma/client", "pg", "mammoth", "exceljs"],
  headers: async () => [{ source: "/(.*)", headers: SECURITY_HEADERS }],
};

export default nextConfig;
