// Native ConPTY calls can block while Windows closes the pseudo console. Keep
// that native lifecycle in an owned process so it cannot block the Hub.
import spawn from 'cross-spawn';
import * as pty from 'node-pty';

let terminal;
let starting = false;
function send(value) { if (process.connected) process.send(value); }
process.on('message', message => {
  if (message?.type === 'start' && !starting) {
    starting = true;
    try {
      const parsed = spawn._parse(message.command, message.args || [], {cwd:message.cwd, env:message.env});
      const args = parsed.options.windowsVerbatimArguments ? parsed.args.join(' ') : parsed.args;
      terminal = pty.spawn(parsed.command, args, {cwd:message.cwd, env:message.env, name:'xterm-256color',cols:100,rows:30,useConpty:true});
      terminal.onData(text => send({type:'data',text}));
      terminal.onExit(event => {
        // The OS releases native pipe handles and worker threads on host exit.
        // Flush the final exit event before ending this owned process.
        if (!process.connected) process.exit(0);
        process.send({type:'exit',event}, () => process.exit(0));
      });
      send({type:'ready',pid:terminal.pid});
    } catch (error) { send({type:'failed',message:error.message}); process.exitCode=1; setImmediate(()=>process.exit(1)); }
  } else if (message?.type === 'input' && terminal) {
    try { terminal.write(message.text); } catch (error) {send({type:'failed',message:error.message});}
  }
});
// Losing the Hub must also end its owned native agent tree.
process.on('disconnect', () => {
  if (process.platform === 'win32' && terminal?.pid) {
    const killer = spawn('taskkill.exe',['/PID',String(terminal.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    killer.once('close',()=>process.exit(0)); killer.once('error',()=>process.exit(1));
    setTimeout(()=>process.exit(1),3000).unref();
  } else { try {terminal?.kill();} finally {process.exit(0);} }
});
