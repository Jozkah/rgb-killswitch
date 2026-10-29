import fs from "node:fs";
import path from "node:path";
import koffi from "koffi";
import { CommanderCore } from "./commandercore.js";
import type { Group, Log } from "./types.js";

const CSS_CONNECTED = 6;
const CDT_ALL = -1;
const MAX_DEVICES = 64;
const MAX_LEDS = 512;
const DISCONNECT_TIMEOUT_MS = 3000;

const Version = koffi.struct("CorsairVersion", { major: "int", minor: "int", patch: "int" });
const Details = koffi.struct("CorsairSessionDetails", { client: Version, server: Version, host: Version });
const SessionState = koffi.struct("CorsairSessionStateChanged", { state: "int", details: Details });
const Handler = koffi.proto("void CorsairSessionStateChangedHandler(void *context, const CorsairSessionStateChanged *data)");
const DeviceInfo = koffi.struct("CorsairDeviceInfo", {
	type: "int",
	id: koffi.array("char", 128, "String"),
	serial: koffi.array("char", 128, "String"),
	model: koffi.array("char", 128, "String"),
	ledCount: "int",
	channelCount: "int",
});
const Filter = koffi.struct("CorsairDeviceFilter", { mask: "int" });
const LedPosition = koffi.struct("CorsairLedPosition", { id: "uint", cx: "double", cy: "double" });
const LedColor = koffi.struct("CorsairLedColor", { id: "uint", r: "uint8", g: "uint8", b: "uint8", a: "uint8" });

// CorsairDeviceType values for things that live outside the case.
const PERIPHERAL_TYPES = 0x0001 | 0x0002 | 0x0004 | 0x0008 | 0x0010 | 0x0800 | 0x1000;

type BlackDevice = { id: string; group: Group; colors: object[] };

export class Icue {
	private readonly lib;
	private readonly connect;
	private readonly disconnect;
	private readonly getDevices;
	private readonly getPositions;
	private readonly setColors;
	private readonly callback: unknown;
	private readonly blackedOut = new Set<Group>();
	private releasing: Promise<void> = Promise.resolve();
	private devices: BlackDevice[] = [];
	private readonly core: CommanderCore;

	/** Connects right away and stays connected, so the blackout can paint instantly instead of waiting for the handshake. */
	constructor(dllPath: string, workerPath: string, private readonly log: Log) {
		this.core = new CommanderCore(workerPath, log);
		this.lib = koffi.load(dllPath);
		this.connect = this.lib.func("int CorsairConnect(CorsairSessionStateChangedHandler *cb, void *ctx)");
		this.disconnect = this.lib.func("int CorsairDisconnect()");
		this.getDevices = this.lib.func("int CorsairGetDevices(const CorsairDeviceFilter *f, int max, _Out_ CorsairDeviceInfo *d, _Out_ int *n)");
		this.getPositions = this.lib.func("int CorsairGetLedPositions(const char *id, int max, _Out_ CorsairLedPosition *p, _Out_ int *n)");
		this.setColors = this.lib.func("int CorsairSetLedColors(const char *id, int n, const CorsairLedColor *c)");
		this.callback = koffi.register((_ctx: unknown, data: unknown) => {
			const state = (koffi.decode(data, SessionState) as { state: number }).state;
			this.log(`iCUE session state ${state}`);
			if (state === CSS_CONNECTED) setImmediate(() => this.onConnected());
		}, koffi.pointer(Handler));
		this.open();
	}

	/** Paints the group's LEDs black and keeps them black until release(). Re-applies after iCUE restarts. */
	blackout(group: Group): void {
		this.blackedOut.add(group);
		this.paintBlack();
		if (group === "case") this.core.start();
	}

	/**
	 * Dropping the session hands lighting back to iCUE's own profile (the SDK has no per-device undo), so it releases every
	 * group; any group that should stay black is repainted as soon as the session is back, a few milliseconds later.
	 */
	release(...groups: Group[]): Promise<void> {
		for (const g of groups) this.blackedOut.delete(g);
		if (groups.includes("case")) this.core.stop();
		// One disconnect at a time: a second one issued while the first is in flight never completes.
		this.releasing = this.releasing.then(() => this.reconnect());
		return this.releasing;
	}

	private reconnect(): Promise<void> {
		return new Promise((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.devices = [];
				this.open();
				resolve();
			};
			// A key press must never hang on the SDK, so give up waiting and reconnect anyway.
			const timer = setTimeout(() => {
				this.log("CorsairDisconnect timed out");
				finish();
			}, DISCONNECT_TIMEOUT_MS);
			// Synchronous disconnect deadlocks: the SDK fires a state callback that needs this thread.
			this.disconnect.async((err: unknown) => {
				if (err) this.log(`CorsairDisconnect error ${String(err)}`);
				finish();
			});
		});
	}

	private open(): void {
		const err = this.connect(this.callback, null);
		if (err !== 0) this.log(`CorsairConnect error ${err}`);
	}

	private onConnected(): void {
		this.devices = this.listDevices();
		this.paintBlack();
	}

	/** LED lists are looked up once per connection; they are what made the blackout slow. */
	private listDevices(): BlackDevice[] {
		const found: object[] = Array.from({ length: MAX_DEVICES }, () => ({}));
		const count = [0];
		if (this.getDevices({ mask: CDT_ALL }, MAX_DEVICES, found, count) !== 0) return [];
		const devices: BlackDevice[] = [];
		for (const device of found.slice(0, count[0]) as { id: string; type: number }[]) {
			const id = device.id.replace(/\0.*$/, "");
			const positions: object[] = Array.from({ length: MAX_LEDS }, () => ({}));
			const n = [0];
			if (this.getPositions(id, MAX_LEDS, positions, n) !== 0) continue;
			const colors = (positions.slice(0, n[0]) as { id: number }[]).map((p) => ({ id: p.id, r: 0, g: 0, b: 0, a: 255 }));
			if (colors.length) devices.push({ id, group: device.type & PERIPHERAL_TYPES ? "peripherals" : "case", colors });
		}
		return devices;
	}

	private paintBlack(): void {
		const targets = this.devices.filter((d) => this.blackedOut.has(d.group));
		if (!targets.length) {
			if (this.blackedOut.size) this.log("iCUE: no devices to paint yet; waiting for the session");
			return;
		}
		const failed: string[] = [];
		for (const { id, colors } of targets) if (this.setColors(id, colors.length, colors) !== 0) failed.push(id);
		this.log(`iCUE: painted ${targets.length - failed.length}/${targets.length} devices black${failed.length ? ` (failed: ${failed.join(", ")})` : ""}`);
	}
}

const DLL_NAME = "iCUESDK.x64_2019.dll";

/** The SDK DLL is downloaded from Corsair at install time (see scripts/fetch-icue-sdk.mjs); `directories` are searched in order. */
export function findIcueDll(directories: string[]): string | undefined {
	if (process.platform !== "win32" || process.arch !== "x64") return undefined;
	return directories.map((d) => path.join(d, DLL_NAME)).find((p) => fs.existsSync(p));
}
