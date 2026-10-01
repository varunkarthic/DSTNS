// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Varun Karthic

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {needsBuild} from '../../dstns-operator-cli/artifacts.mjs';
test('existing outputs are rebuilt when source content changes, including nested UI files',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'dstns-artifacts-'));
 try{
  await mkdir(path.join(root,'src/components'),{recursive:true});
  const output=path.join(root,'bundle'),stamp=path.join(root,'stamp');
  await writeFile(output,'old bundle');await writeFile(path.join(root,'src/components/Map.tsx'),'old map');
  const first=await needsBuild(root,['src'],output,stamp);assert.equal(first.needed,true);
  await writeFile(stamp,first.fingerprint);assert.equal((await needsBuild(root,['src'],output,stamp)).needed,false);
  await writeFile(path.join(root,'src/components/Map.tsx'),'new real map');assert.equal((await needsBuild(root,['src'],output,stamp)).needed,true);
  await rm(output);assert.equal((await needsBuild(root,['src'],output,stamp)).needed,true);
 }finally{await rm(root,{recursive:true,force:true});}
});
