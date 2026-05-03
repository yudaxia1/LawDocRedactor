const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const { app, BrowserWindow, ipcMain, dialog, session } = require('electron')
const { docxRedact, docxRestore } = require('../worker/node/docx_worker.cjs')

const isDev = !app.isPackaged
const devRoot = path.join(__dirname, '..')
const defaultRulesPath = app.isPackaged
  ? path.join(process.resourcesPath, 'worker', 'rules', 'default-rules.json')
  : path.join(devRoot, 'worker', 'rules', 'default-rules.json')
const pdfWorkerExecutable = app.isPackaged
  ? path.join(process.resourcesPath, 'bin', process.platform === 'win32' ? 'pdf_worker.exe' : 'pdf_worker')
  : null

function getRendererUrl() {
  if (process.env.ELECTRON_RENDERER_URL) return process.env.ELECTRON_RENDERER_URL
  if (isDev) return 'http://localhost:5173'
  return `file://${path.join(process.resourcesPath, 'renderer', 'dist', 'index.html')}`
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  await win.loadURL(getRendererUrl())

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' })
  }
}

ipcMain.handle('dialog:openFiles', async (_event, options) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    ...options
  })
  if (result.canceled) return []
  return result.filePaths
})

ipcMain.handle('dialog:openFile', async (_event, options) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    ...options
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
})

ipcMain.handle('dialog:selectDir', async (_event, options) => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory', 'createDirectory'],
    ...options
  })
  if (result.canceled) return null
  return result.filePaths[0] ?? null
})

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: devRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function withSuffix(filePath, suffix) {
  const dir = path.dirname(filePath)
  const ext = path.extname(filePath)
  const base = path.basename(filePath, ext)
  return path.join(dir, `${base}${suffix}${ext}`)
}

ipcMain.handle('job:redact', async (_event, { filePath, outDir }) => {
  if (!filePath) throw new Error('missing_file')
  const ext = path.extname(filePath).toLowerCase()
  const outputDir = outDir || path.dirname(filePath)
  ensureDir(outputDir)

  if (ext === '.docx') {
    const outputPath = path.join(outputDir, path.basename(withSuffix(filePath, '【脱敏】')))
    const mappingPath = path.join(outputDir, `${path.basename(filePath, ext)}_比对.md`)
    const res = docxRedact({
      inputPath: filePath,
      outputPath,
      mappingPath,
      rulesPath: defaultRulesPath
    })
    return { outputPath, mappingPath, raw: JSON.stringify(res) }
  }

  if (ext === '.pdf') {
    const outputPath = path.join(outputDir, path.basename(withSuffix(filePath, '【脱敏】')))
    const sidecarPath = path.join(outputDir, `${path.basename(filePath, ext)}_sidecar.zip`)
    const result = app.isPackaged
      ? await runProcess(pdfWorkerExecutable, [
          'redact',
          '--input',
          filePath,
          '--output',
          outputPath,
          '--sidecar',
          sidecarPath,
          '--rules',
          defaultRulesPath
        ])
      : await runProcess('python3', [
          path.join(devRoot, 'worker', 'python', 'pdf_worker.py'),
          'redact',
          '--input',
          filePath,
          '--output',
          outputPath,
          '--sidecar',
          sidecarPath,
          '--rules',
          defaultRulesPath
        ])
    if (result.code !== 0) throw new Error(result.stderr || 'pdf_redact_failed')
    return { outputPath, sidecarPath, raw: result.stdout }
  }

  throw new Error('unsupported_type')
})

ipcMain.handle('job:restore', async (_event, { filePath, mappingPath, outDir }) => {
  if (!filePath) throw new Error('missing_file')
  const ext = path.extname(filePath).toLowerCase()
  const outputDir = outDir || path.dirname(filePath)
  ensureDir(outputDir)

  if (ext === '.docx') {
    if (!mappingPath) throw new Error('missing_mapping')
    const outputPath = path.join(outputDir, path.basename(withSuffix(filePath, '【还原】')))
    const res = docxRestore({ inputPath: filePath, outputPath, mappingPath })
    return { outputPath, raw: JSON.stringify(res) }
  }

  if (ext === '.pdf') {
    if (!mappingPath) throw new Error('missing_sidecar')
    const outputPath = path.join(outputDir, path.basename(withSuffix(filePath, '【还原】')))
    const result = app.isPackaged
      ? await runProcess(pdfWorkerExecutable, [
          'restore',
          '--input',
          filePath,
          '--output',
          outputPath,
          '--sidecar',
          mappingPath
        ])
      : await runProcess('python3', [
          path.join(devRoot, 'worker', 'python', 'pdf_worker.py'),
          'restore',
          '--input',
          filePath,
          '--output',
          outputPath,
          '--sidecar',
          mappingPath
        ])
    if (result.code !== 0) throw new Error(result.stderr || 'pdf_restore_failed')
    return { outputPath, raw: result.stdout }
  }

  throw new Error('unsupported_type')
})

app.whenReady().then(async () => {
  const allowNetwork = process.env.LDR_ALLOW_NETWORK === '1'
  if (!allowNetwork) {
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        if (isDev && details.url.startsWith('http://localhost:5173/')) return callback({ cancel: false })
        return callback({ cancel: true })
      }
    )
  }
  await createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
