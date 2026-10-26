// Builds the plugin and installs it into Stream Deck's plugin folder. Restart Stream Deck afterwards.
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const name = "com.rgbkillswitch.sdPlugin";
const source = path.join(root, "streamdeck", name);

if (process.platform !== "win32" || !process.env.APPDATA) {
	console.error("The Stream Deck install script supports Windows only. Copy streamdeck/" + name + " into your Stream Deck plugins folder by hand.");
	process.exit(1);
}
const destination = path.join(process.env.APPDATA, "Elgato", "StreamDeck", "Plugins", name);

execFileSync(process.execPath, [path.join(root, "scripts", "build.mjs")], { stdio: "inherit" });

// Files are only written when they changed: a running plugin keeps its DLL locked, and rewriting it is pointless.
function install(from, to) {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name === "logs") continue;
		const src = path.join(from, entry.name);
		const dst = path.join(to, entry.name);
		if (entry.isDirectory()) install(src, dst);
		else {
			const data = readFileSync(src);
			if (!existsSync(dst) || !data.equals(readFileSync(dst))) writeFileSync(dst, data);
		}
	}
}
install(source, destination);

// Native modules cannot be bundled, so the installed plugin carries its own copy of them.
const { dependencies } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
writeFileSync(path.join(destination, "package.json"), JSON.stringify({ name: "rgb-killswitch-streamdeck", private: true, dependencies }, null, 2));
execSync("npm install --omit=dev --no-audit --no-fund", { cwd: destination, stdio: "inherit" });

console.log(`\nInstalled to ${destination}\nRestart Stream Deck, then find "RGB Kill Switch" in the action list.`);
