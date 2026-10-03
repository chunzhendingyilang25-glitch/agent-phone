const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// USERPROFILE is shared by packaged Codex and Explorer. AppData may be
// redirected into an MSIX LocalCache for one process and not the other.
function getLocations(env = process.env) {
  const profile = env.USERPROFILE || os.homedir();
  const dataDir = path.join(profile, '.agent-phone');
  return { dataDir, routerConfig: path.join(dataDir, 'feishu-config.toml') };
}

function legacyLocations(env) {
  const profile = env.USERPROFILE || os.homedir();
  const local = path.join(profile, 'AppData', 'Local');
  const roaming = path.join(profile, 'AppData', 'Roaming');
  const configRoots = [env.APPDATA, roaming].filter(Boolean);
  const stateRoots = [env.LOCALAPPDATA, local].filter(Boolean);
  const packages = path.join(local, 'Packages');
  try {
    for (const entry of fs.readdirSync(packages, { withFileTypes: true })) {
      if (entry.isDirectory() && /^OpenAI\.Codex_/i.test(entry.name)) {
        const cache = path.join(packages, entry.name, 'LocalCache');
        configRoots.push(path.join(cache, 'Roaming'));
        stateRoots.push(path.join(cache, 'Local'));
      }
    }
  } catch {}
  return {
    configs: [...new Set(configRoots.map(root => path.join(root, 'agents-router', 'config.toml')))],
    states: [...new Set(stateRoots.map(root => path.join(root, 'agent-phone')))],
  };
}

function newestFiles(files) {
  return files.flatMap(file => {
    try { const stat = fs.statSync(file); return stat.isFile() ? [{ file, time: stat.mtimeMs }] : []; }
    catch { return []; }
  }).sort((a, b) => b.time - a.time).map(item => item.file);
}

function validBinding(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const section = text.split(/(?=^\[\[providers\]\])/m).find(s => /^id\s*=\s*"feishu_lark"\s*$/m.test(s));
    return section && ['app_id', 'app_secret', 'operator_open_id'].every(key => {
      const match = section.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm'));
      return match && typeof JSON.parse(match[1]) === 'string' && JSON.parse(match[1]).length > 0;
    });
  } catch { return false; }
}

function prepareLocations(env = process.env, { importBinding = false } = {}) {
  const locations = getLocations(env), legacy = legacyLocations(env);
  fs.mkdirSync(locations.dataDir, { recursive: true });
  const migrated = {};
  if (importBinding || (!fs.existsSync(locations.routerConfig) && !fs.existsSync(path.join(locations.dataDir,'binding-disabled')))) {
    const source = newestFiles(legacy.configs).find(validBinding);
    if (source) { fs.copyFileSync(source, locations.routerConfig); migrated.binding = source; }
  }
  const journal = path.join(locations.dataDir, 'migration.json');
  if (!fs.existsSync(journal)) {
    for (const name of ['hub-state.json', 'runtime.json', 'hub-runtime.json', 'hub.log.jsonl', 'notifications.jsonl', 'hub.stdout.log', 'hub.stderr.log']) {
      const destination = path.join(locations.dataDir, name);
      if (fs.existsSync(destination)) continue;
      const source = newestFiles(legacy.states.map(root => path.join(root, name)))[0];
      if (source) { fs.copyFileSync(source, destination); migrated[name] = source; }
    }
  }
  if (Object.keys(migrated).length) fs.writeFileSync(journal, JSON.stringify({ at: new Date().toISOString(), sources: migrated }, null, 2));
  return locations;
}

module.exports = { getLocations, prepareLocations };
if (require.main === module) {
  try { console.log(JSON.stringify(prepareLocations(process.env, { importBinding: process.argv.includes('--import-binding') }))); }
  catch (error) { console.error('Agent Phone 路径初始化失败：' + error.message); process.exitCode = 1; }
}
