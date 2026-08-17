#!/usr/bin/env node
/**
 * dsh-btw 静态 Client 半区装配脚本：把 src/client.js（ESM 源码）转换为
 * DSH 静态插件所需的浏览器 bundle（dist/client.js）。
 *
 * 背景：`dsh plugin --profile web add <本仓库路径>` 安装后，client-modules
 * 会把 package.json `exports["./client"]` 指向的文件原样作为
 * /plugins/<id>/client.js 提供给浏览器。浏览器侧是一个「经典脚本 + CJS
 * factory」环境（window.__ModuleLoader__.load），与动态路径（cordis_define
 * 的 code.client，宿主沙箱以闭包参数注入 React/host/styles）不同，因此本脚本：
 *   1. 去掉源码里的 ESM `export` 关键字，保留 inject/apply 定义；
 *   2. 在 factory 闭包内提供 React（require("react")，客户端模块系统 seed）、
 *      host（fetch 到 /api/dsh-btw/* HTTP 路由）、styles（<style> 注入）三个
 *      符号，使同一份 apply 逻辑在静态路径下原样运行；
 *   3. 以 exports.inject / exports.apply 形式导出，供客户端 cordis Loader 挂载。
 *
 * 用法：node scripts/build-static.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PACKAGE_NAME = 'dsh-btw'
const API_BASE = '/api/dsh-btw'

function buildStaticClient() {
  const raw = readFileSync(resolve(root, 'src/client.js'), 'utf8')

  // 去掉行首的 ESM export 关键字（export const inject / export function apply）
  // 注意：源文件注释块里的 "export" 不以行首出现，不会被误伤。
  const body = raw.replace(/^export\s+/gm, '')

  const bundle = `/* dsh-btw 静态 Client 半区 bundle —— 由 scripts/build-static.mjs 生成，请勿手改。
 * 修改 src/client.js 后重新运行：npm run build（或 npm run check）。
 * 格式：window.__ModuleLoader__.load({ id, factory })（client-modules 约定）。 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(PACKAGE_NAME)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // React 来自客户端模块系统的 seed 表（与动态路径的 React 闭包符号等价）
    var React = require("react");
    // MarkdownText 复用平台 GFM 渲染器（@deepseek-ai/dsh-client-ui-primitives 是
    // PLATFORM_MODULES seed 词，require 直接命中，无需额外打包）。源码以 MD
    // 标识符引用，未注入时回退纯文本。
    var MarkdownText = require("@deepseek-ai/dsh-client-ui-primitives").MarkdownText;
    // host 桥：动态路径由宿主沙箱提供（harness.handle 配对）；静态路径映射到
    // /api/dsh-btw/* HTTP 路由（Host 半区注册，含浏览器信任围栏）。
    var host = {
      call: async (method, args) => {
        const res = await fetch(${JSON.stringify(API_BASE)} + '/' + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(args === undefined ? null : args),
        });
        if (!res.ok) throw new Error('dsh-btw host call failed: HTTP ' + res.status);
        return res.json();
      }
    };
    // styles 桥：静态路径下直接注入 <style> 标签（data-plugin 标记供 HMR 认领）
    var styles = {
      insert(css) {
        const tag = document.createElement('style');
        tag.setAttribute('data-plugin', ${JSON.stringify(PACKAGE_NAME)});
        tag.textContent = css;
        document.head.append(tag);
        return () => tag.remove();
      }
    };
${body}
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
`

  mkdirSync(resolve(root, 'dist'), { recursive: true })
  writeFileSync(resolve(root, 'dist/client.js'), bundle)
  console.log('✓ dist/client.js（静态 Client bundle，exports["./client"]）')
}

buildStaticClient()
