#!/usr/bin/env node
/**
 * 验证装配产物：
 *  - dist/dynamic-host.js / dist/dynamic-client.js 是合法的动态插件函数体
 *    （包装为 async 函数后做语法检查，并确认结构 inject/apply）；
 *  - dist/client.js 是合法的静态 Client bundle（经典脚本 + __ModuleLoader__.load
 *    约定：factory 可物化、导出 inject/apply）；
 *  - src/*.js 用 `node --check` 按 ESM（package.json type: module）检查。
 */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { spawnSync } from 'node:child_process'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function validateBody(name, file) {
  const body = readFileSync(resolve(root, file), 'utf8')
  try {
    const wrapped = `async function __wrapper__() {\n${body}\n}`
    new vm.Script(wrapped, { filename: file })
  } catch (e) {
    console.error(`✗ ${file}: 语法错误 — ${e.message}`)
    process.exitCode = 1
    return
  }
  const hasInject = /inject:\s*\['timer'/.test(body)
  const hasApply = /apply\s*\(\s*ctx\s*\)/.test(body)
  console.log(`✓ ${file}: 语法 OK, inject 以 ['timer' 开头: ${hasInject}, apply(ctx): ${hasApply}`)
}

function validateStaticBundle(file) {
  const code = readFileSync(resolve(root, file), 'utf8')
  let handoff = null
  const fakeReact = {
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({}),
    createElement: () => ({}),
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (h) => { handoff = h } } },
    document: { createElement: () => ({ setAttribute() {}, remove() {} }), head: { append() {} } },
    fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
    console,
  }
  sandbox.globalThis = sandbox
  try {
    new vm.Script(code, { filename: file }).runInNewContext(sandbox)
    if (!handoff || handoff.id !== 'dsh-btw') throw new Error('未按约定调用 __ModuleLoader__.load({ id: "dsh-btw", factory })')
    const out = handoff.factory((spec) => {
      if (spec === 'react') return fakeReact
      if (spec === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: () => null }
      throw new Error(`意外的 require: ${spec}`)
    })
    if (typeof out.apply !== 'function' || !Array.isArray(out.inject)) {
      throw new Error('factory 未导出 apply/inject')
    }
    console.log(`✓ ${file}: 静态 bundle OK（id=${handoff.id}, inject=${JSON.stringify(out.inject)}）`)
  } catch (e) {
    console.error(`✗ ${file}: ${e.message}`)
    process.exitCode = 1
  }
}

function checkEsm(name, file) {
  // stdio: 'inherit' —— 不捕获子进程输出（避免管道被沙箱/环境拦截），状态码仍可读
  const r = spawnSync(process.execPath, ['--check', resolve(root, file)], { stdio: 'inherit' })
  if (r.status !== 0) {
    console.error(`✗ ${file}: ESM 语法错误`)
    process.exitCode = 1
    return
  }
  console.log(`✓ ${file}: ESM 语法 OK`)
}

validateBody('host', 'dist/dynamic-host.js')
validateBody('client', 'dist/dynamic-client.js')
validateStaticBundle('dist/client.js')
checkEsm('src host', 'src/host.js')
checkEsm('src client', 'src/client.js')

if (process.exitCode) {
  console.error('\n验证失败，请修复后重新运行 npm run check')
} else {
  console.log('\n全部通过：动态产物可作 cordis_define 的 code.host / code.client；dist/client.js 可作静态 exports["./client"]。')
}
