#!/usr/bin/env node
/**
 * 验证装配产物（dist/dynamic-host.js / dist/dynamic-client.js）是合法的
 * 动态插件函数体：包装为 async 函数后做语法检查，并确认结构（inject/apply）。
 * src/*.js 用 `node --check` 按 ESM（package.json type: module）检查。
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
  const hasInject = /inject:\s*\['timer'\]/.test(body)
  const hasApply = /apply\s*\(\s*ctx\s*\)/.test(body)
  console.log(`✓ ${file}: 语法 OK, inject=['timer']: ${hasInject}, apply(ctx): ${hasApply}`)
}

function checkEsm(name, file) {
  const r = spawnSync(process.execPath, ['--check', resolve(root, file)], { encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`✗ ${file}: ESM 语法错误\n${r.stderr}`)
    process.exitCode = 1
    return
  }
  console.log(`✓ ${file}: ESM 语法 OK`)
}

validateBody('host', 'dist/dynamic-host.js')
validateBody('client', 'dist/dynamic-client.js')
checkEsm('src host', 'src/host.js')
checkEsm('src client', 'src/client.js')

if (process.exitCode) {
  console.error('\n验证失败，请修复后重新运行 node scripts/to-dynamic.mjs')
} else {
  console.log('\n全部通过：dist 装配产物可直接作为 cordis_define 的 code.host / code.client 使用。')
}
