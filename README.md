# 法律文件脱敏 2.0（Electron + 本地 Worker）

默认离线处理，核心处理链路在本机完成：

- docx：通过修改 docx 内部 XML（`<w:t>`）实现替换，尽量保留修订/批注等结构
- pdf：生成覆盖层（overlay）进行脱敏；sidecar 保存原始 pdf，支持可逆还原；还原时对注释做 best-effort 合并

## 最简单的使用方式（Windows 安装包）

不需要本地安装 Node/Python，也不需要 `npm install`。推荐通过 GitHub Actions 自动构建并下载安装包：

1. 把本仓库推到你自己的 GitHub 仓库
2. 打开 GitHub → Actions → 选择 `build-windows-installer` → Run workflow
3. 等待完成后，在 Artifacts 下载 `LawDocRedactor-windows-installer`，得到 `.exe` 安装包，双击安装即可使用

## 开发者本地运行（可选）

### 环境要求

- Node.js 20（项目通过 `engines.node` 约束）
- Python 3（用于 PDF Worker）

### 安装

```bash
npm install
python -m pip install -r worker/python/requirements.txt
```

说明：Electron 依赖会下载对应平台的二进制。若网络受限，可为 npm 设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

### 开发运行

```bash
npm run dev
```

默认会拦截应用内所有 `http/https` 出站请求（避免意外联网）。如确需启用在线增强，可在启动时设置 `LDR_ALLOW_NETWORK=1`。

## CLI（便于批处理/调试）

### docx 脱敏

```bash
node worker/node/docx_worker.cjs redact \
  --input input.docx \
  --output output【脱敏】.docx \
  --mapping output_比对.md \
  --rules worker/rules/default-rules.json
```

### docx 还原

```bash
node worker/node/docx_worker.cjs restore \
  --input output【脱敏】.docx \
  --output output【还原】.docx \
  --mapping output_比对.md
```

### pdf 脱敏（文本型）

```bash
python3 worker/python/pdf_worker.py redact \
  --input input.pdf \
  --output output【脱敏】.pdf \
  --sidecar output_sidecar.zip \
  --rules worker/rules/default-rules.json
```

### pdf 还原

```bash
python3 worker/python/pdf_worker.py restore \
  --input output【脱敏】.pdf \
  --output output【还原】.pdf \
  --sidecar output_sidecar.zip
```
