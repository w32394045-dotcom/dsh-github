/**
 * 工具表与本地 git 解析的离线自测。
 *
 * 覆盖两类容易悄悄写错、但一写错就影响每个会话的东西：
 *  1. 工具表本身（名字唯一、参数能编译成合法 JSON Schema、handler 齐备）；
 *  2. `.git/config` 解析（https / ssh / 老式段落 / 非 GitHub 远端）。
 *
 * 运行：node test/tools-unit.mjs
 *
 * @module @ptfm/dsh-github/test/tools-unit
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_TABLE, parseGitConfig, detectLocalRepo, toJsonSchema } from '../lib/tools.mjs'

/** 通过计数。 */
let passed = 0
/** 失败计数。 */
let failed = 0

/**
 * 断言。
 * @param {boolean} condition
 * @param {string} label
 */
function ok(condition, label) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}`)
  }
}

console.log('== 工具表')
// 数量不写死：写死会让「新增一个工具」变成一次必然要改的测试。
// 这里真正要守的是「表里每一项都被断言覆盖」，而不是某个魔数。
ok(TOOL_TABLE.length >= 12, `工具表至少 12 个工具（实际 ${String(TOOL_TABLE.length)}）`)
const names = TOOL_TABLE.map((tool) => tool.name)
ok(new Set(names).size === names.length, '工具名唯一')
ok(names.every((name) => name.startsWith('github-')), '工具名统一前缀 github-')
ok(TOOL_TABLE.every((tool) => typeof tool.description === 'string' && tool.description.length >= 20), '每个工具都有足够说明')
ok(TOOL_TABLE.every((tool) => typeof tool.handler === 'function'), '每个工具都有 handler')

console.log('\n== 参数编译成 JSON Schema')
for (const tool of TOOL_TABLE) {
  const schema = toJsonSchema(tool.parameters)
  const annotations = ['title', 'description', 'default', 'examples']
  const allowedTypes = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  const nodes = Object.values(schema.properties)
  ok(schema.type === 'object' && schema.additionalProperties === false, `${tool.name}：根节点是闭合对象`)
  ok(nodes.every((node) => allowedTypes.includes(node.type)), `${tool.name}：参数类型都在 DSH 支持集合内`)
  ok(
    nodes.every((node) => Object.keys(node).every((key) => ['type', 'description', 'enum', 'const'].concat(annotations).includes(key))),
    `${tool.name}：参数只带受支持的关键字`,
  )
  ok(
    nodes.every((node) => node.enum === undefined || (Array.isArray(node.enum) && node.enum.length > 0)),
    `${tool.name}：enum 非空`,
  )
  ok(schema.required === undefined || Array.isArray(schema.required), `${tool.name}：required 是顶层数组或省略`)
}

console.log('\n== .git/config 解析')
ok(
  parseGitConfig('[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/ptfm/dsh-github.git\n\tfetch = +refs/heads/*\n')?.repo === 'ptfm/dsh-github',
  'https 远端',
)
ok(parseGitConfig('[remote "origin"]\n\turl = git@github.com:foo/bar.git\n')?.repo === 'foo/bar', 'ssh 远端')
ok(parseGitConfig('[remote "origin"]\n\turl = ssh://git@github.com/foo/bar\n')?.repo === 'foo/bar', 'ssh:// 远端且无 .git 后缀')
ok(parseGitConfig('[remote.origin]\n\turl = https://github.com/foo/bar.git\n')?.repo === 'foo/bar', '老式 [remote.origin] 段落')
ok(parseGitConfig('[remote "upstream"]\n\turl = https://github.com/up/stream.git\n')?.repo === 'up/stream', '没有 origin 时取第一个远端')
ok(
  parseGitConfig('[remote "origin"]\n\turl = https://gitlab.com/a/b.git\n[remote "upstream"]\n\turl = https://github.com/up/stream.git\n')?.repo === 'up/stream',
  'origin 不是 GitHub 时回退到其它远端',
)
ok(parseGitConfig('[core]\n\tbare = false\n') === undefined, '没有远端时返回 undefined')
ok(parseGitConfig('') === undefined, '空文本返回 undefined')
ok(parseGitConfig('not yaml at all') === undefined, '无法解析时返回 undefined')

console.log('\n== detectLocalRepo 向上查找')
const home = mkdtempSync(join(tmpdir(), 'dsh-github-git-'))
const repoRoot = join(home, 'work', 'myrepo')
const nested = join(repoRoot, 'src', 'deep')
mkdirSync(join(repoRoot, '.git'), { recursive: true })
mkdirSync(nested, { recursive: true })
writeFileSync(join(repoRoot, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/widget.git\n', 'utf8')
const found = detectLocalRepo(nested)
ok(found?.repo === 'acme/widget', '从深层子目录向上找到仓库')
ok(found?.root === repoRoot, '返回仓库根目录')
ok(detectLocalRepo(join(home, 'work')) === undefined, '没有仓库时返回 undefined')
rmSync(home, { recursive: true, force: true })

console.log(`\n结果：${String(passed)} 通过，${String(failed)} 失败`)
process.exit(failed === 0 ? 0 : 1)
