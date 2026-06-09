# 安装说明

`opencode-plugin-serial` 是一个独立的 opencode 插件,不改 opencode 内核。装好后,
agent 获得 14 个 `serial_*` 工具,TUI 里多出实时串口状态条 + 监控面板。

> ⚠️ **最重要的一步(很多人卡在这):** 这个插件有**两半**——
> **server 半**(工具 + `/serial` 服务)从 `opencode.json` 的 `plugin` 数组加载;
> **TUI 半**(状态条 / sidebar / `/serial` 全屏)由 opencode 的 TUI 加载器从
> **`tui.json`** 加载。两个配置走两套加载器,互不读取。**只写 opencode.json 时,
> 工具能用但 UI 永远不显示。** 必须在 `opencode.json` 和 `tui.json` 里**都**列出本插件。

## 0. 前置依赖

- **Node.js**(在 PATH 上):串口底层库 `serialport` 是原生模块,bun 加载不了
  (oven-sh/bun#18546),插件会 spawn 一个 node 子进程来跑它。
- 在插件项目里跑过一次 `bun install`(装好 `serialport` 等运行时依赖)。

```sh
cd /Users/yuxiaotong/Documents/张泽南/opencode-plugin-serial
bun install
```

## 1. 装到 opencode

### 方式 A:本地路径(推荐,免发布)

编辑你要使用的 opencode 项目的配置文件(`.opencode/opencode.json` 或
`opencode.jsonc`),在 `plugin` 数组里加入这个项目的路径:

```jsonc
// .opencode/opencode.json —— server 半(工具 + /serial 服务)
{
  "plugin": ["/Users/yuxiaotong/Documents/张泽南/opencode-plugin-serial"]
}
```

```jsonc
// .opencode/tui.json —— TUI 半(状态条 / sidebar / /serial 全屏)。必须也写!
{
  "plugin": ["/Users/yuxiaotong/Documents/张泽南/opencode-plugin-serial"]
}
```

两个文件的 `plugin` 数组用**同一个路径**。`package.json` 的 `exports` 已经分别暴露了
`.`(server)和 `./tui`(TUI),两套加载器各取所需。

opencode 只认这三种「路径型」spec:

| 写法 | 例子 |
| --- | --- |
| 绝对路径(最稳) | `/Users/.../opencode-plugin-serial` |
| `file://` URL | `file:///Users/.../opencode-plugin-serial` |
| 以 `.` 开头的相对路径 | `../opencode-plugin-serial`(相对**配置文件所在目录**) |

> ⚠️ **不要**写 `"file:../opencode-plugin-serial"`(单冒号)——它既不是 `file://`
> 也不以 `.` 开头,opencode 会把它当成 npm 包名去安装,然后失败。

带选项(见第 2 节):

```jsonc
{ "plugin": [["/Users/.../opencode-plugin-serial", { "port": 4097 }]] }
```

### 方式 B:打包/发布后用包名

```sh
bun pm pack                                    # 生成 opencode-plugin-serial-0.1.0.tgz
npm publish opencode-plugin-serial-0.1.0.tgz   # 发布到 npm(或私有 registry)
```

```jsonc
{ "plugin": ["opencode-plugin-serial"] }       # 用包名引用,opencode 会自动安装
```

## 2. 配置选项

作为 plugin spec 的第二个元素传入:

| 选项 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | 设 `false` 关闭整个插件 |
| `server` | boolean | `true` | 设 `false` 不启动 `/serial` HTTP/WS 服务(工具仍可用,但没有实时监控) |
| `port` | number | 随机空闲端口 | 固定 `/serial` 服务端口(监控基于 cwd 的端口发现不适用时有用) |
| `directory` | string | `<worktree>/.opencode/serial` | `api.json` 等数据目录 |

## 3. 验证装好了

1. 重启 opencode。
2. 让 agent 调用 `serial_list_ports` —— 返回设备列表说明**工具(server 半)**加载成功。
3. TUI 里输入 `/serial` —— 能打开全屏监控说明 **TUI 半**也加载了(即 `tui.json` 写对了)。
   若 `/serial` 命令根本不存在 → TUI 半没加载,回去检查 `tui.json`。
4. agent `serial_create` 后,**底部状态条**应自动出现一行 `● COM3@115200 ...`。
5. 检查 `<worktree>/.opencode/serial/api.json` 是否生成 —— 在说明**服务**起来了。

- **底部状态条(app_bottom)** 无条件显示,只要有活动会话就出现,不挑终端宽度。
- **sidebar 块**只有在 sidebar 本身可见时才显示:需要在一个会话里、且终端**宽 > 120 列**
  (或手动开 sidebar),且不在子 agent 会话中——这是 opencode 宿主的行为,插件改不了。
- 全屏监控:`[` / `]` 切换会话,`esc` 退出;`cursor=0` 会先回放历史。

## 3.5 新能力速览

- **降噪(Q1):** `serial_read_recent` / `serial_collect` 支持 `dedup`(折叠连续重复行)、
  `cycles`(折叠 A/B/C/A/B/C 这类循环块)、`normalize`(按掩码后的"形状"折叠模板行)、
  `exclude` / `include`(正则丢/留)。`serial_collect` 默认开 `cycles`。
  `serial_digest` 给"出没出错"的结构化摘要,不刷屏。
- **样机表(Q2):** 编辑 `<worktree>/.opencode/serial/devices.json` 把 USB 适配器
  (`serialNumber` 或 `vendorId+productId`)映射到样机名/机型/波特率;`serial_list_ports`
  会带上匹配结果。不知道怎么填就 `serial_devices({action:"scaffold"})` 生成模板,改完
  `serial_devices({action:"reload"})`。`serial_probe` 主动探测哪个口有活机器、是什么。
- **样机锁(Q2):** `serial_create` 会为调用方(按 opencode `sessionID`)申请该物理设备的
  **租约**;另一个 agent 再 create/write 同一台会被拒,除非传 `takeover:true`。
  **读类工具(read_recent/grep/wait/digest)永远不需要租约**——可以多 agent 同时围观,
  但只有一个能写。租约带 TTL + 心跳,持有者崩溃后自动过期可被接管。

## 4. 和 my-opencode 内置 serial 的冲突

my-opencode 内核**自带** serial 工具(本插件正是从它解耦出来的)。如果在 my-opencode
里直接装本插件,`serial_*` 工具名会和内核的**撞名**。二选一:

- 在内核禁用内置 serial(移除 `tool/registry.ts` 的 serial 注册 + `agent.ts` 白名单),或
- 把本插件用于**不带 serial 的**其他 opencode 构建。

## 5. 故障排查

| 现象 | 处理 |
| --- | --- |
| **工具能用,但 sidebar / 状态条 / `/serial` 都不显示** | TUI 半没加载——在 `tui.json`(不是只有 opencode.json)里也列出本插件。见第 1 节。 |
| sidebar 不显示(但 `/serial` 命令存在) | sidebar 需要终端**宽 > 120 列**或手动开,且在非子 agent 会话里。改用底部状态条(无此限制)或 `/serial` 全屏。 |
| 状态条/监控显示空 / "No active serial sessions" | agent 还没 `serial_create`;或服务没发现 → 现已自动在 `<home>/.opencode/serial/api.json` 也写一份发现文件,跨 cwd/跨平台都能找到;仍不行就设环境变量 `OPENCODE_SERIAL_URL=http://127.0.0.1:<port>` 或固定 `port`。 |
| `serial helper not found` / 工具报错 | 确认 `node` 在 PATH;在插件项目跑过 `bun install` |
| `device is controlled by session ...`(写被拒) | 另一个 agent 持有该设备租约。要么等它 `serial_close`,要么 `serial_create({path, takeover:true})` 夺取。只读不受影响。 |
| 插件装不上 / 被当 npm 包 | 检查 path spec 格式(见第 1 节),用绝对路径最稳 |
| 安装时 `incorrect peer dependency "solid-js@1.9.10"` | 无害,这是 opencode TUI 固定的版本 |
