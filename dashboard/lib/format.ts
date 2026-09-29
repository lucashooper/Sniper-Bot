export const sol = (n: number, d = 4) => `${n.toFixed(d)} SOL`;
export const signed = (n: number, d = 4) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}`;
export const pct = (n: number, d = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`;
export const short = (s: string, n = 4) => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);
export const compact = (n: number) =>
  n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(2);
export const price = (n: number) => (n === 0 ? "0" : n < 1e-6 ? n.toExponential(3) : n.toPrecision(4));
export const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
export const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour12: false });
export const solscan = (sig: string) => `https://solscan.io/tx/${sig}`;
export const tokenUrl = (mint: string) => `https://pump.fun/coin/${mint}`;
