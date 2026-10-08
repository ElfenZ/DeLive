import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import https from 'https'
import path from 'path'

const RELEASE_TAG = 'b6.1.1'
const RELEASE_BASE_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/${RELEASE_TAG}`
const LICENSE_URL = 'https://raw.githubusercontent.com/FFmpeg/FFmpeg/n6.1.1/COPYING.GPLv3'
const LICENSE_SHA256 = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903'

const TARGETS = {
  'win-x64': {
    asset: 'ffmpeg-win32-x64',
    executable: 'ffmpeg.exe',
    size: 82797568,
    sha256: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
  },
  'mac-x64': {
    asset: 'ffmpeg-darwin-x64',
    executable: 'ffmpeg',
    size: 78862176,
    sha256: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
  },
  'mac-arm64': {
    asset: 'ffmpeg-darwin-arm64',
    executable: 'ffmpeg',
    size: 45568216,
    sha256: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
  },
  'linux-x64': {
    asset: 'ffmpeg-linux-x64',
    executable: 'ffmpeg',
    size: 79826272,
    sha256: 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99',
  },
}

function currentTarget() {
  const osName = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform
  return `${osName}-${process.arch}`
}

function parseTargets(argv) {
  const targets = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--target') continue
    const target = argv[index + 1]
    if (!target) throw new Error('--target requires a value')
    targets.push(target)
    index += 1
  }
  return targets.length > 0 ? targets : [currentTarget()]
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function download(urlString, destination, redirectDepth = 5) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString)
    const client = url.protocol === 'http:' ? http : https
    const request = client.request(url, {
      method: 'GET',
      headers: { 'User-Agent': 'DeLive-FFmpeg-Runtime-Builder' },
    }, response => {
      const statusCode = response.statusCode || 0
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume()
        if (redirectDepth <= 0) {
          reject(new Error(`Too many redirects while downloading ${urlString}`))
          return
        }
        const nextUrl = new URL(response.headers.location, url).toString()
        void download(nextUrl, destination, redirectDepth - 1).then(resolve, reject)
        return
      }
      if (statusCode < 200 || statusCode >= 300) {
        response.resume()
        reject(new Error(`Download failed with HTTP ${statusCode}: ${urlString}`))
        return
      }

      const output = fs.createWriteStream(destination, { flags: 'wx' })
      response.pipe(output)
      output.on('finish', () => output.close(resolve))
      output.on('error', reject)
      response.on('error', reject)
    })
    request.setTimeout(120000, () => request.destroy(new Error(`Download timed out: ${urlString}`)))
    request.on('error', reject)
    request.end()
  })
}

async function ensureVerifiedDownload(url, destination, expectedSha256, expectedSize) {
  try {
    const stat = fs.statSync(destination)
    if ((!expectedSize || stat.size === expectedSize) && await hashFile(destination) === expectedSha256) return
  } catch {
    // Download below.
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`
  try {
    await download(url, temporary)
    const stat = fs.statSync(temporary)
    if (expectedSize && stat.size !== expectedSize) {
      throw new Error(`Unexpected download size for ${url}: expected ${expectedSize}, received ${stat.size}`)
    }
    const actualSha256 = await hashFile(temporary)
    if (actualSha256 !== expectedSha256) {
      throw new Error(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, received ${actualSha256}`)
    }
    fs.rmSync(destination, { force: true })
    fs.renameSync(temporary, destination)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

async function prepareTarget(targetName, repoRoot) {
  const target = TARGETS[targetName]
  if (!target) {
    throw new Error(`Unsupported FFmpeg target '${targetName}'. Supported targets: ${Object.keys(TARGETS).join(', ')}`)
  }
  const targetDir = path.join(repoRoot, 'local-runtimes', 'ffmpeg', targetName)
  const executablePath = path.join(targetDir, target.executable)
  const licensePath = path.join(targetDir, 'COPYING.GPLv3')
  await ensureVerifiedDownload(`${RELEASE_BASE_URL}/${target.asset}`, executablePath, target.sha256, target.size)
  await ensureVerifiedDownload(LICENSE_URL, licensePath, LICENSE_SHA256, 35147)
  if (targetName !== 'win-x64') fs.chmodSync(executablePath, 0o755)

  const sourceNotice = [
    'Bundled FFmpeg runtime for DeLive',
    '',
    'FFmpeg version: 6.1.1',
    `Target: ${targetName}`,
    `Binary source: ${RELEASE_BASE_URL}/${target.asset}`,
    `Binary SHA-256: ${target.sha256}`,
    `Binary size: ${target.size} bytes`,
    'Upstream source: https://github.com/FFmpeg/FFmpeg/tree/n6.1.1',
    `License source: ${LICENSE_URL}`,
    `License SHA-256: ${LICENSE_SHA256}`,
    '',
    'This FFmpeg build is distributed under GPLv3. See COPYING.GPLv3.',
    'DeLive invokes FFmpeg as a separate command-line process.',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(targetDir, 'SOURCE.txt'), sourceNotice, 'utf8')
  console.log(`Prepared FFmpeg ${targetName}: ${executablePath}`)
}

try {
  const targets = parseTargets(process.argv.slice(2))
  for (const target of targets) await prepareTarget(target, process.cwd())
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
