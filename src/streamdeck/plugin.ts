import streamDeck, { action, SingletonAction, type DidReceiveSettingsEvent, type KeyDownEvent, type WillAppearEvent } from "@elgato/streamdeck";
import path from "node:path";
import { findIcueDll, GROUPS, Icue, idleMs, Runner, type AuraOn, type Group } from "../core/index.js";

type Settings = { mode?: "rainbow" | "static"; color?: string };
type IdleSettings = { minutes?: string };
type Globals = {
	caseOff?: boolean;
	peripheralsOff?: boolean;
	idleEnabled?: boolean;
	idleMinutes?: number;
	auraSettings?: Settings;
	/** Razer brightness levels to restore. Kept here so they survive a plugin restart. */
	razerSaved?: Record<string, number>;
};

const logger = streamDeck.logger.createScope("rgb-toggle");
const log = (m: string): void => {
	logger.info(m);
};

// Stream Deck runs the plugin from its own folder (bin/plugin.js); the DLL sits in lib/.
const dll = findIcueDll([path.join(__dirname, "..", "lib")]);
const icue = dll ? new Icue(dll, log) : undefined;
if (!dll) log("iCUE SDK not found; Corsair devices will be skipped");

/** Detects the hardware once, in the background, and keeps one worker thread per device family warm. */
const runner = Runner.create(path.join(__dirname, "worker.js"), log);
void runner.then((r) => log(`found: ${Object.entries(r.detected).filter(([, v]) => v).map(([k]) => k).join(", ") || "nothing"}`));

function onEffect(s: Settings): AuraOn {
	if (s.mode !== "static") return { mode: "rainbow" };
	const hex = (s.color ?? "#ffffff").replace("#", "");
	return { mode: "static", color: [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0) as [number, number, number] };
}

const getGlobals = (): Promise<Globals> => streamDeck.settings.getGlobalSettings<Globals>();
const setGlobals = (patch: Globals): Promise<void> => getGlobals().then((g) => streamDeck.settings.setGlobalSettings<Globals>({ ...g, ...patch }));

async function setGroups(groups: Group[], off: boolean): Promise<void> {
	try {
		const { auraSettings, razerSaved } = await getGlobals();
		const r = await runner;
		if (off) {
			const done = r.off(groups, razerSaved ?? {});
			for (const g of groups) icue?.blackout(g);
			await setGlobals({ razerSaved: await done });
		} else {
			await Promise.all([r.on(groups, onEffect(auraSettings ?? {}), razerSaved ?? {}), ...groups.map((g) => icue?.release(g))]);
		}
	} catch (e) {
		logger.error(`toggle failed: ${String(e)}`);
	}
}

const IDLE_POLL_MS = 5_000;
const DEFAULT_IDLE_MINUTES = 5;
const RESUME_IDLE_MS = 2_000;

/** Groups the idle timer switched off, so only those are restored when the user comes back. */
let idleHeld: Group[] = [];
let idleBusy = false;

async function idleTick(): Promise<void> {
	if (idleBusy) return;
	idleBusy = true;
	try {
		const globals = await getGlobals();
		const idle = idleMs();
		if (!idleHeld.length) {
			if (!globals.idleEnabled || idle < (globals.idleMinutes ?? DEFAULT_IDLE_MINUTES) * 60_000) return;
			const lit = GROUPS.filter((g) => !(g === "case" ? globals.caseOff : globals.peripheralsOff));
			if (!lit.length) return;
			idleHeld = lit;
			await setGroups(lit, true);
		} else if (idle < RESUME_IDLE_MS || !globals.idleEnabled) {
			// Anything the user switched off by hand while away stays off.
			const back = idleHeld.filter((g) => !(g === "case" ? globals.caseOff : globals.peripheralsOff));
			idleHeld = [];
			if (back.length) await setGroups(back, false);
		}
	} catch (e) {
		logger.error(`idle check failed: ${String(e)}`);
	} finally {
		idleBusy = false;
	}
}

setInterval(() => void idleTick(), IDLE_POLL_MS);

async function refreshKeys(): Promise<void> {
	const { caseOff, peripheralsOff, idleEnabled } = await getGlobals();
	for (const a of caseToggle.actions) if (a.isKey()) await a.setState(caseOff ? 1 : 0);
	for (const a of allToggle.actions) if (a.isKey()) await a.setState(caseOff && peripheralsOff ? 1 : 0);
	for (const a of idleToggle.actions) if (a.isKey()) await a.setState(idleEnabled ? 0 : 1);
}

/** Case key flips the case; the all-key turns everything off unless everything is already off. */
abstract class Toggle extends SingletonAction<Settings> {
	protected abstract press(globals: Globals): { groups: Group[]; off: boolean };

	override async onWillAppear(_ev: WillAppearEvent<Settings>): Promise<void> {
		await refreshKeys();
	}

	override async onKeyDown(ev: KeyDownEvent<Settings>): Promise<void> {
		const globals = await getGlobals();
		const { groups, off } = this.press(globals);
		await setGlobals({ auraSettings: ev.payload.settings });
		await setGroups(groups, off);
		await setGlobals({
			caseOff: groups.includes("case") ? off : globals.caseOff,
			peripheralsOff: groups.includes("peripherals") ? off : globals.peripheralsOff,
		});
		await refreshKeys();
	}
}

@action({ UUID: "com.rgbkillswitch.case" })
class CaseToggle extends Toggle {
	protected press({ caseOff }: Globals): { groups: Group[]; off: boolean } {
		return { groups: ["case"], off: !caseOff };
	}
}

@action({ UUID: "com.rgbkillswitch.all" })
class AllToggle extends Toggle {
	protected press({ caseOff, peripheralsOff }: Globals): { groups: Group[]; off: boolean } {
		return { groups: [...GROUPS], off: !(caseOff && peripheralsOff) };
	}
}

@action({ UUID: "com.rgbkillswitch.idle" })
class IdleToggle extends SingletonAction<IdleSettings> {
	override async onWillAppear(ev: WillAppearEvent<IdleSettings>): Promise<void> {
		await this.saveMinutes(ev.payload.settings);
		await refreshKeys();
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<IdleSettings>): Promise<void> {
		await this.saveMinutes(ev.payload.settings);
	}

	override async onKeyDown(_ev: KeyDownEvent<IdleSettings>): Promise<void> {
		await setGlobals({ idleEnabled: !(await getGlobals()).idleEnabled });
		await refreshKeys();
	}

	private async saveMinutes(settings: IdleSettings): Promise<void> {
		const minutes = Number(settings.minutes);
		if (Number.isFinite(minutes) && minutes > 0 && (await getGlobals()).idleMinutes !== minutes) await setGlobals({ idleMinutes: minutes });
	}
}

const caseToggle = new CaseToggle();
const allToggle = new AllToggle();
const idleToggle = new IdleToggle();
streamDeck.actions.registerAction(caseToggle);
streamDeck.actions.registerAction(allToggle);
streamDeck.actions.registerAction(idleToggle);
void streamDeck.connect();
