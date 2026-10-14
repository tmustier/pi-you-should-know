import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks } from 'node:module';

// Terminal-mode notes with a scripted side model: each side request takes the next reply
// and records the prompt it was sent, so the tests see exactly what the side agent was asked.
const home = mkdtempSync(join(tmpdir(), 'ysk-settle-'));
process.env.YSK_DEBUG = '1';
after(() => rmSync(home, { recursive: true, force: true }));
const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:os') return { url: data(`export const homedir = () => ${JSON.stringify(home)}`), shortCircuit: true };
  if (specifier === '@earendil-works/pi-coding-agent') return { url: data('export class DynamicBorder {}; export const getMarkdownTheme = () => ({})'), shortCircuit: true };
  if (specifier === '@earendil-works/pi-tui') return { url: data(`
    export class Container {}; export class Markdown { render() { return []; } }; export class Text {};
    export const matchesKey = () => false;
    export const truncateToWidth = (s) => s;
    export const wrapTextWithAnsi = (s) => [s];
    export const visibleWidth = (s) => s.length;
  `), shortCircuit: true };
  return next(specifier, context);
}});
const { default: extension } = await import(process.env.YSK_TEST_SOURCE ?? '../extensions/you-should-know/index.ts');

const settleDown = () => new Promise((resolve) => setTimeout(resolve, 20));
function open(session) {
  const handlers = new Map();
  const replies = [];
  const prompts = [];
  const notices = [];
  let widget;
  extension({ on: (event, handler) => handlers.set(event, handler), registerCommand() {}, registerShortcut() {} });
  const ctx = {
    mode: 'tui', hasUI: true, cwd: home, isIdle: () => false,
    model: { id: 'fixture', provider: 'fixture', api: 'anthropic-messages' },
    getSystemPrompt: () => 'system',
    modelRegistry: { complete: async (_model, context, options) => {
      prompts.push(context.messages.at(-1).content[0].text);
      options.onPayload({ model: 'fixture', messages: context.messages });
      const text = await (replies.shift() ?? 'learn: none');
      return { content: [{ type: 'text', text }], usage: { cacheRead: 1200, cacheWrite: 0 }, stopReason: 'stop' };
    } },
    sessionManager: { getSessionDir: () => home, getSessionId: () => session },
    ui: { notify: (message) => notices.push(message), setWidget: (_name, value) => { widget = value; } },
  };
  handlers.get('session_start')({}, ctx);
  let turn = 0;
  const llm = { llmMessages: [{ role: 'user', content: [{ type: 'text', text: 'work' }] }] };
  return {
    replies, prompts, notices,
    main: (messages, cached) => {
      handlers.get('before_provider_request')({ payload: { model: 'fixture', messages } });
      handlers.get('message_end')({ message: { role: 'assistant', usage: { cacheRead: cached, cacheWrite: 0 } } });
    },
    input: () => handlers.get('input')({ source: 'tui', text: 'new work' }, ctx),
    restart: () => handlers.get('session_start')({}, ctx),
    // Pi numbers turns within a run; a check runs on every sixth.
    turns: async (n) => { for (let i = 0; i < n; i++) { handlers.get('turn_end')({ turnIndex: ++turn, context: llm }, ctx); await settleDown(); } },
    end: async () => { await handlers.get('agent_before_settle')({ context: llm }, ctx); await settleDown(); turn = 0; },
    lines: () => {
      const component = widget?.(null, { fg: (_n, t) => t, bold: (t) => t });
      return component ? component.render(200) : [];
    },
    // Fullscreen mouse: render, then left-click column x of row y.
    click: async (x, y) => {
      const component = widget(null, { fg: (_n, t) => t, bold: (t) => t });
      component.render(200);
      component.handleMouse({ type: 'click', button: 'left', x, y });
      await settleDown();
    },
    close: () => handlers.get('session_shutdown')({}, ctx),
  };
}
const note = (line) => `learn: ${line}\ntag: Heads up\nevidence: none\nexplain: **${line}**`;
const events = () => readFileSync(join(home, '.pi/agent/you-should-know/checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('the terminal shows one note and a count of the rest', async () => {
  const s = open('one-at-a-time');
  s.replies.push(note('First thing.'), note('Second thing.'), note('Third thing.'));
  await s.turns(18);
  assert.deepEqual(s.lines(), ['\u2726 Heads up \u00b7 First thing.', '  2 more waiting']);
  await s.click(3, 1);
  assert.deepEqual(s.lines(), ['\u2726 Heads up \u00b7 First thing.', '\u2727 Heads up \u00b7 Second thing.', '\u2727 Heads up \u00b7 Third thing.', '  Show one']);
  await s.click(3, 3);
  assert.equal(s.lines().length, 2);
  s.close();
});

