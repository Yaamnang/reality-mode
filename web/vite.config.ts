import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";

const PORT = 5173;

// This laptop's addresses on the local network, so the app can show a QR code for phones.
// Home/hotspot addresses (192.168.x.x) go first since they're the most likely to be right.
function lanAddresses(): string[] {
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === "IPv4" && !net.internal)
    .map((net) => net!.address);
  return ips.sort((a, b) => Number(b.startsWith("192.168.")) - Number(a.startsWith("192.168.")));
}

// Prints app events (camera, gestures, errors) from every connected device in this terminal.
// The page sends them over Vite's live-reload connection, see src/remoteLog.ts.
function terminalLog(): Plugin {
  const colors: Record<string, string> = { phone: "\x1b[36m", laptop: "\x1b[34m" };
  return {
    name: "godmode-terminal-log",
    configureServer(server) {
      server.ws.on("godmode:log", (data: { device: string; message: string }) => {
        const time = new Date().toLocaleTimeString();
        const color = colors[data.device] ?? "";
        console.log(`\x1b[2m${time}\x1b[0m ${color}[${data.device}]\x1b[0m ${data.message}`);
        // Also kept in a file (gitignored), so a phone's log can be read after the run.
        mkdirSync(folder, { recursive: true });
        appendFileSync(resolve(folder, "session.log"), `${time} [${data.device}] ${data.message}\n`);
      });

      // Debug frames from the "Send debug frames" switch, saved for tools/replay.
      const folder = resolve(server.config.root, "../debug-frames");
      let saved = 0;
      server.ws.on("godmode:frame", (data: { device: string; image: string; details: Record<string, unknown> }) => {
        mkdirSync(folder, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const name = `${stamp}_${data.details.reason ?? "frame"}`;
        writeFileSync(resolve(folder, `${name}.jpg`), Buffer.from(data.image.split(",")[1], "base64"));
        writeFileSync(resolve(folder, `${name}.json`), JSON.stringify(data.details, null, 2));
        saved++;
        console.log(`\x1b[2m  saved debug frame ${saved}: ${name}\x1b[0m`);
      });
    },
  };
}

export default defineConfig({
  // Phones only allow the camera on HTTPS pages. This makes a self-signed certificate,
  // so the phone shows a one-time "not private" warning: tap Advanced -> Proceed.
  plugins: [basicSsl(), terminalLog()],
  define: {
    __LAN_IPS__: JSON.stringify(lanAddresses()),
    __PORT__: PORT,
  },
  server: {
    port: PORT,
    strictPort: true,
    // Listen on the local network too, not just this laptop, so phones can connect.
    host: true,
    // Requests to /api go to the Python backend, so the phone only needs one address.
    proxy: {
      "/api": { target: "http://localhost:8000", ws: true },
    },
  },
});
