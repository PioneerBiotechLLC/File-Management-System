import type { Metadata } from "next";
import { Merriweather, Source_Sans_3 } from "next/font/google";
import "./globals.css";

// API Pharma's typefaces, self-hosted by Next so the font-src 'self' policy holds.
const sans = Source_Sans_3({ subsets: ["latin", "latin-ext"], variable: "--font-source-sans", display: "swap" });
const serif = Merriweather({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-merriweather", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Files", template: "%s · Files" },
  description: "Company documents, filed and found with AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${serif.variable}`}>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
