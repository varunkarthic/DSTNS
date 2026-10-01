import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
const dir = process.argv[2]; const only = process.argv[3];
const b = await chromium.launch({channel:'chrome'}); const p = await b.newPage({viewport:{width:1400,height:900}, deviceScaleFactor:1});
for (const f of readdirSync(dir).filter(f=>f.endsWith('.svg') && (!only || f.includes(only)))) {
  await p.goto('file://'+dir+'/'+f); const el = await p.$('svg');
  await el.screenshot({path: dir+'/'+f.replace('.svg','.png')});
}
await b.close();
