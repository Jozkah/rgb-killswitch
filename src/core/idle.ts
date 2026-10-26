import koffi from "koffi";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const LastInputInfo = koffi.struct("LASTINPUTINFO", { cbSize: "uint", dwTime: "uint" });
const getLastInputInfo = user32.func("bool GetLastInputInfo(_Inout_ LASTINPUTINFO *info)");
const getTickCount = kernel32.func("uint GetTickCount()");

/** Milliseconds since the last keyboard or mouse input anywhere in the user's session. */
export function idleMs(): number {
	const info = { cbSize: koffi.sizeof(LastInputInfo), dwTime: 0 };
	if (!getLastInputInfo(info)) return 0;
	return (getTickCount() - info.dwTime) >>> 0;
}
