import { spawn } from 'child_process'
import type { FileIdentity } from './fileStorageService'
import { startPerformanceSpan } from '../shared/performanceDiagnostics'

// File handles retain DELETE access and deny other writers/deleters throughout validation and rename.
const HANDLE_SCRIPT = `
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class ProtectedFiles {
 [StructLayout(LayoutKind.Sequential)] struct Info {public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME creation,access,write; public uint volume,high,low,links,indexHigh,indexLow;}
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string p,uint a,uint s,IntPtr sec,uint disp,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle h,int cls,IntPtr info,uint size);
 static void Error(){throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());}
 static SafeFileHandle Open(string p){var h=CreateFile(p,0x80010000,1,IntPtr.Zero,3,0x00200080,IntPtr.Zero);if(h.IsInvalid)Error();return h;}
 static void Check(SafeFileHandle h,string dev,string ino,long size,string hash){
  Info i;if(!GetFileInformationByHandle(h,out i))Error();if((i.attributes & 0x410)!=0)throw new IOException("Not a regular non-link file");
  ulong id=((ulong)i.indexHigh<<32)|i.indexLow;ulong length=((ulong)i.high<<32)|i.low;
  if(i.volume.ToString()!=dev||id.ToString()!=ino||(ulong)size!=length)throw new IOException("Source identity changed");
  using(var stream=new FileStream(h,FileAccess.Read)){using(var sha=SHA256.Create()){string actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();if(actual!=hash)throw new IOException("Source content changed");}}
 }
 // FileStream owns its handle, so validated operations use a duplicate non-owning wrapper.
 static void Validate(SafeFileHandle h,string dev,string ino,long size,string hash){
  Info i;if(!GetFileInformationByHandle(h,out i))Error();if((i.attributes & 0x410)!=0)throw new IOException("Not a regular non-link file");
  ulong id=((ulong)i.indexHigh<<32)|i.indexLow;ulong length=((ulong)i.high<<32)|i.low;
  if(i.volume.ToString()!=dev||id.ToString()!=ino||(ulong)size!=length)throw new IOException("Source identity changed");
  using(var borrowed=new SafeFileHandle(h.DangerousGetHandle(),false)){using(var stream=new FileStream(borrowed,FileAccess.Read)){using(var sha=SHA256.Create()){string actual=BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant();if(actual!=hash)throw new IOException("Source content changed");}}}
 }
 static void Rename(SafeFileHandle h,string target){
  byte[] name=Encoding.Unicode.GetBytes(Path.GetFullPath(target));int root=IntPtr.Size;int length=root+IntPtr.Size;int start=length+4;int total=start+name.Length+2;
  IntPtr data=Marshal.AllocHGlobal(total);try{for(int n=0;n<total;n++)Marshal.WriteByte(data,n,0);Marshal.WriteIntPtr(data,root,IntPtr.Zero);Marshal.WriteInt32(data,length,name.Length);Marshal.Copy(name,0,IntPtr.Add(data,start),name.Length);if(!SetFileInformationByHandle(h,3,data,(uint)total))Error();}finally{Marshal.FreeHGlobal(data);}
 }
 public static void Move(string source,string target,string dev,string ino,long size,string hash){
  if(!String.Equals(Path.GetDirectoryName(Path.GetFullPath(source)),Path.GetDirectoryName(Path.GetFullPath(target)),StringComparison.OrdinalIgnoreCase))throw new IOException("Same directory required");
  using(var h=Open(source)){Validate(h,dev,ino,size,hash);Rename(h,target);}
 }
 public static void Replace(string source,string stage,string backup,string dev,string ino,long size,string hash,string stageDev,string stageIno,long stageSize,string stageHash){
  using(var old=Open(source)){using(var next=Open(stage)){Validate(old,dev,ino,size,hash);Validate(next,stageDev,stageIno,stageSize,stageHash);Rename(old,backup);try{Rename(next,source);}catch{try{Rename(old,source);}catch{}throw;}}}
 }
 public static void Delete(string source,string dev,string ino,long size,string hash){using(var h=Open(source)){Validate(h,dev,ino,size,hash);IntPtr data=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(data,0,1);if(!SetFileInformationByHandle(h,4,data,1))Error();}finally{Marshal.FreeHGlobal(data);}}}
}
'@
try {
 $r=[Console]::In.ReadToEnd()|ConvertFrom-Json
 if($r.action -eq 'move'){[ProtectedFiles]::Move($r.source,$r.target,$r.identity.dev,$r.identity.ino,$r.identity.size,$r.sha256)}
 elseif($r.action -eq 'replace'){[ProtectedFiles]::Replace($r.source,$r.stage,$r.backup,$r.identity.dev,$r.identity.ino,$r.identity.size,$r.sha256,$r.stageIdentity.dev,$r.stageIdentity.ino,$r.stageIdentity.size,$r.stageHash)}
 elseif($r.action -eq 'delete'){[ProtectedFiles]::Delete($r.source,$r.identity.dev,$r.identity.ino,$r.identity.size,$r.sha256)}
 else{throw 'Unsupported protected file operation'}
 [Console]::Out.Write('{"ok":true}')
}catch{[Console]::Out.Write((@{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress));exit 1}
`

export async function protectedWindowsFileOperation(request: { action: 'move' | 'replace' | 'delete'; source: string; identity: FileIdentity; sha256: string; target?: string; stage?: string; backup?: string; stageIdentity?: FileIdentity; stageHash?: string }): Promise<void> {
  if (process.platform !== 'win32') throw new Error('No verified protected file adapter for this platform')
  const span = startPerformanceSpan('native.windows-operation')
  let successful = false
  try {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(HANDLE_SCRIPT, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.on('data', (data: Buffer) => { output += data.toString('utf8') })
    child.stderr.on('data', (data: Buffer) => { error += data.toString('utf8') })
    child.on('error', reject)
    child.stdin.on('error', (inputError) => { error = inputError.message })
    child.on('close', (code) => { try { const value = JSON.parse(output) as { ok: boolean; error?: string }; if (!code && value.ok) resolve(); else reject(new Error(value.error || error)) } catch { reject(new Error(error || output || 'Protected file operation failed')) } })
    child.stdin.end(JSON.stringify(request))
  })
  successful = true
  } finally { span.finish(successful ? 'success' : 'error') }
}
