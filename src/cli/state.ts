import fs from "node:fs";
import path from "node:path";
import type { Group, RazerZone } from "../core/index.js";
import { stateDir } from "../core/paths.js";

/** Everything the CLI needs to remember between runs. A run is a separate process, so this is the only memory. */
export type State = {
	off: Record<Group, boolean>;
	/** Razer brightness levels to restore; Razer lighting is switched through brightness. */
	razerSaved: Record<string, number>;
	/** The slow Razer probe is done once and cached here. */
	razerZones?: RazerZone[];
	/** Bumped on every change; the background iCUE holder echoes it back in `ack` once it has applied it. */
	seq: number;
	ack: number;
	holderPid?: number;
};

const FILE = path.join(stateDir(), "state.json");

const EMPTY: State = { off: { case: false, peripherals: false }, razerSaved: {}, seq: 0, ack: 0 };

export function readState(): State {
	try {
		return { ...EMPTY, ...(JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<State>) };
	} catch {
		return { ...EMPTY, off: { ...EMPTY.off }, razerSaved: {} };
	}
}

export function writeState(state: State): void {
	fs.mkdirSync(path.dirname(FILE), { recursive: true });
	const temp = `${FILE}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(state, null, 2));
	fs.renameSync(temp, FILE); // atomic, so the holder never reads half a file
}

const BEAT_FILE = path.join(stateDir(), "holder.beat");
const BEAT_MAX_AGE_MS = 2_000;

/** The holder touches this file every poll; a process id alone can be reused by an unrelated process. */
export function beat(): void {
	fs.mkdirSync(path.dirname(BEAT_FILE), { recursive: true });
	fs.writeFileSync(BEAT_FILE, String(process.pid));
}

export function holderAlive(): boolean {
	try {
		return Date.now() - fs.statSync(BEAT_FILE).mtimeMs < BEAT_MAX_AGE_MS;
	} catch {
		return false;
	}
}
