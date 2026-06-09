#!/usr/bin/env sh
# 在【任意一台有网】的机器上跑一次,产出可离线拷到目标机的 bundle。
#
# 只打【运行时】依赖:serialport(自带 win/linux/mac/android 全平台 prebuilt) + hono + zod。
#   · @opentui/solid、solid-js 由 opencode 的 TUI host 在运行时提供 —— 不打进来。
#     (它们会拉一大堆图形/babel 传递依赖;而且 TUI 插件必须用 host 的同一个 opentui
#      渲染实例,自带反而无效。)
#   · devDependencies(typescript / tsgo / @types)也不打进来。
#
# serialport 的原生 .node 各平台预编译都在 prebuilds/ 里,Mac 上 vendor、拷到 Linux
# 目标机一样能用(目标机仍需自带 node 来跑 sidecar)。
set -e
cd "$(dirname "$0")"

echo "==> 1/4 生成 production-only package.json(剔除 dev / peer 依赖)"
cp package.json package.json.offline-bak
bun -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync("package.json","utf8"));delete p.devDependencies;delete p.peerDependencies;delete p.peerDependenciesMeta;fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n")'

echo "==> 2/4 安装运行时依赖(serialport + hono + zod)"
rm -rf node_modules
if command -v npm >/dev/null 2>&1; then npm install --omit=dev; else bun install; fi

echo "==> 3/4 恢复完整 package.json,打包整个项目(含 node_modules)"
mv package.json.offline-bak package.json
tar -czf ../opencode-plugin-serial-offline.tgz \
  --exclude='.git' --exclude='*.tgz' --exclude='*.offline-bak' \
  -C .. opencode-plugin-serial

echo "==> 4/4 恢复开发依赖(本机继续开发用)"
if command -v bun >/dev/null 2>&1; then bun install >/dev/null 2>&1 || true; fi

echo ""
echo "完成: $(cd .. && pwd)/opencode-plugin-serial-offline.tgz"
echo ""
echo "目标机(离线)上的步骤:"
echo "  1) 装 Node.js —— serialport 的 sidecar 必须用 node 跑(bun 加载不了它的原生模块)。"
echo "  2) 解包: tar -xzf opencode-plugin-serial-offline.tgz"
echo "  3) opencode 配置用【绝对路径】引用: { \"plugin\": [\"/绝对路径/opencode-plugin-serial\"] }"
echo "  注: TUI 监控需要 host 的 opencode 提供 @opentui/solid(opencode TUI 自带,通常已满足)。"
