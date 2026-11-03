import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs, { existsSync, mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';

const home = mkdtempSync(join(tmpdir(), 'ysk-test-'));
after(() => rmSync(home, { recursive: true, force: true }));
const data = (source) => `data:text/javascript,${encodeURIComponent(source)}`;
const piRequire = createRequire(realpathSync(execFileSync('sh', ['-c', 'command -v pi'], { encoding: 'utf8' }).trim()));
const tui = piRequire.resolve('@earendil-works/pi-tui');
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'node:os') return { url: data(`export const homedir = () => ${JSON.stringify(home)}`), shortCircuit: true };
  if (specifier === '@earendil-works/pi-coding-agent') return { url: data('export class DynamicBorder { render() { return [] } invalidate() {} }; export const getMarkdownTheme = () => new Proxy({}, { get: () => (s) => s })'), shortCircuit: true };
  if (specifier === '@earendil-works/pi-tui') return { url: pathToFileURL(tui).href, shortCircuit: true };
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
const state = () => { const file = join(home, '.pi/agent/you-should-know/state.json'); return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ignoredInARow: 0, skip: 0 }; };

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
  click('test note', 'Heads up');
  assert.ok(widget.render(100).some((line) => line.trim() === '[Explain]'));
  click('[Explain]', '[Explain]');
  assert.ok(widget.render(100).some((line) => line.includes('Nothing is wrong.')));
  assert.ok(widget.render(100).some((line) => line.trim() === '[Ask agent]  [Dismiss]'));
  click('test note', '[Ask agent]');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /This is a test note/);
  assert.match(sent[0], /Nothing is wrong\./);
  await command('test', ctx);
  click('test note', '[×]');
  assert.deepEqual(widget.render(100), ['  Dismissed · Undo']);
  click('Undo', 'Undo');
  assert.match(widget.render(100)[0], /test note/);
  click('test note', '[×]');
  // Wrapping uses the full width, not a column reserved for buttons.
  await command('test', ctx);
  for (const width of [20, 30, 35, 40]) {
    const lines = widget.render(width).filter((line) => !line.includes('Undo'));
    assert.ok(lines.every((line) => line.length <= width));
    assert.ok(lines[0].length > width - '  [Ask agent]  [×]'.length);
    const text = lines.join(' ').replace(/\[Ask agent\]|\[×\]/g, '').replace(/\s+/g, ' ').trim();
    assert.equal(text, '✦ Heads up · This is a test note from /ysk test.');
  }
  const wrapped = widget.render(35);
  assert.match(wrapped.at(-2), /test\.  \[Ask agent\]  \[×\]$/);
  const narrow = widget.render(50);
  assert.deepEqual(narrow.slice(0, 2), ['✦ Heads up · This is a test note from /ysk test.', '  [Ask agent]  [×]']);
  widget.handleMouse({ type: 'click', button: 'left', x: narrow[1].indexOf('[×]') + 1, y: 1 });
  assert.deepEqual(widget.render(50), ['  Dismissed · Undo']);
  for (const key of ['2', '0', '\r', '\u001b']) {
    await command('test', ctx);
    ctx.ui.select = async (_title, options) => {
      assert.deepEqual(options, ['1 Explain', '2 Ask agent', '0 Dismiss']);
      return options[0];
    };
    ctx.ui.custom = async (factory) => new Promise((done) => {
      const screen = factory(null, { fg: (_, text) => text }, null, done);
      assert.ok(screen.render(100).some((line) => line.includes('[2 Ask agent]')));
      screen.handleInput(key);
    });
    const before = sent.length;
    await command('', ctx);
    assert.equal(sent.length, before + (key === '2' ? 1 : 0));
  }
  for (const pick of ['2 Ask agent', '0 Dismiss']) {
    await command('test', ctx);
    ctx.ui.select = async () => pick;
    const before = sent.length;
    await command('', ctx);
    assert.equal(sent.length, before + (pick[0] === '2' ? 1 : 0));
  }
  handlers.get('session_shutdown')({}, ctx);
});
