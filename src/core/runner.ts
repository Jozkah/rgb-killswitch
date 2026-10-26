import { Worker } from "node:worker_threads";
import type { AuraOn } from "./aura.js";
import type { RazerZone } from "./razer.js";
import type { Backend, Command, Reply } from "./worker.js";
import type { Group, Log } from "./types.js";

const BACKENDS: { name: Backend; group: Group }[] = [
	{ name: "aura", group: "case" },
	{ name: "gpu", group: "case" },
	{ name: "razer", group: "peripherals" },
];

export type Detected = { aura: boolean; gpu: boolean; razer: boolean };
export type RazerState = { zones: RazerZone[]; saved: Record<string, number> };

class Device {
	private readonly worker: Worker;
	private readonly pending = new Map<number, (reply: Reply) => void>();
	private nextId = 0;

	constructor(
		readonly name: Backend,
		readonly group: Group,
		workerPath: string,
		private readonly log: Log,
	) {
		this.worker = new Worker(workerPath, { workerData: { backend: name } });
		this.worker.on("message", (reply: Reply) => {
			for (const m of reply.logs) this.log(`${name}: ${m}`);
			if (reply.error) this.log(`${name} failed: ${reply.error}`);
			this.pending.get(reply.id)?.(reply);
			this.pending.delete(reply.id);
		});
		this.worker.on("error", (e) => {
			this.log(`${name} worker crashed: ${String(e)}`);
			for (const done of this.pending.values()) done({ id: -1, logs: [] });
			this.pending.clear();
		});
	}

	send(command: Command): Promise<Reply> {
		const id = this.nextId++;
		return new Promise((resolve) => {
			this.pending.set(id, resolve);
			this.worker.postMessage({ ...command, id });
		});
	}

	stop(): Promise<number> {
		return this.worker.terminate();
	}
}

/**
 * Detects the hardware it knows how to drive and switches every family from its own thread, so they all change together.
 * Nothing needs configuring: a family with no matching hardware is skipped.
 */
export class Runner {
	private constructor(
		private readonly devices: Device[],
		readonly detected: Detected,
		readonly razer: RazerState,
	) {}

	/** `cachedRazer` skips the slow Razer probe when a previous run already found the zones. */
	static async create(workerPath: string, log: Log, cachedRazer?: RazerZone[]): Promise<Runner> {
		const devices = BACKENDS.map((b) => new Device(b.name, b.group, workerPath, log));
		const replies = await Promise.all(devices.map((d) => d.send({ action: "warm", razer: d.name === "razer" && cachedRazer ? { zones: cachedRazer, saved: {} } : undefined })));
		const detected: Detected = { aura: false, gpu: false, razer: false };
		let razer: RazerState = { zones: [], saved: {} };
		devices.forEach((d, i) => {
			detected[d.name] = Boolean(replies[i].detected);
			if (d.name === "razer" && replies[i].razer) razer = replies[i].razer!;
		});
		return new Runner(devices, detected, razer);
	}

	private active(groups: Group[]): Device[] {
		return this.devices.filter((d) => groups.includes(d.group) && this.detected[d.name]);
	}

	/** Returns the Razer brightness levels to keep for `on`. */
	async off(groups: Group[], razerSaved: Record<string, number> = {}): Promise<Record<string, number>> {
		const replies = await Promise.all(this.active(groups).map((d) => d.send({ action: "off", razer: d.name === "razer" ? { zones: this.razer.zones, saved: razerSaved } : undefined })));
		return replies.find((r) => r.razer)?.razer?.saved ?? razerSaved;
	}

	async on(groups: Group[], aura: AuraOn, razerSaved: Record<string, number> = {}): Promise<void> {
		await Promise.all(this.active(groups).map((d) => d.send({ action: "on", aura, razer: d.name === "razer" ? { zones: this.razer.zones, saved: razerSaved } : undefined })));
	}

	async stop(): Promise<void> {
		await Promise.all(this.devices.map((d) => d.stop()));
	}
}
