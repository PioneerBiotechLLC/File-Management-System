import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Files", template: "%s · Files" },
  description: "Company documents, filed and found with AI.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
