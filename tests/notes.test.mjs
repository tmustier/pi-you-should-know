import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerHooks, syncBuiltinESMExports } from 'node:module';

const home = mkdtempSync(join(tmpdir(), 'ysk-test-'));
after(() => rmSync(home, { recursive: true, force: true }));
const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:os') return { url: data(`export const homedir = () => ${JSON.stringify(home)}`), shortCircuit: true };
  if (specifier === '@earendil-works/pi-coding-agent') return { url: data('export class DynamicBorder {}; export const getMarkdownTheme = () => ({})'), shortCircuit: true };
  if (specifier === '@earendil-works/pi-tui') return { url: data(`
    export class Container { children = []; addChild(child) { this.children.push(child); } }
    export class Markdown {}
    export class Text { constructor(text, left, right) { this.text = text; this.left = left; this.right = right; } }
    export const matchesKey = () => false;
  `), shortCircuit: true };
  return next(specifier, context);
}});
const { default: extension } = await import(process.env.YSK_TEST_SOURCE ?? '../extensions/you-should-know/index.ts');
function open(session, sessionDir = home, mode = 'rpc') {
  const handlers = new Map();
  const notices = [];
  let widget;
  let command;
  extension({ on: (event, handler) => handlers.set(event, handler), registerCommand: (_, value) => { command = value.handler; }, registerShortcut() {} });
  const ctx = {
    mode, hasUI: mode === 'tui', isIdle: () => false,
    sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => session },
    ui: { notify: (message) => notices.push(message), setWidget: (_name, value) => { widget = value; } },
  };
  handlers.get('session_start')({}, ctx);
  return { notices, widget: () => widget, command: (text) => command(text, ctx), input: (text) => handlers.get('input')({ source: mode, text }, ctx), close: () => handlers.get('session_shutdown')({}, ctx) };
}
const state = () => { const file = join(home, '.pi/agent/you-should-know/state.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { known: [], ignoredInARow: 0, skip: 0 }; };

test('RPC prompts count ignored notes and back off, but ysk commands do not', async () => {
  const client = open('backoff');
  for (let i = 0; i < 3; i++) await client.command('test');
  client.input('/ysk status');
  client.input('first user prompt');
  await client.command('status');
  assert.match(client.notices.at(-1), /skip 0/);
  client.input('second user prompt');
  assert.equal(state().ignoredInARow, 3);
  assert.equal(state().skip, 1);
  client.close();
});

 test('a failed atomic replacement preserves the previous session notes', async () => {
  const client = open('interrupted-write');
  await client.command('test');
  const file = join(home, 'artifacts/interrupted-write/you-should-know.json');
  const before = readFileSync(file, 'utf8');
  const rename = fs.renameSync;
  try {
    fs.renameSync = (source, target) => { if (target === file) throw new Error('simulated interrupted replacement'); return rename(source, target); };
    syncBuiltinESMExports();
    await assert.rejects(client.command('test'), /simulated interrupted replacement/);
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(file + '.tmp-' + process.pid), false);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); client.close(); }
});

test('temporary Pi discovery sessions do not create artifacts in the working directory', async () => {
  const cwd = process.cwd();
  process.chdir(home);
  try {
    const client = open('temporary-discovery', '');
    await client.command('test');
    client.close();
    assert.equal(existsSync(join(home, 'artifacts/temporary-discovery')), false);
  } finally { process.chdir(cwd); }
});

test('the terminal widget shows one readable note and a compact queue count', async () => {
  const client = open('compact-widget', home, 'tui');
  await client.command('test');
  await client.command('test');
  const theme = { fg: (_name, text) => text, bold: (text) => text };
  const component = client.widget()(null, theme);
  assert.deepEqual(component.children.map(({ text, left }) => ({ text, left })), [
    { text: '✦ Heads up · 2 notes', left: 0 },
    { text: 'This is a test note from /ysk test.', left: 2 },
    { text: '1 more queued', left: 2 },
  ]);
  client.close();
});
