import fs from 'node:fs';
import path from 'node:path';
import spawn from 'cross-spawn';
import { getLocations, prepareLocations } from './paths.cjs';

export const DATA_DIR = getLocations().dataDir;
export const HUB_STATE = path.join(DATA_DIR, 'hub-state.json');
export const HUB_RUNTIME = path.join(DATA_DIR, 'hub-runtime.json');
export const AGENTS = [
  { id: 'codex-desktop', name: 'Codex 桌面', short: 'CD', description: '选择电脑上已有聊天，或创建新任务', color: '#2563eb' },
  { id: 'codex-cli', name: 'Codex CLI', short: 'CX', description: '终端任务与持续对话', color: '#0f766e' },
  { id: 'claude', name: 'Claude Code', short: 'CC', description: '终端任务与持续对话', color: '#b65b38' },
];

export function cleanPath(input) {
  return path.resolve(String(input).replace(/^\\\\\?\\/, ''));
}

export function readFeishuCredentials() {
  const locations=prepareLocations(), file=locations.routerConfig;
  if(fs.existsSync(path.join(locations.dataDir,'binding-disabled')))throw new Error('飞书尚未绑定，请在程序设置中连接。');
  const text = fs.readFileSync(file, 'utf8');
  const section = text.split(/(?=^\[\[providers\]\])/m).find(s => /^id\s*=\s*"feishu_lark"\s*$/m.test(s));
  if (!section) throw new Error('未找到已绑定的飞书机器人。');
  const field = key => {
    const match = section.match(new RegExp(`^${key}\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")\\s*$`, 'm'));
    return match ? JSON.parse(match[1]) : null;
  };
  const result = { appId: field('app_id'), appSecret: field('app_secret'), ownerId: field('operator_open_id') };
  if (Object.values(result).some(v => !v)) throw new Error('飞书绑定信息不完整。');
  return result;
}

export function findCodex() {
  const found = spawn.sync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true }).stdout?.trim().split(/\r?\n/)[0];
  if (found && fs.existsSync(found)) return found;
  const root = path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(root)) {
    const files = fs.readdirSync(root).map(name => path.join(root, name, 'codex.exe'))
      .filter(f => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length) return files[0];
  }
  throw new Error('找不到 Codex CLI，请检查桌面应用安装。');
}

export function log(event, fields = {}) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.appendFileSync(path.join(DATA_DIR, 'hub.log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}
