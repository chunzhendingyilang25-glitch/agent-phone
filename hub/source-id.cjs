const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');

// Identify loaded application code across source and installed checkouts.
// Absolute installation/user paths and user data are excluded from the ID.
function getSourceId(directory = __dirname) {
  const hash=createHash('sha256');
  function walk(current,relative='') {
    for(const entry of fs.readdirSync(current,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
      const name=path.posix.join(relative,entry.name),full=path.join(current,entry.name);
      if(entry.isDirectory())walk(full,name);
      else if(entry.isFile())hash.update(name+'\0').update(fs.readFileSync(full)).update('\0');
    }
  }
  walk(directory);
  const notifier=path.join(directory,'..','feishu-notify.js');
  if(fs.existsSync(notifier))hash.update('feishu-notify.js\0').update(fs.readFileSync(notifier));
  return hash.digest('hex');
}
module.exports={getSourceId};
