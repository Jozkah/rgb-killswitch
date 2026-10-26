import fs from "node:fs";
import path from "node:path";
import { stateDir } from "./paths.js";

export type Overrides = {
	/** Treat the GPU as an MSI card. Only needed for MSI cards carrying another vendor's BIOS. */
	gpu?: "msi";
};

/** Optional. Nothing needs to be configured; this exists for unusual hardware the auto-detection refuses to touch. */
export function readOverrides(): Overrides {
	const fromEnv = process.env.RGB_KILLSWITCH_GPU === "msi" ? { gpu: "msi" as const } : {};
	try {
		const file = JSON.parse(fs.readFileSync(path.join(stateDir(), "overrides.json"), "utf8")) as Overrides;
		return { ...file, ...fromEnv };
	} catch {
		return fromEnv;
	}
}
