import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import asar from '@electron/asar';
import sevenZip from '7zip-bin';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtime = path.join(root, 'dist', 'win-unpacked', 'resources', 'runtime');
if (!fs.existsSync(runtime)) throw new Error('请先构建安装包。');
const forbidden = /(?:^|[/\\])(?:\.codex|\.claude|\.agent-phone|\.lark-channel|hub-state\.json|feishu-config\.toml|hub-runtime\.json)(?:$|[/\\])/i;
function walk(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name), relative = path.relative(runtime, full);
    if (forbidden.test(relative)) throw new Error('安装包包含用户数据路径：' + relative);
    if (item.isDirectory()) walk(full);
  }
}
walk(runtime);
for (const file of ['node.exe', 'LICENSE.node.txt', 'hub/server.mjs', 'hub/web/index.html']) if (!fs.existsSync(path.join(runtime, file))) throw new Error('安装包缺少运行文件：' + file);
const current = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const bundled = JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'), 'utf8'));
if (JSON.stringify(current.dependencies) !== JSON.stringify(bundled.dependencies)) throw new Error('安装包依赖已过时，请刷新 staging 后重新构建。');
for(const name of Object.keys(bundled.dependencies))if(!fs.existsSync(path.join(runtime,'node_modules',name,'package.json')))throw new Error('安装包缺少生产依赖：'+name+'；不能从源码工作区借用模块。');
function compareSource(directory, relative = '') {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const name = path.join(relative, item.name), source = path.join(directory, item.name);
    if (item.isDirectory()) compareSource(source, name);
    else {
      const destination = path.join(runtime, 'hub', name);
      if (!fs.existsSync(destination)) throw new Error('安装包缺少最新源码：hub/' + name);
      const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      if (digest(source) !== digest(destination)) throw new Error('安装包源码已过时：hub/' + name);
    }
  }
}
compareSource(path.join(root, 'hub'));
if (!fs.readFileSync(path.join(root,'feishu-notify.js')).equals(fs.readFileSync(path.join(runtime,'feishu-notify.js')))) throw new Error('安装包通知脚本已过时。');
const appArchive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
for (const file of ['main.cjs', 'preload.cjs', 'assets/icon.png']) {
  const source = fs.readFileSync(path.join(root, 'desktop', file));
  if (!source.equals(asar.extractFile(appArchive, file))) throw new Error('桌面程序已过时：' + file);
}
const smoke = spawnSync(path.join(runtime, 'node.exe'), ['--input-type=module', '-e', "const metadata=await import('./package.json',{with:{type:'json'}});for(const name of Object.keys(metadata.default.dependencies))await import(name);console.log('Bundled Node '+process.version+' and all production modules OK');"], { cwd: runtime, encoding: 'utf8', windowsHide: true });
if (smoke.status !== 0) throw new Error(smoke.stderr || '安装包生产模块加载失败。');
console.log(smoke.stdout.trim());
if (bundled.dependencies['@anthropic-ai/claude-agent-sdk']) {
  const executable = path.join(runtime, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe');
  const cli = spawnSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (cli.status !== 0) throw new Error(cli.stderr || '内置 Claude 引擎无法启动。');
  console.log('Bundled Claude engine ' + cli.stdout.trim());
}
const packages = fs.readdirSync(path.join(root, 'dist')).filter(name => /\.(exe|zip)$/.test(name));
if (!packages.some(name => /Setup.*\.exe$/.test(name)) || !packages.some(name => /\.zip$/.test(name))) throw new Error('缺少 NSIS 安装包或 ZIP 便携包。');
const criticalFiles=['resources/app.asar','resources/runtime/feishu-notify.js','resources/runtime/package.json'];
function collectHub(directory,relative='') {
  for(const item of fs.readdirSync(directory,{withFileTypes:true})) {
    const filename=path.join(relative,item.name),full=path.join(directory,item.name);
    if(item.isDirectory())collectHub(full,filename);else criticalFiles.push('resources/runtime/hub/'+filename.replace(/\\/g,'/'));
  }
}
collectHub(path.join(root,'hub'));
const checksums=[];
for (const name of packages) {
  const archive=path.join(root,'dist',name);
  const listing=spawnSync(sevenZip.path7za,['l',archive,'-slt'],{encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024});
  if(listing.status!==0)throw new Error('安装包无法读取：'+name);
  const filenames=[...listing.stdout.matchAll(/^Path = (.+)$/gm)].map(m=>m[1].trim());
  for(const file of filenames)if(forbidden.test(file))throw new Error('发行包包含用户数据：'+file);
  for(const file of criticalFiles) {
    const item=filenames.find(f=>f.replace(/\\/g,'/')===file);if(!item)throw new Error(name+' 缺少 '+file);
    const extraction=spawnSync(sevenZip.path7za,['e',archive,item,'-so','-bsp0'],{windowsHide:true,maxBuffer:16*1024*1024});
    if(extraction.status!==0 || !extraction.stdout.equals(fs.readFileSync(path.join(root,'dist','win-unpacked',file))))throw new Error(name+' 内容已过时：'+file);
  }
  console.log(`${name}: ${(fs.statSync(archive).size / 1048576).toFixed(1)} MB; Hub、通知脚本与桌面入口一致`);
  const checksum=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');checksums.push(`${checksum}  ${name}`);console.log('SHA256 '+checksum);
}
fs.writeFileSync(path.join(root,'dist','SHA256SUMS.txt'),checksums.join('\n')+'\n');
