import os from "node:os";
import path from "node:path";

/** Where the CLI keeps its state; also where an optional overrides.json can live. */
export function stateDir(): string {
	if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "rgb-killswitch");
	return path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"), "rgb-killswitch");
}
