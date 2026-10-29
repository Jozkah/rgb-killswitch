// Downloads Corsair's official iCUE SDK DLL (the project does not redistribute it). Best effort: a failure
// only means iCUE devices are skipped, so it never fails the install.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "4.0.84";
const SHA256 = "eb4414cf505145f3e507dc839ad587bf7ca684d64be3d9a834f416a136736d5d";
const URL = `https://github.com/CorsairOfficial/cue-sdk/releases/download/v${VERSION}/iCUESDK_${VERSION}.zip`;
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "vendor", "iCUESDK.x64_2019.dll");

if (process.platform !== "win32" || process.arch !== "x64" || existsSync(target)) process.exit(0);

const quote = (p) => p.replaceAll("'", "''"); // a user name like O'Brien would end the PowerShell string
const work = mkdtempSync(path.join(os.tmpdir(), "icue-sdk-"));
try {
	const zip = Buffer.from(await (await fetch(URL)).arrayBuffer());
	if (createHash("sha256").update(zip).digest("hex") !== SHA256) throw new Error("checksum mismatch");
	const zipPath = path.join(work, "sdk.zip");
	writeFileSync(zipPath, zip);
	execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${quote(zipPath)}' -DestinationPath '${quote(work)}' -Force`], { stdio: "ignore" });
	mkdirSync(path.dirname(target), { recursive: true });
	copyFileSync(path.join(work, "iCUESDK", "redist", "x64", "iCUESDK.x64_2019.dll"), target);
	console.log("Downloaded the Corsair iCUE SDK.");
} catch (e) {
	console.warn(`Could not download the Corsair iCUE SDK (${e instanceof Error ? e.message : e}). iCUE devices will be skipped.`);
} finally {
	rmSync(work, { recursive: true, force: true });
}
