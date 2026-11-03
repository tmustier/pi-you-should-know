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
  if (specifier === '@earendil-works/pi-tui') return { url: data('export class Container {}; export class Markdown {}; export class Text {}; export const matchesKey = () => false; export const truncateToWidth = (s) => s; export const visibleWidth = (s) => s.length; export const wrapTextWithAnsi = (s) => [s]'), shortCircuit: true };
  return next(specifier, context);
}});
const { default: extension } = await import(process.env.YSK_TEST_SOURCE ?? '../extensions/you-should-know/index.ts');
function open(session, sessionDir = home) {
  const handlers = new Map();
  const notices = [];
  let command;
  extension({ on: (event, handler) => handlers.set(event, handler), registerCommand: (_, value) => { command = value.handler; }, registerShortcut() {} });
  const ctx = {
    mode: 'rpc', hasUI: false, isIdle: () => false,
    sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => session },
    ui: { notify: (message) => notices.push(message) },
  };
  handlers.get('session_start')({}, ctx);
  return { notices, command: (text) => command(text, ctx), input: (text) => handlers.get('input')({ source: 'rpc', text }, ctx), close: () => handlers.get('session_shutdown')({}, ctx) };
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

test('each note ends with Ask agent and × buttons that answer it in one click', async () => {
  const handlers = new Map();
  const sent = [];
  let command, widget;
  extension({ on: (event, handler) => handlers.set(event, handler), registerCommand: (_, value) => { command = value.handler; }, registerShortcut() {}, sendUserMessage: (text) => sent.push(text) });
  const ctx = {
    mode: 'tui', hasUI: true, isIdle: () => true, cwd: home,
    sessionManager: { getSessionDir: () => home, getSessionId: () => 'inline-buttons' },
    ui: { notify() {}, setWidget: (_, factory) => { widget = factory?.(undefined, { fg: (_, s) => s, bold: (s) => s }); } },
  };
  handlers.get('session_start')({}, ctx);
  const click = (text, label) => {
    const lines = widget.render(100);
    const y = lines.findIndex((line) => line.includes(text));
    assert.ok(y >= 0, `no line contains ${text}:\n${lines.join('\n')}`);
    widget.handleMouse({ type: 'click', button: 'left', x: lines[y].indexOf(label) + 1, y });
  };
  await command('test', ctx);
  assert.match(widget.render(100)[0], /This is a test note from \/ysk test\. {2}\[Ask agent\] {2}\[×\]$/);
  click('test note', '[Ask agent]');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /This is a test note/);
  await command('test', ctx);
  click('test note', '[×]');
  assert.deepEqual(widget.render(100), ['  Dismissed · Undo']);
  // When the last line has no room left, the buttons get a line of their own.
  await command('test', ctx);
  const narrow = widget.render(50);
  assert.deepEqual(narrow.slice(0, 2), ['✦ Heads up · This is a test note from /ysk test.', '  [Ask agent]  [×]']);
  widget.handleMouse({ type: 'click', button: 'left', x: narrow[1].indexOf('[×]') + 1, y: 1 });
  assert.deepEqual(widget.render(50), ['  Dismissed · Undo']);
  handlers.get('session_shutdown')({}, ctx);
});
