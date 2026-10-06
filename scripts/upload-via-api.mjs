/**
 * 一次性上传器：把当前 checkout 的文件通过 **Git Data API** 提交到 GitHub。
 *
 * 为什么不用 `git push`：这台机器上 `github.com` 的 git 传输域会被重置/超时，
 * 而 `api.github.com` 是通的（网络分化）。Git Data API 走的是后者，正好绕过。
 * 内容按 git 存储形态准备：文本统一转 LF（与仓库的 .gitattributes 一致），
 * 二进制按原字节 base64，保证远端与本地 `git push` 的结果一致。
 *
 * 用法：
 *   node scripts/upload-via-api.mjs <owner/repo> <branch> <提交信息文件>
 * token 从 $DSH_GITHUB_TOKEN 或 $GITHUB_TOKEN 读，绝不打印。
 *
 * @module @ptfm/dsh-github/scripts/upload-via-api
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { extname, relative, resolve } from 'node:path'

const [slug, branch, messageFile] = process.argv.slice(2)
if (!slug || !branch || !messageFile) {
  console.error('用法：node scripts/upload-via-api.mjs <owner/repo> <branch> <提交信息文件>')
  process.exit(2)
}
const token = (process.env.DSH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim()
if (token === '') {
  console.error('缺少 token：请设置 DSH_GITHUB_TOKEN 或 GITHUB_TOKEN。')
  process.exit(2)
}
const [owner, repo] = slug.split('/')
const repoRoot = resolve(import.meta.dirname, '..')

/** 文本扩展名：这些按 UTF-8 读、转 LF。其余按二进制处理。 */
const TEXT_EXT = new Set(['.mjs', '.js', '.json', '.yml', '.yaml', '.md', '.txt', '.sh', '.gitignore', '.gitattributes'])

/**
 * 必须**按原始字节**提交的扩展名。
 *
 * `.ps1` 在 Windows PowerShell 5.1 上必须是「UTF-8 带 BOM」才能被正确解析（否则它
 * 按 ANSI 读，含中文的脚本会直接报语法错）。BOM 是文件字节的一部分，所以这里不能
 * 走文本处理——按文本读会把 BOM 丢掉，别人克隆下来跑安装脚本就崩。
 */
const BINARY_EXT = new Set(['.ps1'])

async function api(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-github-publisher',
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let body
  if (text.trim() !== '') {
    try { body = JSON.parse(text) } catch { body = text }
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} → HTTP ${response.status}：${typeof body === 'object' ? body?.message : String(body).slice(0, 200)}`)
  }
  return body
}

/** 列出要提交的文件（用 git 自己的索引，顺序与忽略规则都一致）。 */
function listFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\0').filter((name) => name !== '')
}

/** 读一个文件，按 git 存储形态返回 Buffer。 */
function readAsStored(relPath) {
  const ext = extname(relPath).toLowerCase()
  if (BINARY_EXT.has(ext)) return readFileSync(resolve(repoRoot, relPath))
  const isText = TEXT_EXT.has(ext) || relPath === 'LICENSE'
  if (isText) {
    const text = readFileSync(resolve(repoRoot, relPath), 'utf8').replace(/\r\n/g, '\n')
    return Buffer.from(text, 'utf8')
  }
  return readFileSync(resolve(repoRoot, relPath))
}

const files = listFiles()
console.log(`准备提交 ${String(files.length)} 个文件到 ${slug}@${branch}`)

/**
 * 空仓库要先有一个提交才能用 Git Data API（否则建 blob 报
 * `409 Git Repository is empty`）。用 Contents API 拿第一个文件造出初始提交。
 * @returns {Promise<void>}
 */
async function bootstrapIfEmpty() {
  try {
    await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
    return
  } catch {
    // 分支还不存在：继续走 bootstrap。
  }
  const seed = files.includes('.gitattributes') ? '.gitattributes' : files[0]
  const content = readAsStored(seed)
  await api(`/repos/${owner}/${repo}/contents/${seed.split('\\').join('/')}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'chore: 初始化仓库',
      content: content.toString('base64'),
      branch,
    }),
  })
  console.log(`已用 ${seed} 造出初始提交（仓库原本为空）`)
}

await bootstrapIfEmpty()

// 1. 逐个建 blob
const treeEntries = []
for (const file of files) {
  const content = readAsStored(file)
  const blob = await api(`/repos/${owner}/${repo}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: content.toString('base64'), encoding: 'base64' }),
  })
  treeEntries.push({ path: file.split('\\').join('/'), mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`  blob ${file} (${String(content.length)} B)`)
}

// 2. 建 tree
const tree = await api(`/repos/${owner}/${repo}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree: treeEntries }),
})
console.log(`tree ${tree.sha}`)

// 3. 建 commit：有父提交就接上（幂等重跑时不会丢历史）
let parent
try {
  const ref = await api(`/repos/${owner}/${repo}/git/ref/heads/${branch}`)
  parent = ref.object.sha
} catch {
  parent = undefined
}
const message = readFileSync(messageFile, 'utf8')
const commit = await api(`/repos/${owner}/${repo}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({ message, tree: tree.sha, ...(parent === undefined ? {} : { parents: [parent] }) }),
})
console.log(`commit ${commit.sha}`)

// 4. 更新或创建分支 ref
if (parent === undefined) {
  await api(`/repos/${owner}/${repo}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commit.sha }),
  })
  console.log(`已创建分支 ${branch}`)
} else {
  await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  })
  console.log(`已更新分支 ${branch}`)
}
console.log(`完成：https://github.com/${slug}/tree/${branch}`)
