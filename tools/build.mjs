import {cp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname,'..');
const dist = path.join(root,'dist');
await mkdir(dist,{recursive:true});
const shell = ['index.html','manifest.webmanifest','sw.js','web','shared','assets'];
for (const item of shell) await cp(path.join(root,item),path.join(dist,item),{recursive:true});
// Runtime configuration is optional until the separate release approval.
await rm(path.join(dist,'runtime-config.json'),{force:true});
try { await cp(path.join(root,'.local','runtime-config.json'),path.join(dist,'runtime-config.json')); }
catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
const gas = path.join(root,'.local','gas-build');
await mkdir(gas,{recursive:true});
for (const item of ['Server.gs','Bridge.html','appsscript.json']) await cp(path.join(root,'gas',item),path.join(gas,item));
await writeFile(path.join(gas,'Domain.gs'),await readFile(path.join(root,'shared','domain.js')));
console.log('Built dist/ and .local/gas-build/; no publication or cloud writes.');
