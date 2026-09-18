// Attach to an isolated Compose run started through its operator CLI.
import {chromium} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base=process.env.DSTNS_CONTAINER_URL||'http://127.0.0.1:18195';
const dir=new URL('../../artifacts/modernization/container/',import.meta.url).pathname;mkdirSync(dir,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_BIN||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base);await page.getByRole('button',{name:'Pause simulation'}).waitFor();await page.waitForFunction(()=>!document.querySelector('[aria-label="Pause simulation"]').disabled);
 await page.getByRole('button',{name:'Pause simulation'}).click();await page.getByRole('button',{name:'Resume simulation'}).waitFor();
 const read=async()=>await(await fetch(base+'/api/v1/playback/status')).json();const paused=await read();assert.equal(paused.data.day,1);assert.equal(paused.data.saved_seed_id,'compose-demo');
 await page.waitForTimeout(1300);assert.equal((await read()).clock.virtual_day_seconds,paused.clock.virtual_day_seconds);
 const rate=page.getByRole('slider',{name:'Simulation rate multiplier'});await rate.focus();await rate.press('ArrowRight');await page.waitForTimeout(1200);assert.equal((await read()).clock.tick_rate,2);
 await page.getByRole('button',{name:'Resume simulation'}).click();await page.getByRole('button',{name:'Pause simulation'}).waitFor();await page.waitForTimeout(1400);assert.ok((await read()).clock.virtual_day_seconds>paused.clock.virtual_day_seconds);
 await page.getByRole('button',{name:'Pause simulation'}).click();await page.getByRole('button',{name:'Resume simulation'}).waitFor();
 await page.getByRole('tab',{name:/Queue/}).click();await page.getByRole('button',{name:'Upcoming'}).click();await page.waitForFunction(()=>document.querySelectorAll('.event-row').length>0);
 await page.screenshot({path:dir+'observer.png'});
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:/Export Report/}).click();await(await downloadPromise).saveAs(dir+'report.pdf');
 assert.deepEqual(errors,[]);writeFileSync(dir+'result.json',JSON.stringify({passed:true,day:paused.data.day,saved_seed_id:paused.data.saved_seed_id,checks:['pause freeze','resume advance','speed','event queue','PDF download','no page errors']},null,2));
 console.log('Compose browser passed: saved weekend run, pause/resume/speed, event queue, PDF download, no page errors.');
}finally{await browser.close();}
