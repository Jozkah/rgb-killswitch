import HID from "node-hid";
import type { Log } from "./types.js";

// Corsair Commander CORE (pump and fan lighting hub). iCUE's SDK does not reach the lights on it, so this talks to it directly.
// Protocol as documented by OpenRGB's CorsairCommanderCoreController.
const VENDOR = 0x1b1c;
const PRODUCT = 0x0c32;
const USAGE_PAGE = 0xff42;
const PACKET_SIZE = 65;
const LED_COUNT = 233; // pump plus six 34-LED fan slots
const REFRESH_MS = 1000;
const READ_TIMEOUT_MS = 20;

export function commanderCorePresent(): boolean {
	return HID.devices().some((d) => d.vendorId === VENDOR && d.productId === PRODUCT && d.usagePage === USAGE_PAGE);
}

/** Holds the Commander CORE's lighting black. It falls back to its own effect if not refreshed, so it re-sends every second. */
export class CommanderCore {
	private dev: HID.HID | undefined;
	private timer: NodeJS.Timeout | undefined;

	constructor(private readonly log: Log) {}

	start(): void {
		if (this.timer) return;
		const info = HID.devices().find((d) => d.vendorId === VENDOR && d.productId === PRODUCT && d.usagePage === USAGE_PAGE && d.usage === 1);
		if (!info?.path) return;
		try {
			this.dev = new HID.HID(info.path);
			this.command(0x02, 0x13, []);
			// Fan setup first, then software control; without both the CORE ignores color data.
			this.writeData([0x1e, 0], [0x0d, 0], [0x07, 0x01, 0x08, ...Array.from({ length: 6 }, () => [0x01, 0x06]).flat()]);
			this.command(0x01, 0x03, [0x00, 0x02]);
			this.paint();
			this.timer = setInterval(() => this.paint(), REFRESH_MS);
			this.log("Commander CORE: holding black");
		} catch (e) {
			this.log(`Commander CORE error ${String(e)}`);
			this.stop();
		}
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		try {
			this.dev?.close();
		} catch {
			// already closed
		}
		this.dev = undefined;
	}

	private paint(): void {
		try {
			this.writeData([0x22, 0], [0x12, 0], new Array(LED_COUNT * 3).fill(0));
		} catch (e) {
			this.log(`Commander CORE error ${String(e)}`);
			this.stop();
		}
	}

	private command(a: number, b: number, data: number[]): void {
		const buf = new Array<number>(PACKET_SIZE).fill(0);
		buf[1] = 0x08;
		buf[2] = a;
		buf[3] = b;
		data.forEach((v, i) => (buf[4 + i] = v));
		this.dev?.write(buf);
		this.dev?.readTimeout(READ_TIMEOUT_MS);
	}

	private writeData(endpoint: number[], type: number[], data: number[]): void {
		this.command(0x0d, 0x00, endpoint);
		let sent = 0;
		while (sent < data.length) {
			if (sent === 0) {
				const n = Math.min(data.length, PACKET_SIZE - 10);
				const real = data.length + 2;
				this.command(0x06, 0x00, [real & 0xff, real >> 8, 0, 0, ...type, ...data.slice(0, n)]);
				sent += n;
			} else {
				const n = Math.min(data.length - sent, PACKET_SIZE - 4);
				this.command(0x07, 0x00, data.slice(sent, sent + n));
				sent += n;
			}
		}
		this.command(0x05, 0x01, []);
	}
}
