import { parentPort, workerData } from "node:worker_threads";
import { auraDetect, auraOff, auraOn, type AuraOn } from "./aura.js";
import { CoreDriver } from "./commandercore.js";
import { gpuDetect, gpuOff, gpuOn } from "./gpu.js";
import { razerDiscover, razerOff, razerOn, type RazerZone } from "./razer.js";
import type { Log } from "./types.js";

export type Backend = "aura" | "gpu" | "razer";
export type Command = { action: "warm" | "off" | "on"; aura?: AuraOn; razer?: { zones: RazerZone[]; saved: Record<string, number> } };
export type Request = Command & { id: number };
export type Reply = { id: number; error?: string; logs: string[]; detected?: boolean; razer?: { zones: RazerZone[]; saved: Record<string, number> } };

// Each backend runs in its own thread: device I/O is blocking, so threads are what lets every family switch at the same moment.
const backend = workerData.backend as Backend | "core";
let razerZones: RazerZone[] = [];
const core = backend === "core" ? new CoreDriver(() => {}) : undefined;

function handle(req: Request, log: Log): Omit<Reply, "id" | "logs"> {
	if (backend === "aura") {
		if (req.action === "warm") return { detected: auraDetect() };
		if (req.action === "off") auraOff(log);
		else auraOn(req.aura ?? { mode: "rainbow" }, log);
	} else if (backend === "gpu") {
		if (req.action === "warm") return { detected: gpuDetect() };
		if (req.action === "off") gpuOff();
		else gpuOn();
	} else {
		if (req.razer?.zones.length) razerZones = req.razer.zones;
		if (req.action === "warm") {
			if (!razerZones.length) razerZones = razerDiscover(log);
			return { detected: razerZones.length > 0, razer: { zones: razerZones, saved: {} } };
		}
		const saved = { ...req.razer?.saved };
		if (req.action === "off") razerOff(razerZones, saved, log);
		else razerOn(razerZones, saved, log);
		return { razer: { zones: razerZones, saved } };
	}
	return {};
}

parentPort!.on("message", (req: Request) => {
	const logs: string[] = [];
	try {
		parentPort!.postMessage({ id: req.id, logs, ...handle(req, (m) => logs.push(m)) } satisfies Reply);
	} catch (e) {
		parentPort!.postMessage({ id: req.id, logs, error: String(e) } satisfies Reply);
	}
});
