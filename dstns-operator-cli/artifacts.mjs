// Content fingerprints detect stale native/UI output without rebuilding on every launch.
import {createHash} from 'node:crypto';
import {readdir,readFile,stat} from 'node:fs/promises';
import path from 'node:path';
export async function sourceFingerprint(root, inputs) {
  const hash=createHash('sha256');
  async function add(relative) {
    const file=path.join(root,relative);
    let info;try{info=await stat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(info.isDirectory()) {
      for(const name of (await readdir(file)).sort())await add(path.join(relative,name));
    } else if(info.isFile()) {hash.update(relative);hash.update('\0');hash.update(await readFile(file));}
  }
  for(const input of inputs)await add(input);
  return hash.digest('hex');
}
export async function needsBuild(root,inputs,output,stamp) {
  const fingerprint=await sourceFingerprint(root,inputs);
  const previous=await readFile(stamp,'utf8').catch(()=>null);
  const exists=await stat(output).then(()=>true).catch(()=>false);
  return {fingerprint,needed:!exists||previous!==fingerprint};
}
