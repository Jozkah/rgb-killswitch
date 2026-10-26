import koffi from "koffi";
import { readOverrides } from "./overrides.js";

// MSI RTX GPUs ("MSI GPU v2" in OpenRGB): lighting chip on NVAPI I2C port 1, address 0x68.
const ADDR = 0x68;
const PORT = 1;
const MSI_SUBSYSTEM_VENDOR = 0x1462;
const REG = { mode: 0x22, unknown: 0x2e, brightness: 0x36, speed: 0x38, control: 0x46 };
const MODE = { idle: 0x1c, off: 0x01, rainbow: 0x08 };

const I2C = koffi.struct("I2C", {
	version: "uint", displayMask: "uint", isDDC: "uint8", dev: "uint8", pReg: "void*", regSize: "uint",
	pData: "void*", cb: "uint", speed: "uint", speedKhz: "uint", portId: "uint8", isPortSet: "uint",
});
const ProtoInit = koffi.proto("int NvInit()");
const ProtoEnum = koffi.proto("int NvEnum(_Out_ uintptr_t *h, _Out_ uint *n)");
const ProtoIo = koffi.proto("int NvIo(uintptr_t h, I2C *i, _Inout_ uint *unk)");
const ProtoPci = koffi.proto("int NvPci(uintptr_t h, _Out_ uint *device, _Out_ uint *subsystem, _Out_ uint *revision, _Out_ uint *ext)");

const ID = { init: 0x0150e828, enumGpus: 0xe5ac921f, read: 0x4d7b0709, write: 0x283ac65a, pci: 0x2ddfb66e };

type Session = { query: (id: number) => unknown; gpu: number };
let session: Session | undefined | null;

function i2c(s: Session, write: boolean, reg: number, data: Buffer): number {
	const info = {
		version: koffi.sizeof(I2C) | (3 << 16), displayMask: 0, isDDC: 0, dev: ADDR << 1,
		pReg: Buffer.from([reg]), regSize: 1, pData: data, cb: data.length,
		speed: 0xffff, speedKhz: 0, portId: PORT, isPortSet: 1,
	};
	return koffi.call(s.query(write ? ID.write : ID.read), ProtoIo, s.gpu, info, [0]) as number;
}

/**
 * Finds the NVIDIA GPU carrying the MSI lighting chip. Writing to an unidentified chip is refused, so the card must be
 * MSI (or overridden by the user) and must answer on the chip's address.
 */
function open(): Session | null {
	if (session !== undefined) return session;
	session = null;
	if (process.platform !== "win32") return session;
	try {
		const query = koffi.load("nvapi64.dll").func("void* nvapi_QueryInterface(uint)") as (id: number) => unknown;
		koffi.call(query(ID.init), ProtoInit);
		const handles = new Array<number>(64).fill(0);
		const count = [0];
		koffi.call(query(ID.enumGpus), ProtoEnum, handles, count);
		const override = readOverrides().gpu === "msi";
		for (const gpu of handles.slice(0, count[0])) {
			const ids = [[0], [0], [0], [0]];
			koffi.call(query(ID.pci), ProtoPci, gpu, ids[0], ids[1], ids[2], ids[3]);
			const isMsi = (ids[1][0] & 0xffff) === MSI_SUBSYSTEM_VENDOR;
			if (!isMsi && !override) continue;
			const candidate = { query, gpu };
			if (i2c(candidate, false, REG.mode, Buffer.alloc(1)) === 0) return (session = candidate);
		}
	} catch {
		// No NVIDIA driver: nothing to control.
	}
	return session;
}

export function gpuDetect(): boolean {
	return open() !== null;
}

function write(reg: number, value: number): void {
	const s = open();
	if (!s) throw new Error("No supported GPU lighting chip found");
	const status = i2c(s, true, reg, Buffer.from([value]));
	if (status !== 0) throw new Error(`GPU I2C write 0x${reg.toString(16)} failed (${status})`);
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}

function setMode(mode: number): void {
	write(REG.unknown, 0);
	write(REG.mode, MODE.idle);
	write(REG.mode, mode);
}

export function gpuOff(): void {
	setMode(MODE.off);
}

/** The chip cannot report its effect, so "on" is the card's Rainbow Wave. */
export function gpuOn(): void {
	write(REG.unknown, 0);
	write(REG.mode, MODE.idle);
	write(REG.control, 0);
	write(REG.brightness, 100);
	write(REG.speed, 0x02);
	write(REG.mode, MODE.rainbow);
}
