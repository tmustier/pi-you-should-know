// You Should Know: a port of Claude Code's built-in `cc-plugin-you-should-know` mod (v2.1.287).
//
// Every 6th turn of an agent run, fork the live conversation via turn_end's
// `context.llmMessages`, select a side model, append the detect prompt and ask whether
// there's something the user should know but probably missed. Most of the time the answer is
// `learn: none`. When it isn't, show a note above the editor. Respond with /ysk (or alt+shift+y).
// In fullscreen mode, click a note to open it under its line and answer it with buttons.
//
// Reference (extracted from the Claude Code binary): ~/.pi/agent/reference/you-should-know/
//
// Outside the terminal UI (RPC clients such as T3 Code) there is no widget or custom component.
// Each note is sent once as a notify, `[ysk:<id>] <tag> · <line> (<evidence>)` followed by its
// explanation, for the client to show and answer itself. The client reports each answer back
// with `/ysk answer <id> <action>`.

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, renameSync, unlinkSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { Container, Markdown, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---- constants copied from the CC mod ----
const CHECK_EVERY_STEPS = 6; // var kr=6
const PROMPTS_SURVIVED = 2; // var Tr=2: a note survives this many user prompts
const MAX_SKIP = 16; // var dt=16
const FREE_IGNORES = 2; // var ut=2
const HISTORY_MAX = 50; // var $t=50
const MAX_NOTES = 5; // local: notes queue until answered; new notes wait while the queue is full
const UNDO_MS = 5000; // agent-default (not a user rule): 2026-10-05. How long "Dismissed · Undo" stays after a click.
const backoff = (ignoredInARow: number) =>
	ignoredInARow <= FREE_IGNORES ? 0 : Math.min(MAX_SKIP, 2 ** (ignoredInARow - FREE_IGNORES - 1)); // kn()

const HERE = dirname(fileURLToPath(import.meta.url));
const DETECT_TEMPLATE = readFileSync(join(HERE, "detect-prompt.md"), "utf8");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
const CONFIG_FILE = join(AGENT_DIR, "you-should-know", "config.json");
const STATE_FILE = join(AGENT_DIR, "you-should-know", "state.json");
const KNOWLEDGE_FILE = join(AGENT_DIR, "you-should-know", "knowledge.jsonl");
const LOG_FILE = join(AGENT_DIR, "you-should-know", "checks.jsonl");
const WIDGET = "you-should-know";
const DEBUG = !!process.env.YSK_DEBUG;

// ---- herdr subagent relay ----
// A herdr child gets PI_SUBAGENT_ACTIVITY_FILE=<parentSessionDir>/artifacts/<parentSessionId>/subagent-activity/<id>.json
// (pi-herdr-subagents activity.ts getSubagentActivityFile). The child drops notes into a sibling inbox;
// the parent watches its own <sessionDir>/artifacts/<sessionId>/you-should-know-inbox/ and shows them.
const INBOX = "you-should-know-inbox";
const CHILD_ACTIVITY = process.env.PI_SUBAGENT_ACTIVITY_FILE?.trim();
// The activity file is either <artifactDir>/subagent-activity/<id>.json or, from the harness
// driver, <artifactDir>/subagent-activity-<id>.json. Either way the inbox sits in <artifactDir>.
const CHILD_ARTIFACT_DIR = CHILD_ACTIVITY
	? basename(dirname(CHILD_ACTIVITY)) === "subagent-activity" ? dirname(dirname(CHILD_ACTIVITY)) : dirname(CHILD_ACTIVITY)
	: undefined;
const CHILD_INBOX = CHILD_ARTIFACT_DIR ? join(CHILD_ARTIFACT_DIR, INBOX) : undefined;
const CHILD_NAME = process.env.PI_SUBAGENT_NAME?.trim() || process.env.PI_SUBAGENT_ID?.trim() || "subagent";

// ---- prompts (verbatim from the CC mod) ----
const PREAMBLE = DETECT_TEMPLATE.slice(0, DETECT_TEMPLATE.indexOf("</system-reminder>") + "</system-reminder>".length);

const list = (xs: string[]) => (xs.length > 0 ? xs.map((x) => `- ${x}`).join("\n") : "(nothing yet)"); // ft()
// ---- local additions: timing, and settling notes the main agent has dealt with ----
// A check runs every few steps, so it often sees something the agent has only just read and
// is about to handle itself. Each later check (and one pass when the run ends) is asked which
// waiting notes the agent has since dealt with, and those leave the screen.
type Waiting = { label: string; id: string; line: string; age: string };
const waitingList = (ws: Waiting[]) => ws.map((w) => `- ${w.label} (${w.age}): ${w.line}`).join("\n");
const TIMING_RULE =
	"\n\n## Timing\n\nYou are asked after every few steps of the main agent's work, so you will often see something the agent has only just come across. If your topic first appears in the agent's most recent step (for example a tool result it has just read) and the agent has not yet responded to it, answer learn: none. You will be asked again after a few more steps, when you can see whether the agent dealt with it.";
const SETTLED_RULE =
	"A waiting note is settled when, after it was raised, the main agent dealt with it: it investigated, fixed or reverted the thing, made a deliberate decision about it, or told the user the same point plainly in its own words. A note is also settled when it is no longer true. Mentioning the topic in passing does not settle it. When unsure, leave the note waiting.";
const SETTLED_FORMAT = "settled: <labels of the settled notes separated by commas, or none>";
const detectPrompt = (seen: string[], known: string[], waiting: Waiting[] = [], queueFull = false) =>
	DETECT_TEMPLATE.replace("{{SEEN}}", list(seen)).replace("{{KNOWN}}", list(known)) + // dn()
	TIMING_RULE +
	(waiting.length === 0
		? ""
		: `\n\n## Notes already waiting for the user\n\nThese notes are on the user's screen, unanswered:\n${waitingList(waiting)}\n\n${SETTLED_RULE}\n\nBefore the learn line, add one line:\n${SETTLED_FORMAT}` +
			(queueFull ? "\n\nThe user already has as many waiting notes as they can take, so answer learn: none this time." : ""));
const settlePrompt = (waiting: Waiting[]) =>
	`${PREAMBLE}\nAnswer straight away: do not think it over first, do not call any tool.\nThe main agent has just finished its work for now. These notes are waiting for the user, unanswered:\n${waitingList(waiting)}\n\n${SETTLED_RULE}\n\nOutput exactly one line:\n${SETTLED_FORMAT}`;

type Direction = "first" | "simpler_words" | "less_detail" | "more_detail";
const DIRECTION_ASK: Record<Exclude<Direction, "first">, string> = {
	simpler_words: "in simpler words",
	less_detail: "with less detail",
	more_detail: "in more detail",
};
const DIRECTION_RULE: Record<Direction, string> = {
	first: "At most 100 words; fewer when the thing needs no introduction.",
	simpler_words:
		"Same content as before, said more plainly: shorter sentences, everyday words, no symbols or arrows, no technical terms at all. At most 100 words.",
	less_detail:
		"Strip it to the single most important point: what the thing is in one clause, then the one consequence and the choice. No technical terms, no sketch. At most 45 words.",
	more_detail:
		"Now name the real parts: show the actual config keys, file or function involved (each introduced as everyday words then the name in backticks), and one edge case that would surprise them. Still for a reader with no context; still no invented terms. At most 160 words; a sketch of the real structure is welcome here if it helps.",
};
const shape = (rule: string) =>
	"Write for someone smart who knows nothing about this code and is context-switching constantly: assume they remember no term and no detail from earlier. One idea only. " +
	rule +
	'\nShape:\n1. A title line: `**` two to six plain words that state the point `**`.\n2. First sentence: what the thing IS, in everyday words, with a tiny example of what it does or produces (e.g. "a health check is a step that asks each server one question on a timer and saves the answer, like "are you still up? yes/no""). Never open with a name they have not used; never assume they know what it is.\n3. Then the before/after or the two options as two short lines, using their own numbers and names ("list it once at the top \u2192 asked 1\u00d7 \u2026 inside each job \u2192 asked 3\u00d7"). If, and only if, a small ASCII sketch shows this better than two lines of text, put one in a ``` fenced block, at most 60 characters wide and 6 lines tall; otherwise no sketch.\n4. Then the concrete consequence in their terms (a count, a cost, a wrong number they would have reported) and, last, the choice they are making, in one sentence.\nNo analogy unless it is genuinely clearer than the example, and never both. Any code name appears only after its everyday description, in backticks. Never coin a term or nickname. No headings other than the title, no bullets, no "in summary". Short words, short sentences.'; // pn()
const explainPrompt = (line: string, prev?: { direction: Exclude<Direction, "first">; text: string }) =>
	`${PREAMBLE}\nAnswer straight away: do not think it over first, do not call any tool.\nThe person watching you work said yes to: "${line}"\n` +
	(prev ? `You already showed them this, and they asked for it ${DIRECTION_ASK[prev.direction]}:\n${prev.text}\nDo not repeat it; rewrite it.\n` : "") +
	shape(DIRECTION_RULE[prev?.direction ?? "first"]) +
	"\nOutput only the explanation."; // mn()

// ---- persistent state (across sessions, like CC's plugin store) ----
type State = { enabled: boolean; seen: string[]; known: string[]; ignoredInARow: number; skip: number };
// Each feedback write is one append, so another Pi process cannot overwrite it
// with an older in-memory snapshot. state.json remains the readable snapshot.
function readKnowledge(legacy: string[]): string[] {
	const known = new Map(legacy.map((line) => [norm(line), line]));
	if (existsSync(KNOWLEDGE_FILE)) for (const line of readFileSync(KNOWLEDGE_FILE, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line);
			if (typeof entry.line !== "string" || typeof entry.known !== "boolean") continue;
			if (entry.known) known.set(norm(entry.line), entry.line);
			else known.delete(norm(entry.line));
		} catch { /* An interrupted final append is ignored. The next starts on a new line. */ }
	}
	return [...known.values()].slice(-HISTORY_MAX);
}
function atomicJson(file: string, value: unknown) {
	mkdirSync(dirname(file), { recursive: true });
	const temporary = file + ".tmp-" + process.pid;
	try {
		writeFileSync(temporary, JSON.stringify(value, null, 2));
		renameSync(temporary, file);
	} finally { rmSync(temporary, { force: true }); }
}
function loadState(): State {
	let state: State = { enabled: true, seen: [], known: [], ignoredInARow: 0, skip: 0 };
	if (existsSync(STATE_FILE)) state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) };
	state.known = readKnowledge(state.known);
	return state;
}
function saveState(s: State) {
	s.known = readKnowledge(s.known);
	atomicJson(STATE_FILE, s);
}
function log(entry: Record<string, unknown>) {
	try {
		mkdirSync(dirname(LOG_FILE), { recursive: true });
		appendFileSync(LOG_FILE, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
	} catch {}
}

// ---- output parsing (the CC mod's Cr()) ----
type Tag = "You should know" | "Heads up";
type Note = { id: string; line: string; tag: Tag; evidence?: string; explanation?: string; from?: string; shownAt: number; promptsSurvived: number; countedIgnored?: boolean; step?: number };
type Parsed = { kind: "none" } | { kind: "parse_failed" } | { kind: "line"; line: string; tag: Tag; evidence?: string; explanation?: string };
const strip = (s: string) => s.replace(/^[\s>*_`"'\u201C\u201D\u2018\u2019-]+/, "");
function parse(text: string): Parsed {
	const lines = text.split("\n");
	const li = lines.findIndex((l) => /^learn\s*:/i.test(strip(l)));
	if (li === -1) return { kind: "parse_failed" };
	const line = strip(lines[li]).replace(/^learn\s*:\s*/i, "").replace(/[*_`\s]+$/, "").trim();
	if (line === "" || /^none\.?$/i.test(line)) return { kind: "none" };
	const ti = lines.findIndex((l, i) => i > li && /^tag\s*:/i.test(strip(l)));
	const tag: Tag = ti !== -1 && /heads[\s-]*up/i.test(lines[ti]) ? "Heads up" : "You should know";
	const ei = lines.findIndex((l, i) => i > li && /^explain\s*:/i.test(strip(l)));
	const vi = lines.findIndex((l, i) => i > li && (ei === -1 || i < ei) && /^evidence\s*:/i.test(strip(l)));
	const ev = vi === -1 ? "" : strip(lines[vi]).replace(/^evidence\s*:\s*/i, "").trim();
	const evidence = ev && !/^none\.?$/i.test(ev) ? ev : undefined;
	let explanation: string | undefined;
	if (ei !== -1) {
		const first = strip(lines[ei]).replace(/^explain\s*:\s*/i, "");
		explanation = [first, ...lines.slice(ei + 1)].join("\n").trim() || undefined;
	}
	return { kind: "line", line, tag, evidence, explanation };
}
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); // Co()
/** The waiting notes a side answer marks as settled, by their `#n` labels. */
function parseSettled(text: string, waiting: Waiting[]): string[] {
	const line = text.split("\n").map(strip).find((l) => /^settled\s*:/i.test(l));
	if (!line) return [];
	const labels = new Set([...line.matchAll(/#(\d+)/g)].map((m) => `#${m[1]}`));
	return waiting.filter((w) => labels.has(w.label)).map((w) => w.id);
}

// ---- clickable buttons (fullscreen mouse) ----
type Button<A extends string> = { label: string; action: A; dim?: boolean };
type Hit<A extends string> = { x0: number; x1: number; action: A };
/** Lays buttons out left to right after `indent` columns, wrapping when they do not fit, and records where each one landed. */
function layoutButtons<A extends string>(buttons: Button<A>[], width: number, indent: number, theme: any) {
	const lines: string[] = [];
	const hits: Hit<A>[][] = [];
	let line = " ".repeat(indent);
	let x = indent;
	let row: Hit<A>[] = [];
	for (const b of buttons) {
		const text = `[${b.label}]`;
		const w = visibleWidth(text);
		if (row.length > 0 && x + 2 + w > width) {
			lines.push(truncateToWidth(line, width, ""));
			hits.push(row);
			line = " ".repeat(indent);
			x = indent;
			row = [];
		}
		if (row.length > 0) {
			line += "  ";
			x += 2;
		}
		row.push({ x0: x, x1: x + w, action: b.action });
		line += theme.fg(b.dim ? "dim" : "accent", text);
		x += w;
	}
	lines.push(truncateToWidth(line, width, ""));
	hits.push(row);
	return { lines, hits };
}
/** The button under a left click, if any. Presses and drags are left alone so text selection keeps working. */
const clicked = <A extends string>(row: Hit<A>[] | undefined, e: TuiMouseEvent) =>
	e.type === "click" && e.button === "left" ? row?.find((h) => e.x >= h.x0 && e.x < h.x1)?.action : undefined;
class ButtonRow<A extends string> implements Component {
	private hits: Hit<A>[][] = [];
	private buttons: Button<A>[];
	private theme: any;
	private onPress: (action: A) => void;
	constructor(buttons: Button<A>[], theme: any, onPress: (action: A) => void) {
		this.buttons = buttons;
		this.theme = theme;
		this.onPress = onPress;
	}
	render(width: number) {
		const laid = layoutButtons(this.buttons, width, 1, this.theme);
		this.hits = laid.hits;
		return laid.lines;
	}
	handleMouse(e: TuiMouseEvent) {
		const action = clicked(this.hits[e.y], e);
		if (!action) return undefined;
		this.onPress(action);
		return { handled: true };
	}
	invalidate() {}
}

/** Evidence that starts with an existing file (`src/a.ts:12 ...`) gets a terminal link to that file. */
function linkEvidence(evidence: string, cwd: string) {
	const m = /^([^\s,;()]+?)(:\d+(?:[:-]\d+)?)?(?=$|[\s,;)])/.exec(evidence);
	if (!m) return evidence;
	const path = m[1].replace(/^~(?=\/)/, homedir());
	const file = isAbsolute(path) ? path : resolve(cwd, path);
	try {
		if (!statSync(file).isFile()) return evidence;
	} catch {
		return evidence;
	}
	return `\x1b]8;;${pathToFileURL(file).href}\x1b\\${m[0]}\x1b]8;;\x1b\\${evidence.slice(m[0].length)}`;
}

type Act = "explain" | "knew" | "ask" | "dismiss" | "got_it" | "simpler_words" | "less_detail" | "more_detail" | "undo" | "more";
const NOTE_BUTTONS: Button<Act>[] = [
	{ label: "Explain", action: "explain" },
	{ label: "Knew it", action: "knew" },
	{ label: "Ask agent", action: "ask" },
	{ label: "Dismiss", action: "dismiss", dim: true },
];
const EXPLAINED_BUTTONS: Button<Act>[] = [
	{ label: "Got it", action: "got_it" },
	{ label: "Ask agent", action: "ask" },
	{ label: "Simpler", action: "simpler_words" },
	{ label: "Shorter", action: "less_detail" },
	{ label: "More detail", action: "more_detail" },
	{ label: "Dismiss", action: "dismiss", dim: true },
];
// The keyboard explanation screen: the same choices, labelled with their keys.
const EXPLAIN_SCREEN_BUTTONS: Button<string>[] = [
	{ label: "1 Got it", action: "understood" },
	{ label: "2 Ask agent", action: "chat" },
	{ label: "s Simpler", action: "simpler_words" },
	{ label: "l Shorter", action: "less_detail" },
	{ label: "m More detail", action: "more_detail" },
	{ label: "0 Dismiss", action: "dismiss", dim: true },
];

const textOf = (msg: { content: unknown }) =>
	Array.isArray(msg.content)
		? msg.content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("\n")
				.trim()
		: "";

export default function (pi: ExtensionAPI) {
	let state = loadState();
	let notes: Note[] = []; // oldest first; /ysk and alt+x act on current(): the open note, else notes[0]
	// Fullscreen mouse: which note is open under its line, its explanation, and the last undoable answer.
	let expandedId: string | undefined;
	type View = { text?: string; md?: Markdown; writing?: boolean; error?: string };
	const views = new Map<string, View>();
	let undo: { note: Note; index: number; action: "knew" | "dismiss"; timer: ReturnType<typeof setTimeout> } | undefined;
	const current = () => notes.find((n) => n.id === expandedId) ?? notes[0];
	let answered = new Map<string, { note: Note; action: string }>();
	let inFlight: AbortController | undefined;
	let inFlightTask: Promise<void> | undefined;
	let promptCounter = 0; // stands in for CC's turnId staleness check
	let checks = 0;
	// Steps seen this process, and the step the last side request looked at. A note remembers
	// the step it was raised at, so a later request can tell how long it has been waiting.
	let turnCount = 0;
	let askedAtTurn = 0;
	// The terminal widget shows one note; "N more waiting" opens the rest.
	let showAll = false;
	const remember = (line: string, known: boolean) => {
		mkdirSync(dirname(KNOWLEDGE_FILE), { recursive: true });
		appendFileSync(KNOWLEDGE_FILE, "\n" + JSON.stringify({ line, known }) + "\n");
		state.known = readKnowledge(state.known);
	};

	// By default a check uses the main model at the main thinking level. The side request then
	// starts with the same bytes as the main request and reads its prompt cache. Another model,
	// or the same model at another thinking level, misses that cache: on gpt-6.1-sol a check read
	// 72% of its input from cache at the main level and 0% at another. Each family can still be
	// routed in config.json; explicit provider/model IDs keep authentication on that provider.
	const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const isMain = (ctx: ExtensionContext, model: { provider: string; id: string } | undefined) =>
		!!model && model.provider === ctx.model?.provider && model.id === ctx.model?.id;
	const pickModel = (ctx: ExtensionContext) => {
		const id = ctx.model?.id.split("/").at(-1) ?? "";
		const family = /^gpt-/i.test(id) ? "gpt" : /^claude-fable(?:-|$)/i.test(id) ? "fable" : undefined;
		const config = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
		const route = family ? config[family] : undefined;
		const override = process.env.YSK_MODEL?.trim();
		if (!override && !route) return { model: ctx.model, thinking: undefined };
		const requested = override || route?.model || (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
		if (typeof requested !== "string" || !requested.includes("/")) throw new Error("YSK model must be provider/model-id");
		const at = requested.indexOf("/");
		const model = ctx.modelRegistry.find(requested.slice(0, at), requested.slice(at + 1));
		if (!model) throw new Error(`YSK model not found: ${requested}`);
		const thinking = route?.thinking;
		if (thinking !== undefined && !thinkingLevels.includes(thinking)) throw new Error("Invalid YSK thinking level in " + CONFIG_FILE);
		// A route to the main model at the main level is the cached same-model request.
		if (isMain(ctx, model) && (thinking === undefined || thinking === pi.getThinkingLevel())) return { model, thinking: undefined };
		return { model, thinking };
	};

	const notesFile = (ctx: ExtensionContext) =>
		ctx.sessionManager.getSessionDir()
			? join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId(), "you-should-know.json")
			: undefined;
	const persistNotes = (ctx: ExtensionContext) => {
		const file = notesFile(ctx);
		if (file) atomicJson(file, { notes, answered: [...answered] });
	};

	const render = (ctx: ExtensionContext) => {
		persistNotes(ctx);
		if (ctx.mode !== "tui") return;
		if (notes.length <= 1) showAll = false;
		if (notes.length === 0 && !undo) {
			ctx.ui.setWidget(WIDGET, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET, (_tui, theme) => notesWidget(ctx, theme));
	};

	// The current note on one line, then "N more waiting" when others are queued; clicking that
	// shows every note (no key hint line: alt+x dismisses, /ysk or alt+shift+y responds).
	// In fullscreen mode, clicking a note opens it: evidence, explanation and a row of buttons.
	type Row = { note?: Note; hits?: Hit<Act>[] };
	const notesWidget = (ctx: ExtensionContext, theme: any): Component => {
		let rows: Row[] = [];
		return {
			render(width: number) {
				const lines: string[] = [];
				rows = [];
				const add = (ls: string[], row: Row) => {
					for (const l of ls) {
						lines.push(truncateToWidth(l, width, ""));
						rows.push(row);
					}
				};
				const lead = current();
				const items: (Note | undefined)[] = showAll ? [...notes] : lead ? [lead] : [];
				if (undo) items.splice(showAll ? Math.min(undo.index, items.length) : items.length, 0, undefined);
				for (const n of items) {
					if (!n) {
						const prefix = "  " + theme.fg("dim", `${undo!.action === "knew" ? "Marked as known" : "Dismissed"} \u00b7 `);
						const x0 = visibleWidth(prefix);
						add([prefix + theme.fg("accent", "Undo")], { hits: [{ x0, x1: x0 + 4, action: "undo" }] });
						continue;
					}
					const on = n === lead;
					const mark = on ? theme.fg("accent", "\u2726 ") : theme.fg("dim", "\u2727 ");
					const tag = on ? theme.fg("accent", theme.bold(n.tag)) : theme.fg("dim", n.tag);
					const from = n.from ? theme.fg("dim", ` (${n.from})`) : "";
					add(wrapTextWithAnsi(mark + tag + from + theme.fg("dim", " \u00b7 ") + n.line, width), { note: n });
					if (n.id !== expandedId) continue;
					if (n.evidence) add(wrapTextWithAnsi("  " + theme.fg("dim", "Evidence: ") + linkEvidence(n.evidence, ctx.cwd), width), {});
					const v = views.get(n.id);
					if (v?.md) add(v.md.render(width), {});
					if (v?.error) add(wrapTextWithAnsi("  " + theme.fg("error", v.error), width), {});
					if (v?.writing) {
						add(["  " + theme.fg("dim", "Writing\u2026")], {});
						continue;
					}
					const laid = layoutButtons(v?.md ? EXPLAINED_BUTTONS : NOTE_BUTTONS, width, 2, theme);
					laid.lines.forEach((l, i) => add([l], { note: n, hits: laid.hits[i] }));
				}
				if (notes.length > 1) {
					const label = showAll ? "Show one" : `${notes.length - 1} more waiting`;
					add(["  " + theme.fg("dim", label)], { hits: [{ x0: 2, x1: 2 + visibleWidth(label), action: "more" }] });
				}
				return lines;
			},
			handleMouse(e: TuiMouseEvent) {
				const row = rows[e.y];
				if (!row) return undefined;
				const action = clicked(row.hits, e);
				if (action) {
					void act(ctx, action, row.note);
					return { handled: true };
				}
				if (row.note && !row.hits && e.type === "click" && e.button === "left") {
					toggle(ctx, row.note);
					return { handled: true };
				}
				return undefined;
			},
			invalidate() {
				for (const v of views.values()) v.md?.invalidate();
			},
		};
	};

	const clearNotes = (ctx: ExtensionContext) => {
		notes = [];
		expandedId = undefined;
		views.clear();
		render(ctx);
	};

	// Any answer, or opening a note, counts as paying attention: checks go back to full frequency.
	const engage = () => {
		state.ignoredInARow = 0;
		state.skip = 0;
		saveState(state);
	};

	/** Take a note off the list. Mouse answers that lose something (knew, dismiss) can be undone for a few seconds. */
	function removeNote(ctx: ExtensionContext, n: Note, undoable?: "knew" | "dismiss") {
		const index = notes.indexOf(n);
		notes = notes.filter((x) => x !== n);
		views.delete(n.id);
		if (expandedId === n.id) expandedId = undefined;
		if (undo) clearTimeout(undo.timer);
		undo = undefined;
		if (undoable) {
			const timer = setTimeout(() => {
				if (undo?.timer !== timer) return;
				undo = undefined;
				render(ctx);
			}, UNDO_MS);
			timer.unref?.();
			undo = { note: n, index, action: undoable, timer };
		}
		engage();
		render(ctx);
	}

	function restore(ctx: ExtensionContext) {
		if (!undo) return;
		const { note, index, action, timer } = undo;
		clearTimeout(timer);
		undo = undefined;
		notes.splice(Math.min(index, notes.length), 0, note);
		if (action === "knew") remember(note.line, false);
		log({ event: "undo", answer: action, via: "mouse", line: note.line });
		render(ctx);
	}

	/** The notes a side request is asked about, labelled `#1`, `#2`... with how long each has waited. */
	const waitingNotes = (): Waiting[] =>
		notes.map((n, i) => ({
			label: `#${i + 1}`,
			id: n.id,
			line: n.line,
			age: n.step === undefined ? "raised in an earlier session" : n.step === turnCount ? "raised just now" : `raised ${turnCount - n.step} steps ago`,
		}));

	/** The main agent dealt with these notes itself: take them off the screen. The note the user has open stays. */
	function settle(ctx: ExtensionContext, ids: string[], via: "check" | "end") {
		const gone = notes.filter((n) => ids.includes(n.id) && n.id !== expandedId);
		if (gone.length === 0) return;
		notes = notes.filter((n) => !gone.includes(n));
		for (const n of gone) {
			views.delete(n.id);
			log({ event: "settled", via, line: n.line, msShown: Date.now() - n.shownAt });
		}
		render(ctx);
	}

	function toggle(ctx: ExtensionContext, n: Note) {
		expandedId = expandedId === n.id ? undefined : n.id;
		if (expandedId) {
			engage();
			log({ event: "expand", via: "mouse", line: n.line, msToAnswer: Date.now() - n.shownAt });
		}
		render(ctx);
	}

	/** Explain a note under its line, or rewrite the explanation already there. */
	async function writeInline(ctx: ExtensionContext, n: Note, direction: Direction) {
		const v: View = views.get(n.id) ?? {};
		views.set(n.id, v);
		if (v.writing) return;
		const show = (text: string) => {
			v.text = text;
			v.md = new Markdown(text, 2, 0, getMarkdownTheme());
		};
		if (direction === "first" && n.explanation) {
			show(n.explanation);
			render(ctx);
			return;
		}
		v.writing = true;
		v.error = undefined;
		render(ctx);
		try {
			const prev = direction !== "first" && v.text ? { direction, text: v.text } : undefined;
			const r = await fork(ctx, lastLlmMessages, explainPrompt(n.line, prev), new AbortController().signal);
			if (r.text) show(r.text);
			else v.error = "No explanation came back.";
		} catch (err) {
			v.error = `Couldn\u2019t write that explanation: ${err}`;
		}
		v.writing = false;
		if (views.get(n.id) === v) render(ctx); // the note may have been answered meanwhile
	}

	async function act(ctx: ExtensionContext, a: Act, n?: Note) {
		if (a === "undo") return restore(ctx);
		if (a === "more") {
			showAll = !showAll;
			return render(ctx);
		}
		if (!n || !notes.includes(n)) return;
		if (a === "explain") return writeInline(ctx, n, "first");
		if (a === "simpler_words" || a === "less_detail" || a === "more_detail") return writeInline(ctx, n, a);
		const explanation = views.get(n.id)?.text;
		removeNote(ctx, n, a === "knew" || a === "dismiss" ? a : undefined);
		if (a === "knew") remember(n.line, true);
		if (a === "ask") chatInMain(n, explanation ?? n.explanation);
		const answer = { knew: "knew", dismiss: "dismiss", ask: "chat", got_it: "understood" }[a];
		log({ event: "answer", answer, via: "mouse", explained: !!explanation, line: n.line, msToAnswer: Date.now() - n.shownAt });
	}

	async function fork(ctx: ExtensionContext, llmMessages: any[], prompt: string, signal: AbortSignal) {
		const { model, thinking } = pickModel(ctx);
		if (!model) throw new Error("no model");
		const same = isMain(ctx, model) && thinking === undefined;
		const messages = [
			...llmMessages,
			{ role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
		];
		const hasSystem = llmMessages[0]?.role === "system";
		const context = { messages, ...(hasSystem ? {} : { systemPrompt: ctx.getSystemPrompt() }) } as any;
		const options = {
			signal, sessionId: ctx.sessionManager.getSessionId(),
			onPayload: (p: unknown) => {
				// Cache alignment copies the main request (tools, system, thinking), so it must
				// not overwrite a routed model's converted history or its own thinking setting.
				if (same) return alignWithMain(p);
				lastAlign = { aligned: false, why: "independent side request" };
				return undefined;
			},
		};
		// The same-model request reuses the main request's payload. Routes use Pi's neutral
		// thinking option, translated by each provider to its native wire format.
		const res = same
			? await ctx.modelRegistry.complete(model, context, options)
			: await ctx.modelRegistry.streamSimple(model, context, { ...options, reasoning: thinking, toolChoice: "none" }).result();
		return { text: textOf(res), usage: res.usage, stopReason: res.stopReason, error: res.errorMessage, provider: model.provider, model: model.id, thinking };
	}

	let lastLlmMessages: any[] = [];

	/**
	 * The main conversation's last request, exactly as sent. The fork is only
	 * cheap if its bytes start the same way, and they did not: it sent no tools
	 * and no thinking setting, so Anthropic kept the tools and system prompt
	 * cached but wrote every message again — about 255k tokens and $1.30 per
	 * check on Opus 5.5 (155 checks, $56.76 in checks.jsonl before this fix).
	 */
	let mainPayload: Record<string, unknown> | undefined;
	const forkPayloads = new WeakSet<object>();
	pi.on("before_provider_request", (e) => {
		const p = e.payload;
		if (!p || typeof p !== "object" || forkPayloads.has(p as object)) return; // never align to our own fork
		mainPayload = p as Record<string, unknown>;
	});

	/** How the last fork lined up with the main request; logged with each check. */
	let lastAlign: Record<string, unknown> = {};

	/**
	 * Cache fix, take two. The first version rebuilt the fork's messages and moved
	 * the cache marker to the message before the detect prompt. Anthropic only finds
	 * a cached prefix by looking back about 20 content blocks from a marker, and
	 * most checks landed outside that window: checks.jsonl showed ~21k tokens read
	 * (tools + system only) and 130-300k written, about $1 per check.
	 *
	 * Now the fork reuses the main request's message list byte for byte, including
	 * its cache marker, so the fork reads exactly what the main request cached. The
	 * messages after it (the turn that just ended) and the detect prompt carry no
	 * marker: they are paid once as plain input and never written to the cache.
	 */
	const alignWithMain = (forked: unknown): unknown => {
		const main = mainPayload;
		lastAlign = { aligned: false };
		if (!main || !forked || typeof forked !== "object") return markFork(undefined, (lastAlign.why = "no main payload"));
		const f = forked as Record<string, unknown>;
		if (main["model"] !== f["model"]) return markFork(undefined, (lastAlign.why = "model differs"));
		const key = Array.isArray(f["messages"]) ? "messages" : Array.isArray(f["input"]) ? "input" : undefined;
		if (!key || !Array.isArray(main[key])) return markFork(undefined, (lastAlign.why = "no message list"));
		if (key === "input") return markFork({ ...main, input: f["input"] }, undefined, true);
		const mainMsgs = main[key] as any[];
		const forkMsgs = (f[key] as any[]).map(unmark);
		// Another extension may put messages in front of the main request after Pi builds it (the
		// Anthropic OAuth fix moves the system prompt into a leading user message), so the fork's
		// first message can match a later one in main. Main's leading messages are kept as sent.
		const { lead, common } = alignment(mainMsgs, forkMsgs);
		const same = lead + common;
		lastAlign = { aligned: true, mainLen: mainMsgs.length, forkLen: forkMsgs.length, lead, common };
		if (common === 0) return markFork({ ...main, messages: forkMsgs }, undefined, true);
		const head = mainMsgs.slice(0, same);
		if (same < mainMsgs.length) {
			// Main's marker fell outside the match: put the same marker on the last
			// matching message so Anthropic can still look back to main's cache.
			const marker = findMarker(mainMsgs) ?? { type: "ephemeral" };
			const last = unmark(head[same - 1]);
			if (Array.isArray(last?.content) && last.content.length > 0) {
				const blocks = last.content.slice();
				const at = blocks.findLastIndex((b: any) => b?.type !== "thinking" && b?.type !== "redacted_thinking");
				if (at >= 0) blocks[at] = { ...blocks[at], cache_control: marker };
				head[same - 1] = { ...last, content: blocks };
			}
		}
		// Main's own messages (marker included), then the new tail, unmarked.
		return markFork({ ...main, messages: [...head, ...forkMsgs.slice(common)] }, undefined, true);
	};
	const markFork = (payload: Record<string, unknown> | undefined, _why?: string, _aligned?: boolean) => {
		if (payload) forkPayloads.add(payload);
		return payload;
	};
	const unmark = (m: any) =>
		Array.isArray(m?.content) ? { ...m, content: m.content.map(({ cache_control: _drop, ...b }: any) => b) } : m;
	const sameMsg = (a: any, b: any) => JSON.stringify(unmark(a)) === JSON.stringify(unmark(b));
	const findMarker = (msgs: any[]) => {
		for (let i = msgs.length - 1; i >= 0; i--)
			for (const b of Array.isArray(msgs[i]?.content) ? msgs[i].content : []) if (b?.cache_control) return b.cache_control;
		return undefined;
	};
	/** How many messages match, once cache markers are ignored, when the fork starts at main[lead]. */
	const commonFrom = (main: any[], fork: any[], lead: number) => {
		let i = 0;
		while (lead + i < main.length && i < fork.length && sameMsg(main[lead + i], fork[i])) i++;
		return i;
	};
	/** The number of messages main has in front of the fork's first message, and how many match from there. */
	const alignment = (main: any[], fork: any[]) => {
		let best = { lead: 0, common: commonFrom(main, fork, 0) };
		for (let lead = 1; lead < main.length && best.common < main.length - lead; lead++) {
			const common = commonFrom(main, fork, lead);
			if (common > best.common) best = { lead, common };
		}
		return best;
	};

	function relayToParent(n: { line: string; tag: Tag; evidence?: string; explanation?: string; from: string }) {
		try {
			mkdirSync(CHILD_INBOX!, { recursive: true });
			const base = join(CHILD_INBOX!, `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
			writeFileSync(base + ".tmp", JSON.stringify(n));
			renameSync(base + ".tmp", base + ".json"); // atomic: parent never reads a half-written note
		} catch (err) {
			log({ event: "relay_failed", error: String(err) });
		}
	}

	// Parent side: pick up notes relayed by herdr subagents.
	const queuedRelays = new Set<string>();
	let inboxTimer: ReturnType<typeof setInterval> | undefined;
	const inboxDir = (ctx: ExtensionContext) =>
		join(ctx.sessionManager.getSessionDir(), "artifacts", ctx.sessionManager.getSessionId(), INBOX);
	function drainInbox(ctx: ExtensionContext) {
		const dir = inboxDir(ctx);
		if (!existsSync(dir)) return;
		const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
		if (files.length === 0) return;
		const delivered = new Set(ctx.sessionManager.getEntries().flatMap((entry) =>
			entry.type === "custom_message" && entry.customType === "you-should-know" &&
			entry.details && typeof entry.details === "object" && "relayId" in entry.details
				? [entry.details.relayId] : []));
		for (const f of files) {
			const path = join(dir, f);
			try {
				if (delivered.has(f)) { unlinkSync(path); queuedRelays.delete(f); continue; }
				if (queuedRelays.has(f)) continue;
				const n = JSON.parse(readFileSync(path, "utf8"));
				if (!n?.line || !state.enabled) continue;
				// Feed it to the parent agent as a message. Busy: steer into the current run.
				// Idle: append to Pi's durable conversation without waking the agent.
				const tag = n.tag === "Heads up" ? "Heads up" : "You should know";
				const body = [`${tag} \u00b7 ${n.line}`, ...(n.evidence ? [`Evidence: ${n.evidence}`] : []), ...(n.explanation ? ["", n.explanation] : [])]
					.join("\n").split("\n").map((l: string) => (l === "" ? ">" : `> ${l}`)).join("\n");
				const idle = ctx.isIdle();
				pi.sendMessage(
					{
						customType: "you-should-know",
						content: `Your subagent "${n.from ?? "subagent"}" raised a note its side agent thinks you (and the user) should know. It's about the subagent's work; you can't see its conversation. Weigh it and act or mention it if it matters:\n${body}`,
						display: true,
						details: { ...n, relayId: f },
					},
					idle ? {} : { deliverAs: "steer" },
				);
				queuedRelays.add(f);
				log({ event: "relayed_in", from: n.from, line: n.line, deliverAs: idle ? "persisted" : "steer" });
			} catch {}
		}
	}

	pi.on("session_start", (_e, ctx) => {
		state = loadState();
		queuedRelays.clear();
		inFlight?.abort();
		inFlight = undefined;
		notes = [];
		answered = new Map();
		expandedId = undefined;
		views.clear();
		if (undo) clearTimeout(undo.timer);
		undo = undefined;
		try {
			const file = notesFile(ctx);
			if (file) {
				const saved = JSON.parse(readFileSync(file, "utf8"));
				// Step numbers belong to the process that raised the note.
				notes = saved.notes.map(({ step: _step, ...n }: Note) => n);
				answered = new Map(saved.answered);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		promptCounter = 0;
		turnCount = 0;
		askedAtTurn = 0;
		inFlightTask = undefined;
		showAll = false;
		render(ctx);
		if (inboxTimer) clearInterval(inboxTimer);
		inboxTimer = undefined;
		if (ctx.hasUI) {
			inboxTimer = setInterval(() => drainInbox(ctx), 2000);
			inboxTimer.unref?.();
		}
	});

	pi.on("session_shutdown", () => {
		inFlight?.abort();
		inFlight = undefined;
		if (inboxTimer) clearInterval(inboxTimer);
		inboxTimer = undefined;
	});

	// T3 accepts notices between turns.
	const noteText = (n: Note) =>
		`[ysk:${n.id}] ${n.tag} \u00b7 ${n.line}${n.evidence ? ` (${n.evidence})` : ""}` +
		(n.explanation ? `\n\n${n.explanation}` : "");
	function announce(ctx: ExtensionContext, n: Note) {
		ctx.ui.notify(noteText(n), "info");
		persistNotes(ctx);
	}


	// A note that survives PROMPTS_SURVIVED user prompts unanswered counts as ignored (for backoff),
	// but stays queued until you answer or dismiss it. In the terminal only notes on screen count:
	// the current one, or all of them while "N more waiting" is open.
	// Unanswered notes count in RPC clients too. Extension commands are not user prompts.
	pi.on("input", (e, ctx) => {
		if (e.source === "extension" || e.text.trim().startsWith("/ysk")) return;
		promptCounter++;
		let changed = false;
		const visible = ctx.mode === "tui" && !showAll ? notes.filter((n) => n === current()) : notes;
		for (const n of visible) {
			n.promptsSurvived++;
			if (n.countedIgnored || n.promptsSurvived < PROMPTS_SURVIVED) continue;
			n.countedIgnored = true;
			log({ event: "ignored_submit", line: n.line });
			state.ignoredInARow++;
			changed = true;
		}
		persistNotes(ctx);
		if (!changed) return;
		state.skip = backoff(state.ignoredInARow);
		saveState(state);
	});

	pi.on("turn_end", (e, ctx) => {
		lastLlmMessages = e.context.llmMessages as any[];
		turnCount++;
		if (!state.enabled || !ctx.hasUI) return;
		const step = e.turnIndex;
		if (!(step > 0 && step % CHECK_EVERY_STEPS === 0)) return;
		if (inFlight) return;
		if (state.skip > 0) {
			state.skip--;
			saveState(state);
			return;
		}

		const ac = new AbortController();
		inFlight = ac;
		const askedAt = promptCounter;
		const seen = [...state.seen];
		const known = [...state.known];
		// RPC clients show and answer notes themselves, so only the terminal settles notes.
		const waiting = ctx.mode === "tui" ? waitingNotes() : [];
		const queueFull = ctx.mode === "tui" && notes.length >= MAX_NOTES;
		const raisedAt = turnCount;
		askedAtTurn = turnCount;
		const t0 = Date.now();
		checks++;
		// Fire and forget: never block the main agent.
		inFlightTask = (async () => {
			let outcome = "error";
			let extra: Record<string, unknown> = {};
			try {
				const r = await fork(ctx, lastLlmMessages, detectPrompt(seen, known, waiting, queueFull), ac.signal);
				extra = { usage: r.usage, stopReason: r.stopReason, error: r.error, provider: r.provider, model: r.model, thinking: r.thinking, waiting: waiting.length };
				if (ac.signal.aborted || r.stopReason === "aborted") outcome = "aborted";
				else if (r.stopReason === "error") outcome = "error";
				else if (!r.text) outcome = "empty";
				else {
					if (waiting.length > 0) {
						const settled = parseSettled(r.text, waiting);
						extra.settled = settled.length;
						settle(ctx, settled, "check");
					}
					const p = parse(r.text);
					if (p.kind !== "line") outcome = p.kind;
					else if ([...seen, ...known].some((x) => norm(x) === norm(p.line))) outcome = "deduped";
					else if (promptCounter !== askedAt) outcome = "stale";
					else if (ctx.mode === "tui" && !CHILD_INBOX && notes.length >= MAX_NOTES) {
						// Not added to seen, so a later check can raise it once there is room.
						outcome = "queue_full";
						extra.line = p.line;
					} else {
						outcome = "shown";
						extra.line = p.line;
						state.seen = [...state.seen, p.line].slice(-HISTORY_MAX);
						saveState(state);
						if (CHILD_INBOX) {
							// In a herdr subagent: hand the note to the parent instead of showing it here.
							// The parent can't fork our conversation, so write the explanation now.
							let explanation = p.explanation;
							if (!explanation) {
								try {
									explanation = (await fork(ctx, lastLlmMessages, explainPrompt(p.line), ac.signal)).text || undefined;
								} catch {}
							}
							relayToParent({ line: p.line, tag: p.tag, evidence: p.evidence, explanation, from: CHILD_NAME });
							outcome = "relayed";
							return;
						}
						const note: Note = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), line: p.line, tag: p.tag, evidence: p.evidence, explanation: p.explanation, shownAt: Date.now(), promptsSurvived: 0, step: raisedAt };
						if (ctx.mode !== "tui" && !note.explanation) {
							// The client's "Explain" has nothing to ask, so write the explanation now.
							try {
								note.explanation = (await fork(ctx, lastLlmMessages, explainPrompt(p.line), ac.signal)).text || undefined;
							} catch {}
						}
						notes.push(note);
						render(ctx);
						if (ctx.mode !== "tui") announce(ctx, note);
					}
				}
			} catch (err) {
				outcome = ac.signal.aborted ? "aborted" : "error";
				extra.error = String(err);
			} finally {
				if (inFlight === ac) inFlight = undefined;
				log({ event: "check", step, outcome, ms: Date.now() - t0, align: lastAlign, ...extra });
				if (DEBUG) ctx.ui.notify(`you-should-know: step ${step} \u2192 ${outcome} (${Date.now() - t0}ms)`, "info");
			}
		})();
	});

	// When the run ends, ask once more which waiting notes the agent has since dealt with,
	// unless the last check already saw the final step. A check still running finishes first.
	pi.on("agent_before_settle", (e, ctx) => {
		lastLlmMessages = e.context.llmMessages as any[];
		if (!state.enabled || ctx.mode !== "tui" || CHILD_INBOX || notes.length === 0 || askedAtTurn === turnCount) return;
		void settleAtEnd(ctx, lastLlmMessages);
	});

	async function settleAtEnd(ctx: ExtensionContext, messages: any[]) {
		await inFlightTask;
		if (inFlight || notes.length === 0 || askedAtTurn === turnCount) return;
		const ac = new AbortController();
		inFlight = ac;
		askedAtTurn = turnCount;
		const waiting = waitingNotes();
		const t0 = Date.now();
		let outcome = "error";
		let extra: Record<string, unknown> = {};
		inFlightTask = (async () => {
			try {
				const r = await fork(ctx, messages, settlePrompt(waiting), ac.signal);
				extra = { usage: r.usage, stopReason: r.stopReason, error: r.error, provider: r.provider, model: r.model, thinking: r.thinking };
				if (ac.signal.aborted || r.stopReason === "aborted") outcome = "aborted";
				else if (r.stopReason === "error") outcome = "error";
				else {
					const settled = parseSettled(r.text, waiting);
					extra.settled = settled.length;
					settle(ctx, settled, "end");
					outcome = "done";
				}
			} catch (err) {
				outcome = ac.signal.aborted ? "aborted" : "error";
				extra.error = String(err);
			} finally {
				if (inFlight === ac) inFlight = undefined;
				log({ event: "settle", outcome, waiting: waiting.length, ms: Date.now() - t0, align: lastAlign, ...extra });
				if (DEBUG) ctx.ui.notify(`you-should-know: settle \u2192 ${outcome}, ${extra.settled ?? 0} of ${waiting.length} (${Date.now() - t0}ms)`, "info");
			}
		})();
		await inFlightTask;
	}

	async function showExplanation(ctx: ExtensionContext, n: Note) {
		let text = n.explanation;
		if (!text) {
			ctx.ui.notify("One moment\u2026", "info");
			text = (await fork(ctx, lastLlmMessages, explainPrompt(n.line), new AbortController().signal)).text;
		}
		while (true) {
			const choice = ctx.mode !== "tui" ? await explainBySelect(ctx, n, text!) : await ctx.ui.custom<string>((_tui, theme, _kb, done) => {
				const c = new Container();
				const border = new DynamicBorder((s: string) => theme.fg("accent", s));
				c.addChild(border);
				c.addChild(new Text(theme.fg("accent", `\u2726 ${n.tag}`), 1, 0));
				c.addChild(new Markdown(text!, 1, 1, getMarkdownTheme()));
				// Enter and Esc also work: Enter means Got it, Esc means Dismiss.
				c.addChild(new ButtonRow(EXPLAIN_SCREEN_BUTTONS, theme, done));
				c.addChild(border);
				return {
					render: (w: number) => c.render(w),
					invalidate: () => c.invalidate(),
					handleMouse: (e: TuiMouseEvent) => c.handleMouse(e),
					handleInput: (d: string) => {
						if (d === "1" || matchesKey(d, "enter")) done("understood");
						else if (d === "2") done("chat");
						else if (d === "s") done("simpler_words");
						else if (d === "l") done("less_detail");
						else if (d === "m") done("more_detail");
						else if (d === "0" || matchesKey(d, "escape")) done("dismiss");
					},
				};
			});
			if (choice === "simpler_words" || choice === "less_detail" || choice === "more_detail") {
				ctx.ui.notify("Rewriting\u2026", "info");
				try {
					const r = await fork(
						ctx,
						lastLlmMessages,
						explainPrompt(n.line, { direction: choice, text: text! }),
						new AbortController().signal,
					);
					if (r.text) text = r.text;
				} catch (err) {
					ctx.ui.notify(`Couldn\u2019t write that explanation: ${err}`, "error");
				}
				continue;
			}
			log({ event: "explained", answer: choice, line: n.line });
			if (choice === "chat") chatInMain(n, text);
			return;
		}
	}

	// Outside the terminal UI: the explanation as a notice, then the same choices as a select.
	const EXPLAIN_OPTIONS = { Understood: "understood", "Chat in main session": "chat", "Simpler words": "simpler_words", "Less detail": "less_detail", "More detail": "more_detail" } as const;
	async function explainBySelect(ctx: ExtensionContext, n: Note, text: string) {
		ctx.ui.notify(`${n.tag} \u00b7 ${n.line}\n\n${text}`, "info");
		const pick = await ctx.ui.select(`${n.tag} \u00b7 ${n.line}`, Object.keys(EXPLAIN_OPTIONS));
		return pick ? EXPLAIN_OPTIONS[pick as keyof typeof EXPLAIN_OPTIONS] : "dismiss";
	}

	// CC's un(): quote the note into the main session.
	function chatInMain(n: Note, explanation?: string) {
		const body = [`${n.tag}${n.from ? ` (from subagent ${n.from})` : ""} \u00b7 ${n.line}`, ...(n.evidence ? [`Evidence: ${n.evidence}`] : []), ...(explanation ? ["", explanation] : [])]
			.join("\n")
			.split("\n")
			.map((l) => (l === "" ? ">" : `> ${l}`))
			.join("\n");
		pi.sendUserMessage(`Here is a note offered by a side agent:\n${body}`, { deliverAs: "followUp" });
	}

	async function respond(ctx: ExtensionContext, arg?: string) {
		if (arg === "on" || arg === "off") {
			state.enabled = arg === "on";
			saveState(state);
			if (!state.enabled) clearNotes(ctx);
			ctx.ui.notify(`You should know: ${state.enabled ? "on" : "off"}`, "info");
			return;
		}
		if (arg === "test") {
			// A sample note, shown at once, to check the display path without waiting for a real one.
			const note: Note = { id: "test" + crypto.randomUUID(), line: "This is a test note from /ysk test.", tag: "Heads up", evidence: "/ysk test", explanation: "Nothing is wrong. This note only checks that notes reach your screen.", shownAt: Date.now(), promptsSurvived: 0 };
			notes.push(note);
			render(ctx);
			if (ctx.mode !== "tui") ctx.ui.notify(noteText(note), "info");
			return;
		}
		if (arg?.startsWith("answer ")) {
			answerFromClient(ctx, arg.slice("answer ".length));
			return;
		}
		if (arg === "status") {
			const { model, thinking } = pickModel(ctx);
			ctx.ui.notify(
				`You should know: ${state.enabled ? "on" : "off"} \u00b7 ${checks} checks this session \u00b7 skip ${state.skip} \u00b7 model ${model?.provider ?? "?"}/${model?.id ?? "?"} \u00b7 thinking ${thinking ?? "main request"} \u00b7 config ${CONFIG_FILE} \u00b7 log ${LOG_FILE}`,
				"info",
			);
			return;
		}
		if (notes.length === 0) {
			ctx.ui.notify(`Nothing to know right now. (${state.enabled ? `${checks} checks so far` : "off: /ysk on"})`, "info");
			return;
		}
		// RPC clients (T3) show and answer notes in their own UI; a second menu here only duplicates it.
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Answer notes where your client shows them.", "info");
			return;
		}
		const n = current();
		const options = ["1 Learn more", "2 Knew this already", "3 Chat in main session", "0 Dismiss"];
		const pick = await ctx.ui.select(`${n.tag} \u00b7 ${n.line}`, options);
		if (!pick || !notes.includes(n)) return;
		removeNote(ctx, n);
		const k = pick[0];
		log({ event: "answer", answer: { "1": "learn_more", "2": "knew", "3": "chat", "0": "dismiss" }[k], line: n.line, msToAnswer: Date.now() - n.shownAt });
		if (k === "1") await showExplanation(ctx, n).catch((err) => ctx.ui.notify(`Couldn\u2019t write that explanation: ${err}`, "error"));
		else if (k === "2") remember(n.line, true);
		else if (k === "3") chatInMain(n, n.explanation);
	}

	// RPC clients answer notes in their own UI, then send `/ysk answer <id> <action>`
	// (T3 Code's actions: knew, dismiss, learn, send). The client already showed the
	// explanation or quoted the note to the agent, so this only records the answer.
	const CLIENT_ANSWERS: Record<string, string> = { knew: "knew", dismiss: "dismiss", learn: "learn_more", send: "chat" };
	function answerFromClient(ctx: ExtensionContext, rest: string) {
		const [id, action] = rest.trim().split(/\s+/);
		const answer = action && Object.hasOwn(CLIENT_ANSWERS, action) ? CLIENT_ANSWERS[action] : undefined;
		const prior = answered.get(id);
		const n = notes.find((x) => x.id === id) ?? prior?.note;
		if (n && action === "undo") {
			if (prior?.action === "knew") remember(n.line, false);
			answered.delete(id);
			if (!notes.some((x) => x.id === id)) notes.push(n);
			saveState(state);
			render(ctx);
			return;
		}
		if (!n || !answer) {
			log({ event: "answer_ignored", id, action, via: "client" });
			return;
		}
		answered.set(id, { note: n, action });
		notes = notes.filter((x) => x !== n);
		state.ignoredInARow = 0;
		state.skip = 0;
		if (answer === "knew") remember(n.line, true);
		saveState(state);
		render(ctx);
		log({ event: "answer", answer, via: "client", line: n.line, msToAnswer: Date.now() - n.shownAt });
	}

	// One keystroke: dismiss the current note, no menu.
	function quickDismiss(ctx: ExtensionContext) {
		const n = current();
		if (!n) return;
		removeNote(ctx, n);
		log({ event: "answer", answer: "dismiss", via: "alt+x", line: n.line, msToAnswer: Date.now() - n.shownAt });
	}

	pi.registerCommand("ysk", {
		description: "You should know: respond to the current note (/ysk on|off|status|test)",
		handler: async (args, ctx) => respond(ctx, args?.trim() || undefined),
	});
	pi.registerShortcut("alt+shift+y", { description: "You should know: respond to the current note", handler: (ctx) => respond(ctx) });
	pi.registerShortcut("alt+x", { description: "You should know: dismiss the top note", handler: (ctx) => quickDismiss(ctx) });
}
