import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findIcueDll, GROUPS, Icue, Runner, type AuraOn, type Group } from "../core/index.js";
import { stateDir } from "../core/paths.js";
import { beat, holderAlive, readState, writeState, type State } from "./state.js";

const HELP = `rgb: turn the RGB lighting in your PC off and on. No setup needed.

  rgb off [case|all]       turn lighting off          (default: all)
  rgb on [case|all]        turn it back on
  rgb toggle [case|all]    off if anything is lit, otherwise on
  rgb status               show what was found and what is off

  case  = motherboard, GPU, RAM, fans and other things inside the PC
  all   = case plus keyboard, mouse, mousepad and headset

  --color RRGGBB           on: use this color for the motherboard instead of a rainbow
`;

const WORKER = path.join(__dirname, "worker.cjs");
const VENDOR = path.join(__dirname, "..", "vendor");
const HOLDER_POLL_MS = 250;
const ACK_TIMEOUT_MS = 4_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const log = (m: string): void => console.error(m);

function parseColor(value: string | undefined): AuraOn {
	const hex = value?.replace("#", "");
	if (!hex) return { mode: "rainbow" };
	if (!/^[0-9a-f]{6}$/i.test(hex)) throw new Error(`--color expects RRGGBB, got "${value}"`);
	return { mode: "static", color: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number] };
}

/** iCUE only keeps lighting changes while a program stays connected, so a small background process holds the session. */
async function holder(): Promise<void> {
	const dll = findIcueDll([VENDOR]);
	if (!dll) return;
	// RGB_KILLSWITCH_DEBUG=1 writes what the background process does to holder.log in the state folder.
	const debugFile = process.env.RGB_KILLSWITCH_DEBUG ? path.join(stateDir(), "holder.log") : undefined;
	const note = (m: string): void => {
		if (debugFile) fs.appendFileSync(debugFile, `${new Date().toISOString()} ${m}
`);
	};
	const icue = new Icue(dll, WORKER, note);
	note(`holder started, pid ${process.pid}`);
	const applied: Record<Group, boolean> = { case: false, peripherals: false };
	for (;;) {
		beat();
		const state = readState();
		const changed = GROUPS.filter((g) => state.off[g] !== applied[g]);
		const release = changed.filter((g) => !state.off[g]);
		for (const group of changed.filter((g) => state.off[g])) {
			note(`${group}: blackout`);
			icue.blackout(group);
		}
		if (release.length) {
			note(`${release.join(", ")}: release`);
			await icue.release(...release);
		}
		for (const group of changed) applied[group] = state.off[group];
		if (changed.length) note(`applied ${changed.join(", ")}`);
		if (state.holderPid === process.pid && state.ack !== state.seq) {
			writeState({ ...readState(), ack: state.seq });
			note(`ack ${state.seq}`);
		}
		if (!state.off.case && !state.off.peripherals && !applied.case && !applied.peripherals) process.exit(0);
		await sleep(HOLDER_POLL_MS);
	}
}

function ensureHolder(state: State): void {
	if (!findIcueDll([VENDOR]) || holderAlive()) return;
	const child = spawn(process.execPath, [__filename, "--hold"], { detached: true, stdio: "ignore", windowsHide: true });
	child.unref();
	state.holderPid = child.pid;
}

async function waitForHolder(seq: number): Promise<void> {
	const deadline = Date.now() + ACK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const state = readState();
		if (!holderAlive() || state.ack >= seq) return;
		await sleep(HOLDER_POLL_MS / 2);
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "--hold") return holder();

	const colorAt = args.indexOf("--color");
	const aura = parseColor(colorAt >= 0 ? args[colorAt + 1] : undefined);
	const positional = args.filter((a, i) => !a.startsWith("--") && !(colorAt >= 0 && i === colorAt + 1));
	const [command, scope = "all"] = positional;

	if (!command || command === "help" || args.includes("--help") || args.includes("-h")) return void console.log(HELP);
	if (!["off", "on", "toggle", "status"].includes(command)) throw new Error(`Unknown command "${command}". Try: rgb --help`);
	if (!["case", "all"].includes(scope)) throw new Error(`Unknown scope "${scope}". Use case or all.`);

	const state = readState();
	const runner = await Runner.create(WORKER, log, state.razerZones);
	try {
		if (command === "status") {
			const found = Object.entries(runner.detected).filter(([, v]) => v).map(([k]) => k);
			const razerNames = [...new Set(runner.razer.zones.map((z) => z.name))];
			if (razerNames.length) found.push(`(razer: ${razerNames.join(", ")})`);
			if (findIcueDll([VENDOR])) found.push("icue (if iCUE is running)");
			console.log(`found:   ${found.join(", ") || "nothing supported"}`);
			console.log(`case:    ${state.off.case ? "off" : "on"}`);
			console.log(`devices: ${state.off.peripherals ? "off" : "on"}`);
			return;
		}

		const groups: Group[] = scope === "case" ? ["case"] : [...GROUPS];
		const off = command === "toggle" ? !groups.every((g) => state.off[g]) : command === "off";

		if (off) state.razerSaved = await runner.off(groups, state.razerSaved);
		else await runner.on(groups, aura, state.razerSaved);

		for (const g of groups) state.off[g] = off;
		state.razerZones = runner.razer.zones;
		state.seq++;
		if (off) ensureHolder(state);
		writeState(state);
		await waitForHolderIfNeeded(state, off);
		console.log(off ? "RGB off" : "RGB on");
	} finally {
		await runner.stop();
	}
}

/** Turning on must not return before iCUE has been handed back; turning off does not need to wait. */
async function waitForHolderIfNeeded(state: State, off: boolean): Promise<void> {
	if (!off) await waitForHolder(state.seq);
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
});
