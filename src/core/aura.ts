import HID from "node-hid";
import type { Log } from "./types.js";

// ASUS Aura USB mainboard controllers. Protocol and device IDs follow OpenRGB's AsusAuraUSBController.
const VID = 0x0b05;
const PIDS = [0x18f3, 0x1939, 0x19af, 0x1aa6, 0x1bed];
const USAGE_PAGE = 0xff72;
const MODE_OFF = 0x00;
const MODE_RAINBOW = 0x05;
const MODE_DIRECT = 0xff;
const MAINBOARD_DIRECT_CHANNEL = 0x04;
const LEDS_PER_PACKET = 20;
const MAX_ARGB_LEDS = 120;

export type AuraOn = { mode: "rainbow" } | { mode: "static"; color: [number, number, number] };

type Board = { path: string; argbHeaders: number; mainboardLeds: number };

function packet(...bytes: number[]): number[] {
	const buf = new Array<number>(65).fill(0);
	buf[0] = 0xec;
	bytes.forEach((b, i) => (buf[i + 1] = b));
	return buf;
}

/** The firmware's config table says how many addressable headers and onboard LEDs this board has. */
function readBoard(path: string): Board | undefined {
	let dev: HID.HID | undefined;
	try {
		dev = new HID.HID(path);
		dev.write(packet(0xb0));
		const reply = dev.readTimeout(1000);
		if (reply[1] !== 0x30) return undefined;
		const table = reply.slice(4);
		return { path, argbHeaders: table[0x02], mainboardLeds: table[0x1b] };
	} catch {
		return undefined;
	} finally {
		dev?.close();
	}
}

let boards: Board[] | undefined;

/** HID.devices() is slow, so boards are discovered once per process. */
function discover(): Board[] {
	if (boards) return boards;
	const found: Board[] = [];
	const seen = new Set<number>();
	const candidates = HID.devices().filter((d) => d.vendorId === VID && PIDS.includes(d.productId));
	// Prefer the vendor-defined interface; some boards expose a single unfiltered one.
	candidates.sort((a, b) => Number(b.usagePage === USAGE_PAGE) - Number(a.usagePage === USAGE_PAGE));
	for (const info of candidates) {
		if (!info.path || seen.has(info.productId)) continue;
		const board = readBoard(info.path);
		if (!board) continue;
		seen.add(info.productId);
		found.push(board);
	}
	return (boards = found);
}

export function auraDetect(): boolean {
	return discover().length > 0;
}

function withBoards(fn: (dev: HID.HID, board: Board) => void, log: Log): void {
	for (const board of discover()) {
		let dev: HID.HID | undefined;
		try {
			dev = new HID.HID(board.path);
			fn(dev, board);
		} catch (e) {
			log(`Aura board failed: ${String(e)}`);
		} finally {
			dev?.close();
		}
	}
}

/** Effect channels: 0 is the onboard LEDs on most firmwares, the addressable headers follow. Covering 0..headers handles both orderings. */
function setMode(dev: HID.HID, board: Board, mode: number): void {
	for (let ch = 0; ch <= board.argbHeaders; ch++) dev.write(packet(0x35, ch, 0, 0, mode));
	dev.write(packet(0x3f, 0x55));
}

function directFill(dev: HID.HID, board: Board, color: [number, number, number]): void {
	const fill = (channel: number, leds: number): void => {
		for (let start = 0; start < leds; start += LEDS_PER_PACKET) {
			const count = Math.min(LEDS_PER_PACKET, leds - start);
			const last = start + count >= leds;
			dev.write(packet(0x40, (last ? 0x80 : 0) | channel, start, count, ...Array.from({ length: count }, () => color).flat()));
		}
	};
	for (let ch = 0; ch < board.argbHeaders; ch++) fill(ch, MAX_ARGB_LEDS);
	if (board.mainboardLeds > 0) fill(MAINBOARD_DIRECT_CHANNEL, board.mainboardLeds);
}

// The "off" effect alone leaves RGB-synced devices lit, so black is also pushed in direct mode.
export function auraOff(log: Log): void {
	withBoards((dev, board) => {
		setMode(dev, board, MODE_OFF);
		setMode(dev, board, MODE_DIRECT);
		directFill(dev, board, [0, 0, 0]);
	}, log);
}

/** The controller cannot report the effect it had, so "on" is a rainbow or a fixed color. */
export function auraOn(on: AuraOn, log: Log): void {
	withBoards((dev, board) => {
		if (on.mode === "rainbow") return setMode(dev, board, MODE_RAINBOW);
		setMode(dev, board, MODE_DIRECT);
		directFill(dev, board, on.color);
	}, log);
}
