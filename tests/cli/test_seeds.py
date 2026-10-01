# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Varun Karthic

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('seeds',ROOT/'dstns-operator-cli/seeds.py')
seeds=importlib.util.module_from_spec(spec);spec.loader.exec_module(seeds)

class Seeds(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.old=os.environ.get('DSTNS_SEED_DB');os.environ['DSTNS_SEED_DB']=str(Path(self.tmp.name)/'seeds.sqlite3')
  self.cfg={'seed':'0x00000000000000000000000000000042','day':0,'map_selection_version':seeds.VERSION,'map':{'osm_file':str(ROOT/'tests/fixtures/roads.osm.xml'),'max_nodes':50},'tick_rate':1,'playback_duration_seconds':3600}
 def tearDown(self):
  if self.old is None:os.environ.pop('DSTNS_SEED_DB',None)
  else:os.environ['DSTNS_SEED_DB']=self.old
  self.tmp.cleanup()
 def test_roundtrip(self):
  saved=seeds.operate('save',{'id':'campus-test','config':self.cfg,'description':'Repeatable run'})
  self.assertEqual(seeds.operate('use',{'id':'campus-test'})['config'],saved['config'])
  self.assertEqual(len(seeds.operate('list',{})),1)
  self.assertEqual(seeds.operate('inspect',{'id':'campus-test'})['description'],'Repeatable run')
  self.assertNotEqual(saved['config']['map']['osm_file'],str(ROOT/'tests/fixtures/roads.osm.xml'))
  with self.assertRaisesRegex(ValueError,'already exists'):seeds.operate('save',{'id':'campus-test','config':self.cfg})
  self.assertEqual(seeds.operate('delete',{'id':'campus-test'}),{'deleted':'campus-test'})
  with self.assertRaisesRegex(ValueError,'Unknown'):seeds.operate('use',{'id':'campus-test'})
 def test_invalid_ids(self):
  for value in ['../bad','bad/name','','bad name','a'*65,None]:
   with self.assertRaises(ValueError):seeds.operate('save',{'id':value,'config':self.cfg})
 def test_map_integrity(self):
  saved=seeds.operate('save',{'id':'pinned','config':self.cfg})
  Path(saved['config']['map']['osm_file']).write_text('<osm/>')
  with self.assertRaisesRegex(ValueError,'changed'):seeds.operate('use',{'id':'pinned'})
 def test_seed_selected_map(self):
  cfg=dict(self.cfg,map={'osm_file':'auto','max_nodes':50000})
  saved=seeds.operate('save',{'id':'city-seed','config':cfg})
  self.assertEqual(saved['map_sha256'],seeds.AUTO_MAP)
  self.assertEqual(seeds.operate('use',{'id':'city-seed'})['config']['map']['osm_file'],'auto')
  self.assertFalse((Path(self.tmp.name)/'maps').exists())
 def test_cli_validation(self):
  for args,message in [(['start','--day-type','holiday'],'weekday or weekend'),(['start','--seed','-4'],'decimal integer'),(['start','--speed','nan'],'must be'),(['start','--duration','9999'],'must be'),(['start','--seed','42','--saved-seed','x'],'mutually exclusive'),(['start','--nonsense'],'Unknown option'),(['start','--saved-seed','missing'],'Unknown saved seed')]:
   r=subprocess.run(['node',str(ROOT/'dstns-operator-cli/dstns.mjs'),*args],capture_output=True,text=True,cwd=ROOT)
   self.assertNotEqual(r.returncode,0,r.stdout);self.assertIn(message,r.stdout+r.stderr)
 def test_cli_save_weekend(self):
  args=['node',str(ROOT/'dstns-operator-cli/dstns.mjs'),'seeds','save','weekend-test','--seed','382923','--day-type','weekend','--osm-file','tests/fixtures/roads.osm.xml']
  r=subprocess.run(args,capture_output=True,text=True,cwd=ROOT);self.assertEqual(r.returncode,0,r.stdout+r.stderr)
  cfg=seeds.operate('use',{'id':'weekend-test'})['config'];self.assertEqual(cfg['day'],1);# The stored seed is the number the operator typed, not a hash of it.
  self.assertEqual(cfg['seed'],'382923')
if __name__=='__main__':unittest.main()
