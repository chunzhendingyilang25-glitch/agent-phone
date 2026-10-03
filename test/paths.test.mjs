import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import paths from '../hub/paths.cjs';

const { getLocations, prepareLocations } = paths;
const stateNames = ['hub-state.json', 'runtime.json', 'hub-runtime.json', 'hub.log.jsonl', 'notifications.jsonl', 'hub.stdout.log', 'hub.stderr.log'];

function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'agent-phone-paths-中文 空格-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), temporaryRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const profile = path.join(directory, '用户 目录');
  const env = {
    USERPROFILE: profile,
    APPDATA: path.join(directory, '进程 重定向', 'Roaming'),
    LOCALAPPDATA: path.join(directory, '进程 重定向', 'Local'),
  };
  const packageCache = path.join(profile, 'AppData', 'Local', 'Packages', 'OpenAI.Codex_test-package', 'LocalCache');
  return { directory, profile, env, packageCache };
}

function write(file, contents, age = 0) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  const date = new Date(Date.UTC(2026, 0, 1) + age * 1000);
  fs.utimesSync(file, date, date);
  return file;
}

function binding(label = 'fixture', extra = '') {
  return `[global]\nname = "test-only"\n\n[[providers]]\nid = "feishu_lark"\napp_id = "fake-app-${label}"\napp_secret = "fake-secret-${label}"\noperator_open_id = "fake-owner-${label}"\n${extra}`;
}

test('canonical paths depend on USERPROFILE across Explorer and packaged process environments', t => {
  const { profile, env } = fixture(t);
  const expected = {
    dataDir: path.join(profile, '.agent-phone'),
    routerConfig: path.join(profile, '.agent-phone', 'feishu-config.toml'),
  };
  assert.deepEqual(getLocations(env), expected);
  assert.deepEqual(getLocations({ USERPROFILE: profile }), expected);
  assert.deepEqual(getLocations({ ...env, APPDATA: '', LOCALAPPDATA: '' }), expected);
  assert.deepEqual(getLocations({ ...env, APPDATA: 'another-roaming', LOCALAPPDATA: 'another-local' }), expected);
});

test('an unconfigured install prepares the canonical directory without inventing a binding', t => {
  const { env } = fixture(t);
  const result = prepareLocations(env);
  assert.deepEqual(result, getLocations(env));
  assert.equal(fs.statSync(result.dataDir).isDirectory(), true);
  assert.equal(fs.existsSync(result.routerConfig), false);
  assert.equal(fs.existsSync(path.join(result.dataDir, 'migration.json')), false);
});

test('a packaged Codex binding and all supported state files are discovered despite different AppData variables', t => {
  const { env, packageCache } = fixture(t);
  const sourceConfig = write(path.join(packageCache, 'Roaming', 'agents-router', 'config.toml'), binding('packaged'));
  for (const name of stateNames) write(path.join(packageCache, 'Local', 'agent-phone', name), `packaged:${name}`);
  const result = prepareLocations(env);
  assert.equal(fs.readFileSync(result.routerConfig, 'utf8'), binding('packaged'));
  for (const name of stateNames) assert.equal(fs.readFileSync(path.join(result.dataDir, name), 'utf8'), `packaged:${name}`);
  const migration = JSON.parse(fs.readFileSync(path.join(result.dataDir, 'migration.json'), 'utf8'));
  assert.equal(migration.sources.binding, sourceConfig);
  assert.deepEqual(Object.keys(migration.sources).sort(), ['binding', ...stateNames].sort());
  assert.doesNotMatch(JSON.stringify(migration), /fake-secret|fake-app|fake-owner/);
});

test('missing or empty APPDATA falls back to the normal profile Roaming folder', t => {
  const { profile } = fixture(t);
  write(path.join(profile, 'AppData', 'Roaming', 'agents-router', 'config.toml'), binding('normal-profile'));
  const result = prepareLocations({ USERPROFILE: profile, APPDATA: '', LOCALAPPDATA: '' });
  assert.equal(fs.readFileSync(result.routerConfig, 'utf8'), binding('normal-profile'));
});

test('the most recent valid binding wins while newer incomplete or malformed providers are skipped', t => {
  const { env, profile, packageCache } = fixture(t);
  write(path.join(profile, 'AppData', 'Roaming', 'agents-router', 'config.toml'), binding('old-valid'), 1);
  write(path.join(env.APPDATA, 'agents-router', 'config.toml'), binding('latest-valid'), 2);
  write(path.join(packageCache, 'Roaming', 'agents-router', 'config.toml'), binding('incomplete').replace('operator_open_id = "fake-owner-incomplete"', 'operator_open_id = ""'), 3);
  const malformedCache = path.join(profile, 'AppData', 'Local', 'Packages', 'OpenAI.Codex_broken', 'LocalCache');
  write(path.join(malformedCache, 'Roaming', 'agents-router', 'config.toml'), binding('malformed').replace('app_secret = "fake-secret-malformed"', 'app_secret = "unterminated'), 4);
  const result = prepareLocations(env);
  assert.equal(fs.readFileSync(result.routerConfig, 'utf8'), binding('latest-valid'));
});

