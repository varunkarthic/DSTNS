# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

"""Exercise both public launchers, stale output rebuilding, old-server avoidance and OSM startup."""
import http.server,json,os,pathlib,socket,subprocess,tempfile,threading,time,unittest,urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[2]
def read(port,route='/health'):
 with urllib.request.urlopen(f'http://127.0.0.1:{port}{route}',timeout=3) as response:return json.load(response)
class OldServer(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"ok":true,"service":"dstns","lifecycle":"IDLE"}')
 def log_message(self,*args):pass
class LauncherIntegration(unittest.TestCase):
 def test_wrappers_rebuild_and_use_real_map_away_from_old_server(self):
  with tempfile.TemporaryDirectory(prefix='dstns-launcher-') as tmp:
   legacy=http.server.ThreadingHTTPServer(('127.0.0.1',0),OldServer);threading.Thread(target=legacy.serve_forever,daemon=True).start()
   env={**os.environ,'DSTNS_API_PORT':str(legacy.server_port),'DSTNS_LOGS_DIR':tmp,'DSTNS_SEED_DB':str(pathlib.Path(tmp)/'seeds.db')}
   # Simulate stale UI output without modifying any source or user configuration.
   stamp=ROOT/'ui-engine/dist/.launcher-source';previous=stamp.read_bytes() if stamp.exists() else None;stamp.write_text('stale-before-test')
   child=None
   with open(pathlib.Path(tmp)/'launcher.log','w+') as log:
    try:
     child=subprocess.Popen([str(ROOT/'launcher'),'--no-open','--seed','382923','--osm-file',str(ROOT/'data/fixtures/real_network.osm.xml')],cwd=tmp,env=env,stdout=log,stderr=subprocess.STDOUT)
     deadline=time.monotonic()+90;port=None
     while time.monotonic()<deadline:
      if child.poll() is not None:
       log.seek(0);self.fail(log.read())
      try:
       port=json.loads((pathlib.Path(tmp)/'launcher.json').read_text())['port']
       if read(port,'/api/v1/playback/status')['data']['lifecycle']=='RUNNING':break
      except (OSError,ValueError,KeyError):pass
      time.sleep(.2)
     else:self.fail('launcher did not reach RUNNING')
     self.assertNotEqual(port,legacy.server_port);self.assertEqual(read(port)['observer_ui_version'],'observer-v2')
     self.assertNotEqual(stamp.read_text(),'stale-before-test','stale UI must actually rebuild')
     topology=read(port,'/api/v1/view/topology')['data'];self.assertEqual(topology['source'],'OpenStreetMap');self.assertGreater(len(topology['nodes']),1000);self.assertGreater(len(topology['features']),1000)
     self.assertTrue(any(n['osm_node_id']>0 for n in topology['nodes']));self.assertGreater(topology['bounds']['min_lat'],40)
     # The Python entry point attaches with the actual selected port, preserving this run.
     run_id=read(port,'/api/v1/playback/status')['run_id'];env['DSTNS_API_PORT']=str(port)
     repeat=subprocess.run(['python3',str(ROOT/'launcher.py'),'--no-open'],cwd=tmp,env=env,capture_output=True,text=True,timeout=20)
     self.assertEqual(repeat.returncode,0,repeat.stdout+repeat.stderr);self.assertEqual(read(port,'/api/v1/playback/status')['run_id'],run_id)
     self.assertEqual(read(legacy.server_port)['lifecycle'],'IDLE')
     print(f'Launchers passed: rebuilt stale UI, avoided old port, real OSM {len(topology["nodes"])} nodes / {len(topology["features"])} features, Python reattach preserves run.')
    finally:
     if child:
      child.terminate()
      try:child.wait(timeout=5)
      except subprocess.TimeoutExpired:child.kill();child.wait()
     legacy.shutdown();legacy.server_close()
     # If the build failed, restore only the stamp that this test changed.
     if stamp.exists() and stamp.read_text()=='stale-before-test':
      if previous is None:stamp.unlink()
      else:stamp.write_bytes(previous)
if __name__=='__main__':unittest.main()
