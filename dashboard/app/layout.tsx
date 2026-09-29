import type { Metadata } from "next";
import "./globals.css";
import { EngineProvider } from "@/lib/engine";
import { Shell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Sniper Bot",
  description: "Solana Pump.fun sniper with Jito bundles, exits and paper trading",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <EngineProvider>
          <Shell>{children}</Shell>
        </EngineProvider>
      </body>
    </html>
  );
}
