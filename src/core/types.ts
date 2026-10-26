/** "case" is everything inside the PC; "peripherals" is what sits on the desk. */
export type Group = "case" | "peripherals";

export type Log = (message: string) => void;

export const GROUPS: Group[] = ["case", "peripherals"];
