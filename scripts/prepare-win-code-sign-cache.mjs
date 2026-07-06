import fs from 'fs'
import https from 'https'
import path from 'path'
import { spawnSync } from 'child_process'

const ARTIFACT_NAME = 'winCodeSign-2.6.0'
const ARCHIVE_NAME = `${ARTIFACT_NAME}.7z`
const DOWNLOAD_URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${ARTIFACT_NAME}/${ARCHIVE_NAME}`

function getCacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) {
    return path.resolve(process.env.ELECTRON_BUILDER_CACHE)
  }

  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData) {
    throw new Error('LOCALAPPDATA is not set; cannot resolve electron-builder cache')
  }

  return path.join(localAppData, 'electron-builder', 'Cache')
}

function isCacheReady(targetDir) {
  return fs.existsSync(path.join(targetDir, 'rcedit-x64.exe')) &&
    fs.existsSync(path.join(targetDir, 'windows-10', 'x64', 'signtool.exe'))
}

function getSevenZipPath(repoRoot) {
  const sevenZipPath = path.join(repoRoot, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
  if (!fs.existsSync(sevenZipPath)) {
    throw new Error(`7za.exe not found: ${sevenZipPath}`)
  }
  return sevenZipPath
}

function findExistingArchive(cacheDir) {
  if (!fs.existsSync(cacheDir)) {
    return ''
  }

  const entries = fs.readdirSync(cacheDir)
  const exactArchive = path.join(cacheDir, ARCHIVE_NAME)
  if (fs.existsSync(exactArchive)) {
    return exactArchive
  }

  const cachedArchive = entries.find(entry => entry.endsWith('.7z'))
  return cachedArchive ? path.join(cacheDir, cachedArchive) : ''
}

function download(url, outputPath, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error(`Too many redirects while downloading ${url}`))
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode || 0)) {
        response.resume()
        const location = response.headers.location
        if (!location) {
          reject(new Error(`Redirect without Location header for ${url}`))
          return
        }
        resolve(download(new URL(location, url).toString(), outputPath, redirectCount + 1))
        return
      }

      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`Download failed with status ${response.statusCode}: ${url}`))
        return
      }

      const file = fs.createWriteStream(outputPath)
      response.pipe(file)
      file.on('finish', () => {
        file.close(resolve)
      })
      file.on('error', reject)
    })

    request.on('error', reject)
  })
}

async function main() {
  if (process.platform !== 'win32') {
    console.log('prepare-win-code-sign-cache: skipped on non-Windows platform')
    return
  }

  const repoRoot = process.cwd()
  const sevenZipPath = getSevenZipPath(repoRoot)
  const cacheDir = path.join(getCacheRoot(), 'winCodeSign')
  const targetDir = path.join(cacheDir, ARTIFACT_NAME)

  if (isCacheReady(targetDir)) {
    console.log(`prepare-win-code-sign-cache: ready at ${targetDir}`)
    return
  }

  fs.mkdirSync(cacheDir, { recursive: true })

  let archivePath = findExistingArchive(cacheDir)
  if (!archivePath) {
    archivePath = path.join(cacheDir, ARCHIVE_NAME)
    console.log(`prepare-win-code-sign-cache: downloading ${DOWNLOAD_URL}`)
    await download(DOWNLOAD_URL, archivePath)
  }

  fs.rmSync(targetDir, { recursive: true, force: true })
  fs.mkdirSync(targetDir, { recursive: true })

  const result = spawnSync(sevenZipPath, ['x', '-bd', '-snl-', archivePath, `-o${targetDir}`], {
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    throw new Error(`7za extraction failed with exit code ${result.status}`)
  }

  if (!isCacheReady(targetDir)) {
    throw new Error(`winCodeSign cache is incomplete after extraction: ${targetDir}`)
  }

  console.log(`prepare-win-code-sign-cache: ready at ${targetDir}`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
