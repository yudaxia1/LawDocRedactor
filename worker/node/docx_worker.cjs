const fs = require('fs')
const path = require('path')
const AdmZip = require('adm-zip')

function decodeMarkdownOriginal(value) {
  const codeBlock = value.match(/^`(.+)`$/)
  if (codeBlock) return codeBlock[1]
  if (value.startsWith('[') && value.includes('](')) {
    const m = value.match(/^\[([^\]]+)\]/)
    if (m) return m[1]
  }
  if (value.startsWith('<') && value.endsWith('>')) return value.slice(1, -1)
  return value
}

function parseMappingMd(markdown) {
  const mapping = new Map()
  const tablePattern = /\|\s*\d+\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g
  for (const match of markdown.matchAll(tablePattern)) {
    let original = match[1].trim()
    const replacement = match[2].trim()
    if (original === '原文' || replacement === '替换') continue
    if (!replacement.startsWith('【') || !replacement.endsWith('】')) continue
    original = decodeMarkdownOriginal(original)
    mapping.set(replacement, original)
  }
  return mapping
}

function loadRules(rulesPath) {
  const raw = JSON.parse(fs.readFileSync(rulesPath, 'utf8'))
  const rules = Array.isArray(raw.rules) ? raw.rules : []
  return rules
    .filter((r) => r && r.enabled !== false && Array.isArray(r.patterns))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .flatMap((r) =>
      r.patterns
        .map((p) => {
          try {
            return { rule: r, regex: new RegExp(p, 'g') }
          } catch {
            return null
          }
        })
        .filter(Boolean)
    )
}

function buildReplacement(template, index) {
  return String(template ?? '【敏感信息${index}】').replace(/\$\{index\}/g, String(index))
}

function extractTextNodes(xml) {
  const re = /<w:t[^>]*>([^<]*)<\/w:t>/g
  const nodes = []
  for (const match of xml.matchAll(re)) {
    nodes.push({
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      fullMatch: match[0],
      content: match[1]
    })
  }
  return nodes
}

function findMatchesInText(text, compiledRules) {
  const candidates = []
  for (const { rule, regex } of compiledRules) {
    regex.lastIndex = 0
    let m
    while ((m = regex.exec(text)) !== null) {
      if (!m[0]) continue
      let original = m[0]
      let start = m.index
      let end = start + original.length

      if (rule.useCaptureGroup) {
        const capture = m.slice(1).find((v) => typeof v === 'string' && v.length > 0)
        if (capture) {
          const offset = m[0].indexOf(capture)
          if (offset >= 0) {
            original = capture
            start = m.index + offset
            end = start + capture.length
          }
        }
      } else if (rule.category === 'organization') {
        if (m[2] && m[3]) {
          const value = String(m[2]) + String(m[3])
          const offset = m[0].indexOf(value)
          if (offset >= 0) {
            original = value
            start = m.index + offset
            end = start + value.length
          }
        }
      } else if (rule.category === 'address') {
        if (m[2]) {
          const value = String(m[2]).trim()
          const offset = m[0].indexOf(m[2])
          if (offset >= 0 && value) {
            original = value
            start = m.index + offset
            end = start + value.length
          }
        }
      }

      if (!original) continue
      candidates.push({
        start,
        end,
        original,
        category: rule.category ?? rule.id ?? 'unknown',
        typeName: rule.name ?? rule.category ?? rule.id ?? '未知'
      })
    }
  }

  candidates.sort((a, b) => (a.start - b.start) || (b.end - a.end))
  const selected = []
  let cursor = -1
  for (const c of candidates) {
    if (c.start < cursor) {
      const prev = selected[selected.length - 1]
      if (prev && c.end - c.start > prev.end - prev.start) {
        selected[selected.length - 1] = c
        cursor = c.end
      }
      continue
    }
    selected.push(c)
    cursor = c.end
  }
  return selected
}

function replaceWithinSingleTags(xml, original, replacement) {
  const tagRe = /(<w:t[^>]*>)([^<]*?)(<\/w:t>)/g
  return xml.replace(tagRe, (m, open, content, close) => {
    if (!content.includes(original)) return m
    return open + content.split(original).join(replacement) + close
  })
}

