import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'..');
for (const item of ['web/app.js','web/transport.js','sw.js','tools/dev-server.mjs','tools/build.mjs']) execFileSync(process.execPath,['--check',path.join(root,item)]);
for (const item of ['shared/domain.js','gas/Server.gs']) new vm.Script(await readFile(path.join(root,item),'utf8'),{filename:item});
JSON.parse(await readFile(path.join(root,'manifest.webmanifest'),'utf8'));
JSON.parse(await readFile(path.join(root,'gas/appsscript.json'),'utf8'));
const sensitive = /(?:10IGL1Qy5JHe|1XyIsTH8I3g99|1FlQ8y8A7Glg|1IFMXwvLxc9u|1Mcn8Yl3Xoce|1sgRPH8xyLg3|AIza[\w-]{25}|-----BEGIN.*PRIVATE KEY|ya29\.)/;
async function scan(dir) {
 for (const entry of await readdir(path.join(root,dir),{withFileTypes:true})) {
  const name=path.posix.join(dir,entry.name);
  if (entry.isDirectory()) await scan(name);
  else if (name !== 'tools/check.mjs' && /\.(js|mjs|cjs|gs|html|css|md|json|svg|webmanifest)$/.test(name) && sensitive.test(await readFile(path.join(root,name),'utf8'))) throw new Error('Private target/credential in public source: '+name);
 }
}
for (const dir of ['web','shared','gas','docs','tools','tests','assets']) await scan(dir);
for (const file of ['index.html','README.md','manifest.webmanifest','package.json','sw.js']) {
 if (sensitive.test(await readFile(path.join(root,file),'utf8'))) throw new Error('Private target/credential in public source: '+file);
}
console.log('Syntax, manifests, and private target/credential scan passed.');
