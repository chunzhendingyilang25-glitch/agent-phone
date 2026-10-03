import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sevenZip from '7zip-bin';
import './create-icons.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('目前安装包仅支持 Windows x64。');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.cache', 'package-downloads');
const stage = path.join(root, '.cache', 'package-runtime');
const version = process.env.AGENT_PHONE_NODE_VERSION || '24.16.0';
if (!/^24\.\d+\.\d+$/.test(version)) throw new Error('打包要求 Node.js 24 LTS。');
const archiveName = `node-v${version}-win-x64.zip`;
fs.mkdirSync(cache, { recursive: true });

async function download(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(target + '.tmp', bytes); fs.renameSync(target + '.tmp', target);
}
const checksums = path.join(cache, `node-v${version}-SHASUMS256.txt`);
const archive = path.join(cache, archiveName);
if (!fs.existsSync(checksums)) await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, checksums);
const expected = fs.readFileSync(checksums, 'utf8').split(/\r?\n/).find(line => line.endsWith('  ' + archiveName))?.split('  ')[0];
if (!expected) throw new Error('官方校验表未包含 Windows Node 运行环境。');
if (!fs.existsSync(archive)) await download(`https://nodejs.org/dist/v${version}/${archiveName}`, archive);
const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (actual !== expected) { fs.unlinkSync(archive); throw new Error('Node 运行环境校验失败，请重新构建。'); }
// Use Electron's checksums shipped in its official npm package. Supplying
// the verified archive explicitly avoids another remote checksum request
// on every build, which can hang behind a restricted network/proxy.
const electronPackage=JSON.parse(fs.readFileSync(path.join(root,'node_modules','electron','package.json'),'utf8'));
const electronName=`electron-v${electronPackage.version}-win32-x64.zip`;
const electronChecksum=JSON.parse(fs.readFileSync(path.join(root,'node_modules','electron','checksums.json'),'utf8'))[electronName];
if(!electronChecksum)throw new Error('官方 Electron 包缺少 Windows x64 校验值。');
const electronArchive=path.join(cache,electronName);
if(!fs.existsSync(electronArchive)) {
  const electronCache=path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE,'AppData','Local'),'electron','Cache');
  if(fs.existsSync(electronCache))for(const entry of fs.readdirSync(electronCache,{withFileTypes:true})) {
    const cached=path.join(electronCache,entry.name,electronName);
    if(entry.isDirectory() && fs.existsSync(cached) && crypto.createHash('sha256').update(fs.readFileSync(cached)).digest('hex')===electronChecksum){fs.copyFileSync(cached,electronArchive);break;}
  }
  if(!fs.existsSync(electronArchive))await download(`https://github.com/electron/electron/releases/download/v${electronPackage.version}/${electronName}`,electronArchive);
}
if(crypto.createHash('sha256').update(fs.readFileSync(electronArchive)).digest('hex')!==electronChecksum){fs.unlinkSync(electronArchive);throw new Error('Electron 运行环境校验失败，请重新构建。');}
const developmentElectron=path.join(root,'node_modules','electron','dist');
let developmentVersion='';try{developmentVersion=fs.readFileSync(path.join(developmentElectron,'version'),'utf8').trim().replace(/^v/,'');}catch{}
if(developmentVersion!==electronPackage.version || !fs.existsSync(path.join(developmentElectron,'electron.exe'))) {
  if(path.resolve(developmentElectron)!==path.join(root,'node_modules','electron','dist'))throw new Error('Electron 开发目录不在当前项目中。');
  fs.rmSync(developmentElectron,{recursive:true,force:true});
  const extraction=spawnSync(sevenZip.path7za,['x',electronArchive,'-o'+developmentElectron,'-y','-bd','-bso0'],{windowsHide:true,stdio:'inherit'});
  if(extraction.status!==0)throw new Error('无法解压 Electron 开发运行环境。');
}
fs.writeFileSync(path.join(root,'node_modules','electron','path.txt'),'electron.exe');
const unpack = path.join(cache, `node-v${version}`);
if (!fs.existsSync(path.join(unpack, `node-v${version}-win-x64`, 'node.exe'))) {
  const extraction = spawnSync(sevenZip.path7za, ['x', archive, '-o' + unpack, '-y', '-bd', '-bso0'], { windowsHide: true, stdio: 'inherit' });
  if (extraction.status !== 0) throw new Error('无法解压 Node 运行环境。');
}
const nodeRoot = path.join(unpack, `node-v${version}-win-x64`);
// A new package must not retain files removed from the source or a previous
// dependency tree. Verify the exact workspace-owned staging path first.
if (path.resolve(stage) !== path.join(root, '.cache', 'package-runtime')) throw new Error('打包暂存目录不在当前项目中。');
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
for (const item of ['node.exe', 'LICENSE']) fs.copyFileSync(path.join(nodeRoot, item), path.join(stage, item === 'LICENSE' ? 'LICENSE.node.txt' : item));
fs.cpSync(path.join(root, 'hub'), path.join(stage, 'hub'), { recursive: true });
fs.copyFileSync(path.join(root, 'feishu-notify.js'), path.join(stage, 'feishu-notify.js'));
const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const production = { name: metadata.name, version: metadata.version, private: true, dependencies: metadata.dependencies, engines: { node: '>=24' } };
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(production, null, 2) + '\n');
fs.copyFileSync(path.join(root, 'package-lock.json'), path.join(stage, 'package-lock.json'));
const npmScript = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!fs.existsSync(npmScript)) throw new Error('构建环境需要 npm；下载后的应用不需要 npm。');
const install = spawnSync(process.execPath, [npmScript, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, windowsHide: true, stdio: 'inherit' });
if (install.status !== 0) throw new Error('生产依赖安装失败。');
fs.writeFileSync(path.join(stage, 'build-info.json'), JSON.stringify({ version: metadata.version, node: version, platform: 'win32-x64', createdAt: new Date().toISOString(), dependencies: metadata.dependencies }, null, 2));
console.log('独立运行环境已准备：仅 Hub 源码、Node 与生产依赖，不包含用户数据。');