function applyCrossTagOnce(xml, redactions) {
  const nodes = extractTextNodes(xml)
  const processed = new Set()
  const matches = []

  for (let i = 0; i < nodes.length; i++) {
    if (processed.has(i)) continue

    for (let span = 1; span <= Math.min(8, nodes.length - i); span++) {
      let combinedText = ''
      for (let j = 0; j < span; j++) combinedText += nodes[i + j].content

      for (const item of redactions) {
        const { original, replacement } = item
        const pos = combinedText.indexOf(original)
        if (pos < 0) continue

        let charCount = 0
        let startNodeIndex = i
        let endNodeIndex = i
        for (let j = 0; j < span; j++) {
          const nodeLen = nodes[i + j].content.length
          const nodeEnd = charCount + nodeLen
          if (charCount <= pos && pos < nodeEnd) startNodeIndex = i + j
          const targetEnd = pos + original.length
          if (charCount < targetEnd && targetEnd <= nodeEnd) {
            endNodeIndex = i + j
            break
          }
          if (charCount < targetEnd && nodeEnd < targetEnd) endNodeIndex = i + j
          charCount = nodeEnd
        }

        const actualSpan = endNodeIndex - startNodeIndex + 1
        let offsetInFirstNode = pos
        for (let j = 0; j < startNodeIndex - i; j++) offsetInFirstNode -= nodes[i + j].content.length

        if (!processed.has(startNodeIndex)) {
          matches.push({ startNodeIndex, actualSpan, original, replacement, offsetInFirstNode })
          for (let j = startNodeIndex; j < startNodeIndex + actualSpan; j++) processed.add(j)
          break
        }
      }

      if (processed.has(i)) break
    }
  }

  if (matches.length === 0) return { xml, changed: false }

  let result = xml
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]
    const firstNode = nodes[m.startNodeIndex]
    const lastNode = nodes[m.startNodeIndex + m.actualSpan - 1]

    if (m.actualSpan === 1) {
      const replaced = firstNode.content.replace(m.original, m.replacement)
      const updated = firstNode.fullMatch.replace(firstNode.content, replaced)
      result = result.slice(0, firstNode.startIndex) + updated + result.slice(firstNode.endIndex)
      continue
    }

    const allText = nodes.slice(m.startNodeIndex, m.startNodeIndex + m.actualSpan).map((n) => n.content).join('')
    const before = allText.slice(0, m.offsetInFirstNode)
    const after = allText.slice(m.offsetInFirstNode + m.original.length)
    const newText = before + m.replacement + after

    const newFirst = firstNode.fullMatch.replace(firstNode.content, newText)
    result = result.slice(0, firstNode.startIndex) + newFirst + result.slice(lastNode.endIndex)
  }

  return { xml: result, changed: true }
}

function replaceInXml(xml, redactions) {
  let result = xml
  for (const { original, replacement } of redactions) {
    for (let i = 0; i < 200; i++) {
      const single = replaceWithinSingleTags(result, original, replacement)
      result = single
      const { xml: next, changed } = applyCrossTagOnce(result, [{ original, replacement }])
      result = next
      if (!changed) break
    }
  }
  return result
}

function replaceInXmlScoped(xml, redactions) {
  const paragraphRe = /<w:p[\s\S]*?<\/w:p>/g
  let seen = false
  const next = xml.replace(paragraphRe, (p) => {
    seen = true
    return replaceInXml(p, redactions)
  })
  if (!seen) return replaceInXml(xml, redactions)
  return next
}

