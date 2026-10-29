import HID from "node-hid";
import type { Log } from "./types.js";

// Razer's lighting protocol over HID feature reports (the wire format OpenRazer and OpenRGB use).
// Lighting is switched through brightness, so the previous level can be restored exactly.
const VID = 0x1532;
const REPORT_SIZE = 91; // report id + 90 bytes
const STATUS_SUCCESS = 0x02;
const STORAGE_PERSIST = 0x01; // some keyboards ignore brightness writes that are not stored
const FALLBACK_BRIGHTNESS = 0xff;
const COMMAND_PAUSE_MS = 20;
const WRITE_PAUSE_MS = 5;

// Interfaces that carry the vendor control channel on the devices OpenRGB documents.
const CONTROL_INTERFACES = [
	{ usagePage: 0x01, usage: 0x02 },
	{ usagePage: 0x01, usage: 0x03 },
	{ usagePage: 0x01, usage: 0x00 },
	{ usagePage: 0x0c, usage: 0x01 },
];
const TRANSACTION_IDS = [0x1f, 0x3f, 0xff];
// Extended-matrix devices use class 0x0F, older ones the standard matrix class 0x03.
const COMMAND_SETS = [
	{ commandClass: 0x0f, set: 0x04, get: 0x84 },
	{ commandClass: 0x03, set: 0x03, get: 0x83 },
];
const LED_IDS = [0x05, 0x04, 0x01, 0x00, 0x02, 0x03, 0x06, 0x07];

export type RazerZone = {
	name: string;
	pid: number;
	interface: number;
	transactionId: number;
	commandClass: number;
	set: number;
	get: number;
	led: number;
};

const deviceKey = (z: Pick<RazerZone, "pid" | "interface">): string => `${z.pid}:${z.interface}`;
const zoneKey = (z: RazerZone): string => `${deviceKey(z)}:${z.led}`;

function report(zone: Pick<RazerZone, "transactionId" | "commandClass">, command: number, led: number, brightness: number): number[] {
	const buf = new Array<number>(REPORT_SIZE).fill(0);
	buf[2] = zone.transactionId;
	buf[6] = 3; // data size
	buf[7] = zone.commandClass;
	buf[8] = command;
	buf[9] = STORAGE_PERSIST;
	buf[10] = led;
	buf[11] = brightness;
	buf[89] = buf.slice(3, 89).reduce((x, b) => x ^ b, 0);
	return buf;
}

