/**
 * 插件入口（薄壳）。
 *
 * 真正的实现在 `./index.js`，这里只做原样再导出。
 *
 * 为什么要多一个文件：Cordis 的插件模块缓存在**模块 specifier** 上，一旦某个
 * 版本的 `apply` 抛过错，之后改同一条路径下的文件内容也不会被重新求值——disable/
 * enable 只会把同一条旧报错原样回放。换一个入口文件名就换了一个 specifier，
 * 缓存自然失效。这在开发期（尤其是插件第一次加载失败时）是必需的，否则只能重启
 * 整个 DSH。
 *
 * 生产上这个文件没有存在感：包名、条目 id、patch id 都不变。
 *
 * @module @ptfm/dsh-github
 */

export { name, inject, apply } from './index.js'