test('a later check settles notes the agent has dealt with and says how long they waited', async () => {
  const s = open('settle-at-check');
  s.replies.push(note('The agent just read a broken lockfile.'), note('Tests were skipped.'));
  await s.turns(12);
  assert.equal(s.lines().length, 2);
  s.replies.push('settled: #1\nlearn: none');
  await s.turns(6);
  assert.match(s.prompts.at(-1), /- #1 \(raised 12 steps ago\): The agent just read a broken lockfile\.\n- #2 \(raised 6 steps ago\): Tests were skipped\./);
  assert.deepEqual(s.lines(), ['\u2726 Heads up \u00b7 Tests were skipped.']);
  assert.ok(events().some((e) => e.event === 'settled' && e.via === 'check' && e.line === 'The agent just read a broken lockfile.'));
  s.close();
});

test('the end of a run settles notes once, unless the last check saw the final step', async () => {
  const s = open('settle-at-end');
  s.replies.push(note('Deploy was skipped.'));
  await s.turns(7);
  s.replies.push('settled: #1');
  await s.end();
  assert.deepEqual(s.lines(), []);
  const asked = s.prompts.length;
  s.replies.push(note('Another note.'));
  await s.turns(6);
  await s.end();
  assert.equal(s.prompts.length, asked + 1, 'no settle request when the last check saw the final step');
  s.close();
});

test('a full queue keeps its notes and holds new ones back for later', async () => {
  const s = open('queue-full');
  for (let i = 1; i <= 5; i++) s.replies.push(note(`Note ${i}.`));
  await s.turns(30);
  s.replies.push('settled: none\n' + note('Note 6.'));
  await s.turns(6);
  assert.deepEqual(s.lines(), ['\u2726 Heads up \u00b7 Note 1.', '  4 more waiting']);
  assert.ok(events().some((e) => e.outcome === 'queue_full' && e.line === 'Note 6.'));
  s.close();
});

test('a delayed detection is settled after the final step even when no notes were waiting', { timeout: 2000 }, async () => {
  const s = open('delayed-detection');
  const pending = Promise.withResolvers();
  s.replies.push(pending.promise, 'settled: #1');
  await s.turns(7);
  await s.end();
  pending.resolve(note('Delayed note.'));
  await settleDown();
  assert.deepEqual(s.lines(), []);
  assert.equal(s.prompts.length, 2);
  await s.end();
  assert.equal(s.prompts.length, 2);
  s.close();
});

for (const interrupt of ['input', 'close']) test(`queued settling does not outlive ${interrupt}`, async () => {
  const s = open('queued-' + interrupt);
  s.replies.push(note('Keep this note: ' + interrupt));
  await s.turns(6);
  const pending = Promise.withResolvers();
  s.replies.push(pending.promise);
  await s.turns(7);
  await s.end();
  s[interrupt]();
  pending.resolve('learn: none');
  await settleDown();
  assert.equal(s.prompts.length, 2);
  assert.match(s.lines()[0], /Keep this note/);
  s.close();
});

for (const via of ['check', 'end']) test(`new input invalidates an in-flight ${via} settlement`, async () => {
  const s = open('stale-' + via);
  s.replies.push(note('Still relevant: ' + via));
  await s.turns(7);
  const pending = Promise.withResolvers();
  s.replies.push(pending.promise);
  if (via === 'check') await s.turns(5); else await s.end();
  s.input();
  pending.resolve('settled: #1\nlearn: none');
  await settleDown();
  assert.match(s.lines()[0], /Still relevant/);
  s.close();
});

test('a check settles an old note without immediately re-raising its duplicate', async () => {
  const s = open('duplicate-settled');
  s.replies.push(note('Duplicate note.'));
  await s.turns(6);
  // Session notes can outlive the bounded global seen history.
  const file = join(home, '.pi/agent/you-should-know/state.json');
  const state = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...state, seen: [] }));
  s.restart();
  s.replies.push('settled: #1\n' + note('Duplicate note.'));
  await s.turns(6);
  assert.deepEqual(s.lines(), []);
  s.close();
});

test('concurrent explanation cannot overwrite detection cache diagnostics', async () => {
  const s = open('concurrent-cache');
  s.replies.push('learn: Explain this.\ntag: Heads up');
  await s.turns(6);
  const pending = Promise.withResolvers();
  s.main([{ role: 'user', content: [{ type: 'text', text: 'work' }] }], 1200);
  s.replies.push(pending.promise);
  await s.turns(6);
  // The explanation sees a different, nonmatching main prefix while detection waits.
  s.main([{ role: 'user', content: [{ type: 'text', text: 'different' }] }], 9000);
  s.replies.push('An explanation.');
  await s.click(3, 0);
  await s.click(3, 1);
  pending.resolve('learn: none');
  await settleDown();
  const check = events().findLast((e) => e.event === 'check');
  assert.deepEqual(check.cache, { read: 1200, expected: 1200, ok: true });
  assert.equal(check.align.common, 1);
  assert.ok(!s.notices.some((n) => n.includes('fewer than')));
  s.close();
});
