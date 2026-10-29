import koffi from "koffi";

const LastInputInfo = koffi.struct("LASTINPUTINFO", { cbSize: "uint", dwTime: "uint" });

// Loaded on first use so that importing this module on a system without these DLLs does not fail.
let api: { getLastInputInfo: (info: object) => boolean; getTickCount: () => number } | undefined;
function load(): NonNullable<typeof api> {
	api ??= {
		getLastInputInfo: koffi.load("user32.dll").func("bool GetLastInputInfo(_Inout_ LASTINPUTINFO *info)"),
		getTickCount: koffi.load("kernel32.dll").func("uint GetTickCount()"),
	};
	return api;
}

/** Milliseconds since the last keyboard or mouse input anywhere in the user's session. */
export function idleMs(): number {
	const { getLastInputInfo, getTickCount } = load();
	const info = { cbSize: koffi.sizeof(LastInputInfo), dwTime: 0 };
	if (!getLastInputInfo(info)) return 0;
	return (getTickCount() - info.dwTime) >>> 0;
}
