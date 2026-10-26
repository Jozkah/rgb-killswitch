import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const common = { bundle: true, platform: "node", format: "cjs", target: "node20", external: ["node-hid", "koffi"], logLevel: "info" };
const plugin = "streamdeck/com.rgbkillswitch.sdPlugin";

await build({ ...common, entryPoints: { cli: "src/cli/index.ts" }, outdir: "dist", outExtension: { ".js": ".cjs" }, banner: { js: "#!/usr/bin/env node" } });
await build({ ...common, entryPoints: { worker: "src/core/worker.ts" }, outdir: "dist", outExtension: { ".js": ".cjs" } });
await build({ ...common, entryPoints: { plugin: "src/streamdeck/plugin.ts", worker: "src/core/worker.ts" }, outdir: `${plugin}/bin` });

// The plugin folder is self-contained: Stream Deck runs it from its own directory.
mkdirSync(`${plugin}/lib`, { recursive: true });
try {
	cpSync("vendor/iCUESDK.x64_2019.dll", `${plugin}/lib/iCUESDK.x64_2019.dll`);
} catch {
	console.warn("iCUE SDK not downloaded; the Stream Deck plugin will skip iCUE devices.");
}
