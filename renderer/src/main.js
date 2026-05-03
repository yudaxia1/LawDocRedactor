import './style.css'
const root = document.querySelector('#app')

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else node.setAttribute(k, v)
  }
  for (const c of children) node.append(c)
  return node
}

function formatPath(p) {
  if (!p) return '未选择'
  const parts = p.split(/[\\/]/)
  return parts.slice(-2).join('/')
}

function setStatus(target, text, kind = 'info') {
  target.textContent = text
  target.dataset.kind = kind
}

const api = window.desktop

const state = {
  redactFile: null,
  restoreFile: null,
  restoreSidecar: null,
  outDir: null
}

const status = el('div', { class: 'status', text: '' })
const redactFileLabel = el('div', { class: 'path', text: formatPath(null) })
const restoreFileLabel = el('div', { class: 'path', text: formatPath(null) })
const sidecarLabel = el('div', { class: 'path', text: formatPath(null) })
const outDirLabel = el('div', { class: 'path', text: formatPath(null) })

async function pickOutDir() {
  if (!api) return
  const dir = await api.selectDir({ title: '选择输出目录' })
  if (!dir) return
  state.outDir = dir
  outDirLabel.textContent = formatPath(dir)
}

async function pickRedactFile() {
  if (!api) return
  const file = await api.openFile({
    title: '选择要脱敏的文件',
    filters: [
      { name: 'Documents', extensions: ['docx', 'pdf'] }
    ]
  })
  if (!file) return
  state.redactFile = file
  redactFileLabel.textContent = formatPath(file)
}

async function pickRestoreFile() {
  if (!api) return
  const file = await api.openFile({
    title: '选择要还原的文件',
    filters: [
      { name: 'Documents', extensions: ['docx', 'pdf'] }
    ]
  })
  if (!file) return
  state.restoreFile = file
  restoreFileLabel.textContent = formatPath(file)
}

async function pickSidecar() {
  if (!api) return
  const file = await api.openFile({
    title: '选择映射文件（docx: _比对.md / pdf: _sidecar.zip）',
    filters: [
      { name: 'Mapping', extensions: ['md', 'zip'] }
    ]
  })
  if (!file) return
  state.restoreSidecar = file
  sidecarLabel.textContent = formatPath(file)
}

async function runRedact() {
  if (!api) return
  if (!state.redactFile) {
    setStatus(status, '请选择要脱敏的文件', 'error')
    return
  }
  setStatus(status, '处理中…', 'info')
  try {
    const res = await api.redact({ filePath: state.redactFile, outDir: state.outDir })
    if (res?.outputPath) setStatus(status, `已导出：${formatPath(res.outputPath)}`, 'ok')
    else setStatus(status, '处理完成', 'ok')
  } catch (e) {
    setStatus(status, String(e?.message || e), 'error')
  }
}

async function runRestore() {
  if (!api) return
  if (!state.restoreFile) {
    setStatus(status, '请选择要还原的文件', 'error')
    return
  }
  if (!state.restoreSidecar) {
    setStatus(status, '请选择映射文件', 'error')
    return
  }
  setStatus(status, '处理中…', 'info')
  try {
    const res = await api.restore({
      filePath: state.restoreFile,
      mappingPath: state.restoreSidecar,
      outDir: state.outDir
    })
    if (res?.outputPath) setStatus(status, `已导出：${formatPath(res.outputPath)}`, 'ok')
    else setStatus(status, '处理完成', 'ok')
  } catch (e) {
    setStatus(status, String(e?.message || e), 'error')
  }
}

root.replaceChildren(
  el('div', { class: 'container' }, [
    el('header', { class: 'header' }, [
      el('div', { class: 'title', text: '法律文件脱敏 2.0' }),
      el('div', { class: 'subtitle', text: '默认离线处理（可选在线增强），支持 docx / 文本型 pdf 可逆脱敏' })
    ]),
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel-title', text: '输出目录' }),
      el('div', { class: 'row' }, [
        outDirLabel,
        el('button', { class: 'btn' , text: '选择' })
      ])
    ]),
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel-title', text: '脱敏' }),
      el('div', { class: 'row' }, [
        redactFileLabel,
        el('button', { class: 'btn', text: '选择文件' })
      ]),
      el('div', { class: 'row' }, [
        el('div', { class: 'hint', text: '导出：文件【脱敏】 + docx 比对.md / pdf sidecar.zip' }),
        el('button', { class: 'btn primary', text: '开始脱敏' })
      ])
    ]),
    el('section', { class: 'panel' }, [
      el('div', { class: 'panel-title', text: '还原' }),
      el('div', { class: 'row' }, [
        restoreFileLabel,
        el('button', { class: 'btn', text: '选择文件' })
      ]),
      el('div', { class: 'row' }, [
        sidecarLabel,
        el('button', { class: 'btn', text: '选择映射' })
      ]),
      el('div', { class: 'row' }, [
        el('div', { class: 'hint', text: '导出：文件【还原】（pdf best-effort 合并注释）' }),
        el('button', { class: 'btn primary', text: '开始还原' })
      ])
    ]),
    status,
    el('div', { class: 'footer', text: api ? '已连接桌面端' : '当前为浏览器模式（无法调用本地处理）' })
  ])
)

const buttons = root.querySelectorAll('button.btn')
buttons[0].addEventListener('click', pickOutDir)
buttons[1].addEventListener('click', pickRedactFile)
buttons[2].addEventListener('click', runRedact)
buttons[3].addEventListener('click', pickRestoreFile)
buttons[4].addEventListener('click', pickSidecar)
buttons[5].addEventListener('click', runRestore)

setStatus(status, '就绪', 'info')