test('state migration picks the newest source for each file and leaves existing canonical data intact', t => {
  const { env, profile, packageCache } = fixture(t);
  const result = getLocations(env);
  write(path.join(result.dataDir, 'hub-state.json'), 'canonical-state', 0);
  write(result.routerConfig, binding('canonical'), 0);
  write(path.join(env.APPDATA, 'agents-router', 'config.toml'), binding('legacy-newer'), 5);
  for (const name of stateNames) {
    write(path.join(env.LOCALAPPDATA, 'agent-phone', name), `redirected:${name}`, 1);
    write(path.join(profile, 'AppData', 'Local', 'agent-phone', name), `normal:${name}`, 2);
    write(path.join(packageCache, 'Local', 'agent-phone', name), `packaged:${name}`, 3);
  }
  write(path.join(env.LOCALAPPDATA, 'agent-phone', 'runtime.json'), 'newest-runtime', 4);
  assert.deepEqual(prepareLocations(env), result);
  assert.equal(fs.readFileSync(result.routerConfig, 'utf8'), binding('canonical'));
  assert.equal(fs.readFileSync(path.join(result.dataDir, 'hub-state.json'), 'utf8'), 'canonical-state');
  assert.equal(fs.readFileSync(path.join(result.dataDir, 'runtime.json'), 'utf8'), 'newest-runtime');
  for (const name of stateNames.filter(name => !['hub-state.json', 'runtime.json'].includes(name))) {
    assert.equal(fs.readFileSync(path.join(result.dataDir, name), 'utf8'), `packaged:${name}`);
  }
  const migration = JSON.parse(fs.readFileSync(path.join(result.dataDir, 'migration.json'), 'utf8'));
  assert.equal(migration.sources.binding, undefined);
  assert.equal(migration.sources['hub-state.json'], undefined);
  write(path.join(env.LOCALAPPDATA, 'agent-phone', 'runtime.json'), 'changed-after-migration', 6);
  prepareLocations(env);
  assert.equal(fs.readFileSync(path.join(result.dataDir, 'runtime.json'), 'utf8'), 'newest-runtime');
});

test('an explicit binding refresh updates the canonical binding without overwriting state', t => {
  const { env } = fixture(t);
  const result = getLocations(env);
  write(result.routerConfig, binding('previous'));
  write(path.join(result.dataDir, 'hub-state.json'), 'preserved-sessions');
  write(path.join(env.APPDATA, 'agents-router', 'config.toml'), binding('new-binding'), 1);
  write(path.join(env.LOCALAPPDATA, 'agent-phone', 'hub-state.json'), 'legacy-sessions', 2);
  prepareLocations(env, { importBinding: true });
  assert.equal(fs.readFileSync(result.routerConfig, 'utf8'), binding('new-binding'));
  assert.equal(fs.readFileSync(path.join(result.dataDir, 'hub-state.json'), 'utf8'), 'preserved-sessions');
});

test('an explicit binding refresh with no valid source keeps the previous working binding', t => {
  const { env } = fixture(t);
  const result = getLocations(env);
  write(result.routerConfig, binding('working'));
  write(path.join(env.APPDATA, 'agents-router', 'config.toml'), '[[providers]]\nid = "feishu_lark"\napp_id = "incomplete"', 1);
  prepareLocations(env, { importBinding: true });
  assert.equal(fs.readFileSync(result.routerConfig, 'utf8'), binding('working'));
});

test('a shutdown runtime removed after migration never returns from legacy state, including a binding refresh', t => {
  const { env } = fixture(t);
  const sourceConfig = path.join(env.APPDATA, 'agents-router', 'config.toml');
  const oldRuntime = JSON.stringify({ pid: 12345, token: 'fake-expired-token' });
  write(sourceConfig, binding('first'));
  write(path.join(env.LOCALAPPDATA, 'agent-phone', 'hub-runtime.json'), oldRuntime);
  const result = prepareLocations(env);
  const runtime = path.join(result.dataDir, 'hub-runtime.json');
  assert.equal(fs.readFileSync(runtime, 'utf8'), oldRuntime);
  assert.equal(fs.existsSync(path.join(result.dataDir, 'migration.json')), true);

  // A normal shutdown removes the canonical runtime, while legacy data remains.
  fs.unlinkSync(runtime);
  prepareLocations(env);
  assert.equal(fs.existsSync(runtime), false);

  write(sourceConfig, binding('refreshed'), 1);
  prepareLocations(env, { importBinding: true });
  assert.equal(fs.readFileSync(result.routerConfig, 'utf8'), binding('refreshed'));
  assert.equal(fs.existsSync(runtime), false);
  prepareLocations(env);
  assert.equal(fs.existsSync(runtime), false);
});
