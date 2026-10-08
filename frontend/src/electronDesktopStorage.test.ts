import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

describe.runIf(process.platform === 'win32')('isolated actual Electron preload/filesystem smoke', () => {
  it('records, names, saves, migrates and renames an original without using the real profile', async () => {
    const workspace = path.resolve(__dirname, '..', '..')
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-desktop-smoke-'))
    const executable = path.join(workspace, 'node_modules', 'electron', 'dist', 'electron.exe')
    const entry = path.join(root, 'smoke.cjs')
    const script = `
const {app,BrowserWindow,ipcMain,dialog}=require('electron');
const fs=require('fs'); const path=require('path');
fs.mkdirSync(${JSON.stringify(path.join(root, 'profile'))},{recursive:true});app.setPath('userData',${JSON.stringify(path.join(root, 'profile'))});
const docs=${JSON.stringify(path.join(root, 'docs'))}; const target=${JSON.stringify(path.join(root, 'target'))}; const original=${JSON.stringify(path.join(root, '原始 输入.wav'))};
fs.mkdirSync(docs,{recursive:true});fs.mkdirSync(target,{recursive:true});fs.writeFileSync(original,'ORIGINAL DATA');
let chosen=docs;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[chosen]});dialog.showMessageBox=async()=>({response:1});
let saveOptions;dialog.showSaveDialog=async(_window,options)=>{saveOptions=options;return {canceled:false,filePath:options.defaultPath}};
const futureAudio=${JSON.stringify(path.join(root, 'future-audio'))};const futureAudio2=${JSON.stringify(path.join(root, 'future-audio-2'))};fs.mkdirSync(futureAudio);fs.mkdirSync(futureAudio2);
app.whenReady().then(async()=>{try{
 const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(path.join(workspace, 'dist-electron', 'electron', 'preload.js'))},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 win.webContents.on('preload-error',(_e,p,error)=>console.error('PRELOAD_ERROR',p,error));
 win.webContents.on('console-message',(_e,_l,message)=>console.error('RENDERER',message));
 const base=${JSON.stringify(path.join(workspace, 'dist-electron', 'electron'))};
 require(path.join(base,'ipcSecurity')).registerTrustedWindow(()=>win);
 const fileOptions={ipcMain,getMainWindow:()=>win};
 require(path.join(base,'fileStorageIpc')).registerFileStorageIpc(fileOptions);
 require(path.join(base,'manualExportIpc')).registerManualExportIpc(fileOptions);
 require(path.join(base,'originalSourceIpc')).registerOriginalSourceIpc(fileOptions);
 require(path.join(base,'appIpc')).registerAppIpc({...fileOptions,getRecordingState:()=> 'idle',getRuntimeModelCatalog:()=>({whisperModels:[],sherpaModels:[]}),getResolvedRuntimeBaseDir:()=>''});
 const media=require(path.join(base,'mediaIpc')).registerMediaIpc(fileOptions);await media.ready;
 await win.loadURL('data:text/html,<title>Isolated storage smoke</title>');
 const first=await win.webContents.executeJavaScript(
 ' (async()=>{const a=window.electronAPI;const sid="smoke-record";await a.beginRecordingArchive({sessionId:sid,sampleRate:16000,channels:1,bitsPerSample:16});await a.appendRecordingArchive({sessionId:sid,data:new Int16Array([1,2,3]).buffer});const wav=await a.finalizeRecordingArchive({sessionId:sid});const named=await a.registerSessionFiles({sessionId:sid,title:"桌面冒烟",createdAt:1000,titleRevision:1},true);const audio=await a.getMediaAudio(sid);await a.chooseTranscriptDirectory({kind:"default-transcript"});const saved=await a.savePublishedMarkdown({sessionId:sid,publicationId:"pub1",publicationRevision:1,titleRevision:1,content:"# 桌面冒烟  已发布纠错稿"});return {wav,named,audio,saved}})()'
 );
 const manual=await win.webContents.executeJavaScript('(async()=>{const a=window.electronAPI;return a.manualExportFile({filename:"manual-original.txt",content:"EXPLICIT ORIGINAL EXPORT"})})()');
 const manualPath=saveOptions.defaultPath;if(!manual.ok||fs.readFileSync(manualPath,'utf8')!=='EXPLICIT ORIGINAL EXPORT'||path.dirname(manualPath)!==docs)throw new Error('Native manual export default/preload failed');
 chosen=futureAudio;
 const future=await win.webContents.executeJavaScript('(async()=>{const a=window.electronAPI;const changed=await a.chooseMediaDirectory();if(!changed?.ok)throw new Error(changed?.error);const old=await a.getMediaAudio("smoke-record");const sid="smoke-new-record";await a.beginRecordingArchive({sessionId:sid,sampleRate:16000,channels:1,bitsPerSample:16});await a.appendRecordingArchive({sessionId:sid,data:new Int16Array(1600).buffer});const wav=await a.finalizeRecordingArchive({sessionId:sid});return {changed,old,wav}})()');
 chosen=futureAudio2;
 const second=await win.webContents.executeJavaScript('(async()=>{const a=window.electronAPI;const changed=await a.chooseMediaDirectory();if(!changed?.ok)throw new Error(changed?.error);const sid="smoke-newest-record";await a.beginRecordingArchive({sessionId:sid,sampleRate:16000,channels:1,bitsPerSample:16});await a.appendRecordingArchive({sessionId:sid,data:new Int16Array(1600).buffer});const wav=await a.finalizeRecordingArchive({sessionId:sid});const playback=[];for(const id of ["smoke-record","smoke-new-record","smoke-newest-record"]){const read=await a.readMediaAudio(id);if(!read.ok||!read.data)throw new Error(read.error);const url=URL.createObjectURL(new Blob([read.data],{type:read.audio.mimeType}));const audio=new Audio(url);await new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=()=>reject(new Error("audio decode failed: "+id));audio.load()});await audio.play();audio.pause();URL.revokeObjectURL(url);playback.push({id,duration:audio.duration})}return {changed,wav,playback}})()',true);
 if(!future.old.ok||future.old.audio.path!==first.audio.audio.path||future.changed.status.configuration.defaultTranscriptDirectory!==docs)throw new Error('Old audio/export changed during future root selection');
 chosen=target;
 const moved=await win.webContents.executeJavaScript('(async()=>{const a=window.electronAPI;const p=await a.chooseMediaMigration();const r=await a.applyMediaMigration(p.preview.token);const audio=await a.getMediaAudio("smoke-record");return {r,audio,preview:p.preview}})()');
 chosen=original;
 const renamed=await win.webContents.executeJavaScript('(async()=>{const a=window.electronAPI;const p=await a.pickFilePath();const s=await a.registerOriginalSource(p,"smoke-record");const v=await a.previewOriginalRename(s.source.id,"smoke-record");const r=await a.commitOriginalRename(v.preview.token);return {s,v,r}})()');
 console.log('SMOKE_RESULT:'+JSON.stringify({first,future,second,moved,renamed,manual,manualPath}));media.dispose();win.destroy();app.quit();
}catch(e){console.error(e);app.exit(1)}});
`
    await fs.promises.writeFile(entry, script)
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const environment = { ...process.env }
        delete environment.ELECTRON_RUN_AS_NODE
        const child = spawn(executable, [entry], { shell: false, windowsHide: true, env: environment })
        let output = ''
        child.stdout.on('data', (data: Buffer) => { output += data.toString('utf8') })
        child.stderr.on('data', (data: Buffer) => { output += data.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, output }))
      })
      expect(result.code, result.output).toBe(0)
      const line = result.output.split(/\r?\n/).find((value) => value.startsWith('SMOKE_RESULT:'))
      expect(line, result.output).toBeTruthy()
      const value = JSON.parse(line!.slice('SMOKE_RESULT:'.length))
      expect(value.first.wav.ok).toBe(true)
      expect(value.first.audio.audio.fileName).toContain('桌面冒烟')
      expect(value.first.saved.file.status).toBe('saved')
      expect(value.manual.ok).toBe(true)
      expect(path.dirname(value.manualPath)).toBe(path.join(root, 'docs'))
      expect(value.moved.r.ok).toBe(true)
      expect(value.future.changed.ok).toBe(true)
      expect(value.future.wav.path).toContain(path.join(root, 'future-audio', 'DeLive-media'))
      expect(value.second.wav.path).toContain(path.join(root, 'future-audio-2', 'DeLive-media'))
      expect(value.second.playback).toHaveLength(3)
      expect(value.second.playback.every((audio: { duration: number }) => audio.duration > 0)).toBe(true)
      expect(value.moved.preview.sourceRoots).toHaveLength(3)
      expect(value.moved.preview.fileCount).toBe(3)
      expect(value.moved.audio.audio.path).toContain(path.join(root, 'target', 'DeLive-media'))
      expect(value.renamed.r.ok).toBe(true)
      expect(value.renamed.r.source.fileName).toContain('桌面冒烟')
      const originalPath = path.join(root, value.renamed.r.source.fileName)
      expect(await fs.promises.readFile(originalPath, 'utf8')).toBe('ORIGINAL DATA')
    } finally { await fs.promises.rm(root, { recursive: true, force: true }) }
  }, 90000)
})
