import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
const source=path.resolve(process.env.SOURCE_ROOT), old=path.resolve(process.env.OLD_ROOT), out=path.resolve(process.env.PROOF_ROOT);
const require=createRequire(path.join(source,'package.json'));
const {build}=require('esbuild');
const startup=fs.readFileSync(path.join(old,'packages/daemon/src/startup.ts'),'utf8');
const list=startup.match(/migrate\(db, \[([^\]]+)\]\)/)[1];
const imports=[...startup.matchAll(/^import \{ ([^}]+) \} from "(\.\/db\/migrations\/[^" ]+)";/gm)];
const chosen=imports.filter(m=>list.split(',').map(s=>s.trim()).includes(m[1]));
if(chosen.length!==list.split(',').length)throw Error('Incomplete historical migration binding');
const base=path.join(old,'packages/daemon/src');
const entry=chosen.map(m=>`import {${m[1]}} from ${JSON.stringify(path.join(base,m[2].replace(/\.js$/,'.ts')))};`).join('\n')+
`\nimport {migrate} from ${JSON.stringify(path.join(base,'db/migrate.ts'))};\nexport {createDb} from ${JSON.stringify(path.join(base,'db/connection.ts'))};\nexport {RigRepository} from ${JSON.stringify(path.join(base,'domain/rig-repository.ts'))};\nexport {SessionRegistry} from ${JSON.stringify(path.join(base,'domain/session-registry.ts'))};\nexport const migrateOld=db=>migrate(db,[${list}]);`;
const entryPath=path.join(out,'historical-entry.ts');fs.writeFileSync(entryPath,entry);
await build({entryPoints:[entryPath],bundle:true,platform:'node',format:'cjs',packages:'external',outfile:path.join(source,`.l1-old-${process.env.LEGACY_VERSION}.cjs`),metafile:true}).then(r=>{
 const files=Object.keys(r.metafile.inputs).sort().map(f=>({path:path.relative(old,path.resolve(f)),sha256:crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}));
 fs.writeFileSync(path.join(out,'historical-source-binding.json'),JSON.stringify({migrationCount:chosen.length,files},null,2));
});
