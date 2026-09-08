const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const {dataDirectoryFor,prepareDataDirectory,cleanupLegacyData,initializePortableData}=require('../electron/portable-data.cjs')
const testRoot=path.resolve('.artifacts/portable-data-tests');fs.mkdirSync(testRoot,{recursive:true})
function fixture(t){
  const root=fs.mkdtempSync(path.join(testRoot,'case-')),source=path.join(root,'legacy/eDesktop'),destination=path.join(root,'software/data')
  t.after(()=>{assert.ok(root.startsWith(testRoot+path.sep));fs.rmSync(root,{recursive:true,force:true})})
  const write=(relative,contents)=>{const file=path.join(source,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,contents);return file}
  write('desktop-workspace.json',JSON.stringify({widgets:[{kind:'todo',data:{items:[{text:'喝水',list:'temporary'}]}}]}))
  write('desktop-pet/state.json',JSON.stringify({model:'fixture',messages:[{role:'user',content:'你好小栖'}]}))
  write('desktop-pet/speech/sensevoice/model.int8.onnx',Buffer.alloc(128*1024,0x42))
  write('Local Storage/leveldb/cache.bin',Buffer.from([0,255,45]))
  return {root,source,destination,write}
}
function fakeApp(source,exePath,locks=[true,true]){
  const paths={appData:path.dirname(source),exe:exePath},events=[]
  return {isPackaged:true,paths,events,getPath:key=>paths[key],setPath:(key,value)=>{paths[key]=value;events.push(['path',key,value])},setAppLogsPath:value=>{paths.logs=value},requestSingleInstanceLock:()=>{events.push(['lock',paths.userData]);return locks.shift()??true},releaseSingleInstanceLock:()=>events.push(['unlock'])}
}
test('packaged data follows executable folder; source runs and explicit test overrides remain isolated',()=>{
  const root=path.resolve('.artifacts/location-test')
  assert.equal(dataDirectoryFor({isPackaged:true,exePath:path.join(root,'app/eDesktop.exe'),projectRoot:root}),path.join(root,'app/data'))
  assert.equal(dataDirectoryFor({isPackaged:false,exePath:path.join(root,'node_modules/electron.exe'),projectRoot:root}),path.join(root,'data'))
  assert.equal(dataDirectoryFor({isPackaged:true,exePath:'ignored',override:path.join(root,'test')}),path.join(root,'test'))
})
test('migration preserves todo, history, binary model and cache; cleanup frees only verified old data',t=>{
  const f=fixture(t);f.write('lockfile','old lock')
  assert.equal(prepareDataDirectory(f).migrated,true)
  for(const file of ['desktop-workspace.json','desktop-pet/state.json','desktop-pet/speech/sensevoice/model.int8.onnx','Local Storage/leveldb/cache.bin'])assert.deepEqual(fs.readFileSync(path.join(f.source,file)),fs.readFileSync(path.join(f.destination,file)))
  assert.equal(fs.existsSync(path.join(f.destination,'lockfile')),false)
  assert.equal(cleanupLegacyData(f),true);assert.equal(fs.existsSync(f.source),false)
  assert.equal(prepareDataDirectory(f).migrated,false)
})
test('copy failure leaves the complete legacy profile and no usable partial destination; retry succeeds',t=>{
  const f=fixture(t);let copied=0
  assert.throws(()=>prepareDataDirectory({...f,copyFile:(from,to)=>{if(++copied===2)throw Error('disk full');fs.copyFileSync(from,to)}}),/disk full/)
  assert.equal(fs.existsSync(f.destination),false);assert.ok(fs.existsSync(path.join(f.source,'desktop-workspace.json')))
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)),[])
  assert.equal(prepareDataDirectory(f).migrated,true)
})
test('a corrupt copy cannot commit or delete the original model',t=>{
  const f=fixture(t)
  assert.throws(()=>prepareDataDirectory({...f,copyFile:(_from,to)=>fs.writeFileSync(to,'bad')}),/校验/)
  assert.equal(fs.existsSync(f.destination),false);assert.ok(fs.existsSync(path.join(f.source,'desktop-pet/speech/sensevoice/model.int8.onnx')))
})
test('existing portable profile wins over old roaming data and follows a moved software folder',t=>{
  const f=fixture(t);prepareDataDirectory(f)
  fs.writeFileSync(path.join(f.destination,'desktop-workspace.json'),'newer portable data')
  f.write('desktop-workspace.json','old installation changed')
  assert.equal(prepareDataDirectory(f).migrated,false);assert.equal(fs.readFileSync(path.join(f.destination,'desktop-workspace.json'),'utf8'),'newer portable data')
  const moved=path.join(f.root,'moved-software');assert.ok(moved.startsWith(f.root+path.sep));fs.renameSync(path.dirname(f.destination),moved)
  assert.equal(prepareDataDirectory({source:f.source,destination:path.join(moved,'data')}).migrated,false)
  assert.ok(fs.existsSync(path.join(moved,'data/desktop-pet/speech/sensevoice/model.int8.onnx')))
})
test('cleanup can resume and retains source files edited since migration or newly created',t=>{
  const f=fixture(t);prepareDataDirectory(f)
  fs.unlinkSync(path.join(f.source,'desktop-pet/state.json'))
  f.write('desktop-workspace.json','modified after copy');f.write('new.txt','new data')
  assert.equal(cleanupLegacyData(f),false)
  assert.equal(fs.readFileSync(path.join(f.source,'desktop-workspace.json'),'utf8'),'modified after copy')
  assert.equal(fs.readFileSync(path.join(f.source,'new.txt'),'utf8'),'new data')
  assert.equal(fs.existsSync(path.join(f.source,'desktop-pet/speech/sensevoice/model.int8.onnx')),false)
})
test('overlapping paths and populated unknown destination never overwrite user files',t=>{
  const f=fixture(t)
  assert.throws(()=>prepareDataDirectory({source:f.source,destination:path.join(f.source,'data')}),/重叠/)
  fs.mkdirSync(f.destination,{recursive:true});fs.writeFileSync(path.join(f.destination,'personal.txt'),'keep')
  assert.throws(()=>prepareDataDirectory(f),/已有文件/);assert.equal(fs.readFileSync(path.join(f.destination,'personal.txt'),'utf8'),'keep')
})
test('a running legacy instance prevents migration; all future Electron storage paths use the portable folder',t=>{
  const f=fixture(t),app=fakeApp(f.source,path.join(f.root,'software/eDesktop.exe'),[false])
  assert.equal(initializePortableData(app,{projectRoot:f.root}),false);assert.equal(fs.existsSync(f.destination),false)
  const next=fakeApp(f.source,path.join(f.root,'software/eDesktop.exe'))
  assert.equal(initializePortableData(next,{projectRoot:f.root}),true)
  assert.equal(next.paths.userData,f.destination);assert.equal(next.paths.sessionData,f.destination)
  assert.equal(next.paths.logs,path.join(f.destination,'logs'));assert.equal(next.paths.crashDumps,path.join(f.destination,'crashDumps'))
  assert.equal(fs.existsSync(f.source),false);assert.deepEqual(next.events.filter(event=>event[0]==='lock').map(event=>event[1]),[f.source,f.destination])
})
test('test override never migrates the real profile or silently falls back to roaming',t=>{
  const f=fixture(t),app=fakeApp(f.source,path.join(f.root,'software/eDesktop.exe'))
  const override=path.join(f.root,'isolated-test')
  assert.equal(initializePortableData(app,{projectRoot:f.root,override,enforceSingleInstance:false}),true)
  assert.equal(app.paths.userData,override);assert.ok(fs.existsSync(path.join(f.source,'desktop-workspace.json')))
  const blocked=path.join(f.root,'not-a-directory');fs.writeFileSync(blocked,'keep')
  assert.throws(()=>initializePortableData(app,{projectRoot:f.root,override:blocked}))
  assert.equal(app.paths.userData,override)
})
