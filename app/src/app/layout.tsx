import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";
import { Sidebar } from "@/components/Sidebar";
import { getView } from "@/lib/view";
import "./globals.css";

const sans = Inter_Tight({ subsets: ["latin"], variable: "--font-sans", weight: ["300", "400", "500", "600", "700"] });
const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-mono", weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "Dumen · Refund & payout control room",
  description: "What Dumen stopped, why, and what needs your attention.",
};

export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Waiting decisions on the default run, for the sidebar badge.
  const waiting = getView({})?.openCases.length ?? 0;
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <div className="app">
          <Suspense>
            <Sidebar waiting={waiting} />
          </Suspense>
          <main className="main">{children}</main>
        </div>
      </body>
    </html>
  );
}
