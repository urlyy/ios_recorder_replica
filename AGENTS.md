# AGENTS.md

面向在本仓库继续开发的 AI Agent 与工程师的说明。README.md 面向使用者，本文件面向开发者，
描述架构、约定和验证流程。改动代码后，请同步更新受影响的 README.md 与本文件，保持文档一致。

## 项目定位

纯静态网页，复刻 **iPhone 15 Pro、iOS 26.6.1「语音备忘录」录音播放界面**。
无构建步骤、无框架、无外部网络依赖（图标为本地 `icons.js`，字体走系统字体栈）。
目标部署环境为 Cloudflare Pages 等静态托管，任何改动都不得引入运行时外部请求或打包工具。

## 目录结构

```
index.html              页面结构（状态栏、灵动岛、录音面板、辅助栏）
style.css               全部样式，含灵动岛动画、响应式断点、辅助栏与字体提示
app.js                  全部逻辑：音频加载、波形生成/绘制、播放控制、跳转、辅助栏、字体探测
icons.js                Lucide 图标本地副本（体积大，勿手改）
record/                 默认音频，当前为 record/主要是想邀请您.m4a
assets/1.png, 2.png     iOS 原生截图（播放/暂停状态），样式核对基准
scripts/verify-player.cjs  Playwright 回归脚本
README.md               面向用户的说明
AGENTS.md               本文件
.gitignore              忽略 .vscode 与 .DS_Store
```

## 运行与验证

本地预览（`file://` 会因浏览器限制无法 `fetch()` 解码音频，必须走 HTTP）：

```bash
python3 -m http.server 8080 --directory .
# 浏览器打开 http://127.0.0.1:8080
```

回归脚本（需 Node.js、Playwright、Chrome）：

```bash
# 先启动上面的 HTTP 服务，再运行：
node scripts/verify-player.cjs
# 可选环境变量：
#   BASE_URL           默认 http://127.0.0.1:8080
#   PLAYWRIGHT_MODULE  当 playwright 未装在项目内时，指定已有模块的绝对路径
```

脚本通过时打印一行 `PASS: ...` 摘要。**任何行为改动都必须让该脚本继续通过**；
新增功能时应在脚本里补充对应断言，而不是放宽已有断言。脚本用内存中合成的 WAV 拦截音频请求，
不依赖 `record/` 下的真实文件。

## app.js 架构要点

- **配置**：顶部 `RECORDING`（`src`/`time`/`title`/`date`/`duration`）与 `GITHUB_URL` 两个常量是仅有的配置入口。
  `title`/`date` 为纯展示文本；`duration` 为展示的总时长文本，留空则从音频元数据自动计算；
  `time` 是状态栏时钟起点（24 小时制），由 `updateStatusClock` 按 `audio.currentTime` 递增。
- **波形生成** `generateWaveform`：用 Web Audio `decodeAudioData` 解码，按 `peaksPerSecond`(25) 取振幅包络峰值，
  只在加载音频时生成一次。绘制颜色固定 `waveformColor` (#080808)，**播放/暂停不得改变波形形状或颜色**。
- **绘制** `draw`：播放线居中，波形随 `audio.currentTime` 横向滚动，`pixelsPerSecond`(100) 决定横向比例。
- **播放控制**：`togglePlayback`（播放/暂停）、`skip(±15)`（后退/快进，经 `seekTo` 在 0～`duration` 收敛）。
- **拖动跳转**：canvas 的 pointer 事件，拖动时暂停、松开后按 `resumeAfterDrag` 恢复。
- **可用状态** `renderPlay`：`play`/`back`/`forward` 三个按钮的 `disabled` 由 `loading || !duration || audio.error` 统一决定。
- **辅助栏** `setupHelperBar`：位于 `.screen` 之外，**只有 `pointermove` 会唤出**，约 0.5 秒后自动隐藏；
  上传只调用 `loadRecording(blob)` 换音频与波形，**不修改标题、日期等文本**，且用内存 object URL，不发网络请求。
  「隐藏」按钮把 `dismissed` 置真，本次会话不再唤出（含 `pointermove`），刷新即恢复（不持久化）。
- **字体探测** `notifyFontFallback`：仅在缺少苹方(`PingFang SC`)的设备弹出一次自动消失的提示。
- 生命周期：`pagehide` 时回收 object URL；`window.generateWaveform` 仅为测试暴露。

## 硬性约束（改动时勿破坏）

- 零外部依赖、零构建：不引入 CDN、npm 运行时依赖、打包器或 webfont。
- 状态栏时间以 `RECORDING.time`（默认 `16:17`）为起点、24 小时制、随播放进度递增；电量固定 `78`，电池数字色 `#c7c7c7`（对照 `assets` 截图取色）。
- 灵动岛始终显示，红点仅在 `#b92f28`↔`#ff453a` 间做 1.8s 呼吸、尺寸固定 12px、位置不漂移，
  且与音频/波形状态无关；`prefers-reduced-motion` 下保留静态红点。
- 仅播放/暂停、后退/快进 15 秒、波形拖动、辅助栏两个按钮可交互；更多、完成、转写、替换、设置保持 `disabled`。
- 不采集麦克风、不实际录屏、不覆盖或写回音频文件。
- 页面聚焦不显示蓝色 outline（`button:focus{outline:none}`）；空格等键盘操作仍应能触发默认按钮行为。
- 字体依赖系统字体栈，不打包苹方/SF（版权原因）；跨平台差异属预期，靠运行时提示告知用户。

## 样式与响应式约定

- 单一 `style.css`，无预处理器。颜色/尺寸多为字面量并对照 `assets` 截图，改动请同步核对截图。
- 响应式断点：`max-width:374px`（窄屏）与 `max-height:760px`（矮屏），另有 `max-width:430px` 调整辅助栏布局。
- 页面外围 `#e7ebef` 与手机顶部 `#d0d0ce` 需保持可辨识边界，勿调成同色。

## 文档一致性

修改功能后，务必检查并同步：
1. README.md 顶部概述、「音频使用」列表、「样式核对」表、「验证范围」段落。
2. 本文件的架构要点与硬性约束。
3. `scripts/verify-player.cjs` 的断言。
三者与实现应始终一致；不一致优先以 `git diff` 反映的实时代码为准。