function pause(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function openPath(path: string, log: Log): HID.HID | undefined {
	try {
		return new HID.HID(path);
	} catch (e) {
		log(`Razer device failed to open: ${String(e)}`);
		return undefined;
	}
}

let cachedPaths = new Map<string, string>();

function enumerate(): HID.Device[] {
	return HID.devices().filter(
		(d) => d.vendorId === VID && d.path && CONTROL_INTERFACES.some((c) => c.usagePage === d.usagePage && c.usage === d.usage),
	);
}

/**
 * Finds every lighting zone that answers a brightness query. Only read queries are sent while probing, and only to the
 * interfaces Razer uses for control. Slow (it waits for each answer), so callers cache the result.
 */
export function razerDiscover(log: Log): RazerZone[] {
	const zones: RazerZone[] = [];
	for (const info of enumerate()) {
		const dev = openPath(info.path!, log);
		if (!dev) continue;
		try {
			const found = probe(dev, info);
			if (found.length) cachedPaths.set(deviceKey({ pid: info.productId, interface: info.interface }), info.path!);
			zones.push(...found);
		} finally {
			dev.close();
		}
	}
	return zones;
}

function probe(dev: HID.HID, info: HID.Device): RazerZone[] {
	for (const transactionId of TRANSACTION_IDS) {
		for (const set of COMMAND_SETS) {
			const zones: RazerZone[] = [];
			for (const led of LED_IDS) {
				try {
					dev.sendFeatureReport(report({ transactionId, commandClass: set.commandClass }, set.get, led, 0));
					pause(COMMAND_PAUSE_MS);
					const r = dev.getFeatureReport(0, REPORT_SIZE);
					if (r[1] === STATUS_SUCCESS && r[7] === set.commandClass && r[8] === set.get) {
						zones.push({
							name: info.product || `Razer ${info.productId.toString(16)}`,
							pid: info.productId,
							interface: info.interface,
							transactionId,
							commandClass: set.commandClass,
							set: set.set,
							get: set.get,
							led,
						});
					}
				} catch {
					return [];
				}
			}
			if (zones.length) return zones;
		}
	}
	return [];
}

type Open = { dev: HID.HID; zones: RazerZone[] };

function openZones(zones: RazerZone[], log: Log): Open[] {
	const byDevice = new Map<string, RazerZone[]>();
	for (const z of zones) byDevice.set(deviceKey(z), [...(byDevice.get(deviceKey(z)) ?? []), z]);
	const tryOpen = (): Open[] => {
		const opened: Open[] = [];
		for (const [key, list] of byDevice) {
			const path = cachedPaths.get(key);
			const dev = path ? openPath(path, log) : undefined;
			if (dev) opened.push({ dev, zones: list });
		}
		return opened;
	};
	const first = tryOpen();
	if (first.length === byDevice.size) return first;
	first.forEach((o) => o.dev.close());
	// Paths go stale when a device is replugged (or this is a fresh process); look them up again.
	cachedPaths = new Map(enumerate().map((d) => [deviceKey({ pid: d.productId, interface: d.interface }), d.path!]));
	return tryOpen();
}

/** Sends one command to every device, waits once, then reads every answer, so the devices work in parallel. */
function roundTrip(devices: Open[], round: number, command: (z: RazerZone) => number[], read?: (z: RazerZone, response: number[]) => void): void {
	const active = devices.filter((o) => o.zones[round]);
	for (const o of active) o.dev.sendFeatureReport(command(o.zones[round]));
	// Writes need no answer, so they only wait long enough for the next round not to collide.
	pause(read ? COMMAND_PAUSE_MS : WRITE_PAUSE_MS);
	if (read) for (const o of active) read(o.zones[round], o.dev.getFeatureReport(0, REPORT_SIZE));
}

function run(zones: RazerZone[], log: Log, fn: (devices: Open[], rounds: number) => void): void {
	if (!zones.length) return;
	const devices = openZones(zones, log);
	try {
		fn(devices, Math.max(0, ...devices.map((o) => o.zones.length)));
	} catch (e) {
		log(`Razer failed: ${String(e)}`);
	} finally {
		devices.forEach((o) => o.dev.close());
	}
}

const SETTLE_MS = 60;
// Anything below this is a keyboard caught mid-fade, not a brightness anyone picked.
const MIN_SAVED_LEVEL = 26;
const usable = (level: number | undefined): level is number => level !== undefined && level >= MIN_SAVED_LEVEL;

/**
 * `saved` receives each zone's brightness so razerOn can restore it, even from another process.
 * Keyboards fade their brightness, so a reading is only trusted when two reads a moment apart agree; otherwise
 * a mid-fade value (say 4) would be saved as the user's level and restored as a dim keyboard.
 */
export function razerOff(zones: RazerZone[], saved: Record<string, number>, log: Log): void {
	run(zones, log, (devices, rounds) => {
		const readAll = (): Map<string, number> => {
			const levels = new Map<string, number>();
			for (let i = 0; i < rounds; i++) {
				roundTrip(devices, i, (z) => report(z, z.get, z.led, 0), (z, r) => {
					if (r[1] === STATUS_SUCCESS) levels.set(zoneKey(z), r[11]);
				});
			}
			return levels;
		};
		// Known levels skip the reads, which are what made turning off slow.
		if (!devices.every((d) => d.zones.every((z) => usable(saved[zoneKey(z)])))) {
			const first = readAll();
			pause(SETTLE_MS);
			const second = readAll();
			for (const [key, level] of second) if (usable(level) && first.get(key) === level) saved[key] = level;
		}
		for (let i = 0; i < rounds; i++) roundTrip(devices, i, (z) => report(z, z.set, z.led, 0));
	});
}

export function razerOn(zones: RazerZone[], saved: Record<string, number>, log: Log): void {
	run(zones, log, (devices, rounds) => {
		for (let i = 0; i < rounds; i++) roundTrip(devices, i, (z) => report(z, z.set, z.led, (usable(saved[zoneKey(z)]) ? saved[zoneKey(z)] : FALLBACK_BRIGHTNESS)));
	});
}

/** Reads each zone's current brightness without changing anything. */
export function razerLevels(zones: RazerZone[], log: Log): Record<string, number> {
	const levels: Record<string, number> = {};
	run(zones, log, (devices, rounds) => {
		for (let i = 0; i < rounds; i++) {
			roundTrip(devices, i, (z) => report(z, z.get, z.led, 0), (z, r) => {
				if (r[1] === STATUS_SUCCESS) levels[zoneKey(z)] = r[11];
			});
		}
	});
	return levels;
}
