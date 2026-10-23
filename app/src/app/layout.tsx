import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dumen · Refund ops",
  description: "What Dumen stopped, why, and what needs your attention.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
