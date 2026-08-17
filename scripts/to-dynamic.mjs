#!/usr/bin/env node
/**
 * dsh-btw 装配脚本：把 src/host.js / src/client.js 的 ESM 源码转换为
 * DSH 动态 Cordis 插件所需的 code.host / code.client 函数体。
 *
 * 动态插件（cordis_define）的 code.host / code.client 是「函数体」：
 * 代码以 async 函数体形式执行，必须 return 一个 Plugin 对象
 * （{ inject?, apply(ctx) { ... } }）。
 *
 * 本脚本把源码中的具名导出还原为函数体内的插件对象，输出到 dist/：
 *   - dist/dynamic-host.js   → 粘贴为 cordis_define 的 code.host
 *   - dist/dynamic-client.js → 粘贴为 cordis_define 的 code.client
 *
 * 用法：node scripts/to-dynamic.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 把 ESM 源码转换为动态插件函数体。
 * 规则：
 *   1. 去掉 `export const inject = [...]` 行（函数体里 inject 在 return 对象上）
 *   2. 去掉 `export function apply(ctx) {` 与结尾的 `}`，改为 `return { inject, apply(ctx) {...} }`
 *   3. 保留其余所有实现代码
 * @param {string} srcPath 源码路径
 * @param {string} fnName  函数名（apply）
 */
function toDynamicBody(srcPath) {
  const raw = readFileSync(srcPath, 'utf8')
  // 提取 inject 声明（若有）
  const injectMatch = raw.match(/export const inject = (\[[^\n]*\])/)
  const injectDecl = injectMatch ? `inject: ${injectMatch[1]},\n  ` : ''

  // 提取 apply 函数体（从 `export function apply(ctx) {` 到文件末尾的匹配 `}`）
  const startMark = 'export function apply(ctx) {'
  const start = raw.indexOf(startMark)
  if (start === -1) throw new Error(`${srcPath}: 找不到 "${startMark}"`)
  const bodyStart = start + startMark.length
  // 找到与开头 { 匹配的结尾 }（从 bodyStart 处开始深度计数；
  // 跳过字符串字面量与模板字符串，避免其中的花括号（如 CSS）干扰配对）
  let depth = 1
  let end = bodyStart
  let i = bodyStart
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === "'" || ch === '"') {
      // 跳过普通字符串（含转义）
      const quote = ch
      i++
      while (i < raw.length) {
        if (raw[i] === '\\') { i += 2; continue }
        if (raw[i] === quote) { i++; break }
        i++
      }
      continue
    }
    if (ch === '`') {
      // 跳过模板字符串（含 ${...} 嵌套？模板内表达式可能有花括号，
      // 但表达式会闭合为普通代码，此处保守处理：跳到下一个未转义反引号）
      i++
      while (i < raw.length) {
        if (raw[i] === '\\') { i += 2; continue }
        if (raw[i] === '`') { i++; break }
        i++
      }
      continue
    }
    if (ch === '/') {
      // 跳过注释
      const next = raw[i + 1]
      if (next === '/') {
        while (i < raw.length && raw[i] !== '\n') i++
        continue
      }
      if (next === '*') {
        const close = raw.indexOf('*/', i + 2)
        i = close === -1 ? raw.length : close + 2
        continue
      }
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
    i++
  }
  if (depth !== 0) throw new Error(`${srcPath}: apply 函数体花括号不配对`)
  const body = raw.slice(bodyStart, end).replace(/\n  \/\/#endregion[^\n]*/g, '')

  // 去掉文件头注释块（可选，保留有助于阅读）
  const cleaned = body

  // 动态路径（cordis_define）沙箱不提供 primitives seed 的 require，注入
  // MarkdownText = null 兜底；源码顶层的 `const MD = ...` 位于 apply 函数体外，
  // 不会被 toDynamicBody 提取，这里一并补上（回退纯文本渲染）。
  return `const MarkdownText = null;
const MD = MarkdownText;

return {\n  ${injectDecl}apply(ctx) {${cleaned}\n  },\n}`
}

function main() {
  const host = toDynamicBody(resolve(root, 'src/host.js'))
  const client = toDynamicBody(resolve(root, 'src/client.js'))

  mkdirSync(resolve(root, 'dist'), { recursive: true })
  writeFileSync(resolve(root, 'dist/dynamic-host.js'), host + '\n')
  writeFileSync(resolve(root, 'dist/dynamic-client.js'), client + '\n')
  console.log('✓ dist/dynamic-host.js')
  console.log('✓ dist/dynamic-client.js')
  console.log('')
  console.log('使用：把 dist/dynamic-host.js 的内容粘贴为 cordis_define 的 code.host，')
  console.log('     把 dist/dynamic-client.js 的内容粘贴为 code.client。')
}

main()