function docxRedact({ inputPath, outputPath, mappingPath, rulesPath }) {
  const compiledRules = loadRules(rulesPath)
  const zip = new AdmZip(inputPath)
  const entries = zip.getEntries()

  const replacementMap = new Map()
  const counters = new Map()
  const redactions = []

  for (const entry of entries) {
    const name = entry.entryName
    if (!name.startsWith('word/') || !name.endsWith('.xml')) continue
    const xml = entry.getData().toString('utf8')
    const paragraphRe = /<w:p[\s\S]*?<\/w:p>/g
    const paragraphs = xml.match(paragraphRe) || [xml]
    for (const p of paragraphs) {
      const text = extractTextNodes(p).map((n) => n.content).join('')
      if (!text) continue
      const matches = findMatchesInText(text, compiledRules)
      for (const m of matches) {
        if (replacementMap.has(m.original)) continue
        const current = counters.get(m.category) ?? 1
        const template = compiledRules.find((r) => r.rule.category === m.category)?.rule?.replacement ?? `【${m.typeName}\${index}】`
        const replacement = buildReplacement(template, current)
        counters.set(m.category, current + 1)
        replacementMap.set(m.original, replacement)
        redactions.push({ original: m.original, replacement, type: m.typeName })
      }
    }
  }

  redactions.sort((a, b) => b.original.length - a.original.length)

  for (const entry of entries) {
    const name = entry.entryName
    if (!name.startsWith('word/') || !name.endsWith('.xml')) continue
    const xml = entry.getData().toString('utf8')
    const next = replaceInXmlScoped(xml, redactions)
    if (next !== xml) zip.updateFile(name, Buffer.from(next, 'utf8'))
  }

  zip.writeZip(outputPath)

  const lines = []
  lines.push('# 脱敏内容替换比对')
  lines.push(`**文件**: ${path.basename(inputPath)}`)
  lines.push(`**生成时间**: ${new Date().toISOString()}`)
  lines.push(`**脱敏项总数**: ${redactions.length}`)
  lines.push('')
  lines.push('| 序号 | 原文 | 替换 | 类型 |')
  lines.push('|---:|---|---|---|')
  redactions.forEach((r, idx) => {
    lines.push(`| ${idx + 1} | ${r.original} | ${r.replacement} | ${r.type} |`)
  })
  fs.writeFileSync(mappingPath, lines.join('\n'), 'utf8')

  return { count: redactions.length }
}

function docxRestore({ inputPath, outputPath, mappingPath }) {
  const mappingMd = fs.readFileSync(mappingPath, 'utf8')
  const mapping = parseMappingMd(mappingMd)
  const redactions = Array.from(mapping.entries()).map(([replacement, original]) => ({ original: replacement, replacement: original }))
  redactions.sort((a, b) => b.original.length - a.original.length)

  const zip = new AdmZip(inputPath)
  const entries = zip.getEntries()

  for (const entry of entries) {
    const name = entry.entryName
    if (!name.startsWith('word/') || !name.endsWith('.xml')) continue
    const xml = entry.getData().toString('utf8')
    const next = replaceInXmlScoped(xml, redactions)
    if (next !== xml) zip.updateFile(name, Buffer.from(next, 'utf8'))
  }

  zip.writeZip(outputPath)
  return { count: redactions.length }
}

function parseArgs(argv) {
  const args = new Map()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const key = a.slice(2)
    const value = argv[i + 1]
    args.set(key, value)
    i++
  }
  return args
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (command === 'redact') {
    const inputPath = args.get('input')
    const outputPath = args.get('output')
    const mappingPath = args.get('mapping')
    const rulesPath = args.get('rules')
    if (!inputPath || !outputPath || !mappingPath || !rulesPath) {
      process.stderr.write('missing_args')
      process.exit(2)
    }
    const result = docxRedact({ inputPath, outputPath, mappingPath, rulesPath })
    process.stdout.write(JSON.stringify(result))
    return
  }
  if (command === 'restore') {
    const inputPath = args.get('input')
    const outputPath = args.get('output')
    const mappingPath = args.get('mapping')
    if (!inputPath || !outputPath || !mappingPath) {
      process.stderr.write('missing_args')
      process.exit(2)
    }
    const result = docxRestore({ inputPath, outputPath, mappingPath })
    process.stdout.write(JSON.stringify(result))
    return
  }
  process.stderr.write('unknown_command')
  process.exit(2)
}

if (require.main === module) main()

module.exports = {
  docxRedact,
  docxRestore,
  loadRules,
  parseMappingMd
}
