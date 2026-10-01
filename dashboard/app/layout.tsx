import type { Metadata, Viewport } from "next";
import "./globals.css";
import { EngineProvider } from "@/lib/engine";
import { Shell } from "@/components/shell";
import { AuthGate } from "@/components/auth-gate";
import { Motion } from "@/components/motion";
import { DevsProvider } from "@/components/devs";

export const metadata: Metadata = {
  title: "Sniper Bot",
  description: "Solana Pump.fun sniper with Jito bundles, exits and paper trading",
};

export const viewport: Viewport = { themeColor: "#08090b" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const engine = process.env.NEXT_PUBLIC_ENGINE_URL;
  return (
    <html lang="en">
      <head>
        {/* Start the TLS handshake with the engine while the page's scripts are still loading. */}
        {engine && <link rel="preconnect" href={/^https?:\/\//.test(engine) ? engine.replace(/\/+$/, "") : `https://${engine.replace(/\/+$/, "")}`} crossOrigin="anonymous" />}
      </head>
      <body className="min-h-screen font-sans">
        <Motion>
          <AuthGate>
            <EngineProvider>
              <DevsProvider>
                <Shell>{children}</Shell>
              </DevsProvider>
            </EngineProvider>
          </AuthGate>
        </Motion>
      </body>
    </html>
  );
}
