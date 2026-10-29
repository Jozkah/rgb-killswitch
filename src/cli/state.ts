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

const fresh = (): State => ({ ...EMPTY, off: { ...EMPTY.off }, razerSaved: {} });

/** Undefined when the file cannot be read right now (missing, or briefly locked by a virus scanner). */
export function tryReadState(): State | undefined {
	try {
		return { ...fresh(), ...(JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<State>) };
	} catch {
		return undefined;
	}
}

export function readState(): State {
	return tryReadState() ?? fresh();
}

export function writeState(state: State): void {
	fs.mkdirSync(path.dirname(FILE), { recursive: true });
	const temp = `${FILE}.${process.pid}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(state, null, 2));
	fs.renameSync(temp, FILE); // atomic, so the holder never reads half a file
}

const BEAT_FILE = path.join(stateDir(), "holder.beat");
const BEAT_MAX_AGE_MS = 2_000;

/** The holder rewrites this file on a timer; a process id alone can be reused by an unrelated process. */
export function beat(): void {
	fs.mkdirSync(path.dirname(BEAT_FILE), { recursive: true });
	fs.writeFileSync(BEAT_FILE, String(process.pid));
}

export function clearBeat(): void {
	fs.rmSync(BEAT_FILE, { force: true });
}

export function holderAlive(): boolean {
	try {
		if (Date.now() - fs.statSync(BEAT_FILE).mtimeMs >= BEAT_MAX_AGE_MS) return false;
		process.kill(Number(fs.readFileSync(BEAT_FILE, "utf8")), 0); // throws when that process is gone
		return true;
	} catch {
		return false;
	}
}
