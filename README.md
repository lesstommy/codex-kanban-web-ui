# Tweet-Native AI Harness

[![CI](https://github.com/lesstommy/tweet-native-ai-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/lesstommy/tweet-native-ai-harness/actions/workflows/ci.yml)

一个本地优先的短消息驱动 Agent 工作台。第一阶段已经具备最小真实闭环：

> 当前版本为 `0.1.0-alpha`，面向本地单用户开发环境。项目由社区独立维护，不是 OpenAI 官方产品，也不代表 OpenAI。

- 用户在看板中发布任务，也就是新建线程，状态进入 Ready
- 每个线程绑定本地工作路径，并对应一个任务和一张工作卡片
- Kanban 以 Ready / WIP / Review / Done 管理当前工作面，Backlog / Archive 分别浏览全部 Ready / Done；底层仍是 `Thread -> Posts -> Runs`
- API 写入 MongoDB 多集合模型
- 登录账户写入 MongoDB `accounts` 集合
- 只有把卡片拖入 WIP 并确认后，系统才启动 Codex，并生成合并后的 `ack`
- 用户在右侧工作区底部回复当前线程，用于评价 Codex 回复、补充约束或要求下一步
- 后台 worker 以线程文件夹作为工作目录，通过本地 `codex app-server` 协议启动 Codex thread/turn
- Codex 结果回写到对应线程内部，完成后卡片进入 Review，人工确认后进入 Done
- 前端对未完成任务定时查询 `/api/tasks/:id/heartbeat`，并把工作中、长时间运行、运行计时、完成耗时等状态挂在对应 Codex 回帖后面
- 前端左侧按线程展示，并通过 SSE 接收线程更新
- 设置访问密码后启用登录保护，所有 Codex 操作 API 和 SSE 都需要会话 Cookie

## 本地准备

运行环境：

- Node.js `^20.19.0` 或 `>=22.12.0`
- MongoDB Community 8.x，或其他可用的 MongoDB replica set
- 已安装并登录的 Codex CLI；`codex` 默认从 `PATH` 查找

当前发布流程优先支持 macOS。核心 Node 服务不依赖 Homebrew，但仓库自带的 MongoDB 安装和后台进程脚本使用 Bash 与 macOS/Homebrew 工具链。

验证 Codex CLI：

```bash
codex --version
codex login status
```

macOS 可以通过 Homebrew 安装 MongoDB Community：

```bash
npm run mongo:install
npm run mongo:start
npm run mongo:init
```

如果你已经有 MongoDB，可以直接设置 `.env`：

```bash
cp .env.example .env
```

MongoDB 启动后可以先检查本机依赖：

```bash
npm run doctor
```

## 开发运行

```bash
npm install
npm start
```

默认地址：

- Web: http://127.0.0.1:5173
- API: http://127.0.0.1:4317

`npm start` 会依次执行：

- 启动本地 MongoDB
- 初始化 MongoDB replica set
- 检查 Node、Codex 登录、MongoDB 和本地数据目录
- 构建前端
- 启动 Harness API 和本地预览 Web 服务

开发时需要热更新，可以使用：

```bash
npm run dev
```

如果已经自行准备好 MongoDB，并希望直接运行构建后的本地服务：

```bash
npm run build
npm run serve
```

后台启动：

```bash
npm run start:bg
npm run status
npm run stop
```

后台启动会把 Harness API 和 Web 放到后台运行，日志写入 `.local/logs/harness.log`，pid 写入 `.local/harness.pid`。`npm run stop` 只停止 Harness API/Web，不停止本地 MongoDB。

## CLI / Agent 接入

除了 Web UI，Harness 现在也提供后台 CLI，适合让 Codex 或其他 Agent 批量创建和推进任务。

如果是给其他 Agent 集成，完整协议说明见：

- [CLI Agent 协议](docs/cli-agent.md)

先在服务端配置一个 Bearer token：

```bash
HARNESS_API_TOKEN=replace-with-a-long-random-token
HARNESS_API_TOKEN_NAME=codex-cli
```

服务启动时会把它 upsert 到 MongoDB `service_accounts` 集合。CLI 默认读取同名环境变量，也可以显式传 `--token`。

命令入口：

```bash
./bin/harness --help
# 或
npm run harness -- --help
```

常用命令：

```bash
./bin/harness task create \
  --folder /abs/project/path \
  --preset-project-id example-app \
  --name "实现登录页" \
  --role se \
  --body "实现邮箱登录页和基础校验" \
  --external-task-key US-101 \
  --token "$HARNESS_API_TOKEN"

./bin/harness task import \
  --file ./tasks.jsonl \
  --folder /abs/project/path \
  --preset-project-id example-app \
  --token "$HARNESS_API_TOKEN"

./bin/harness task list --token "$HARNESS_API_TOKEN"
./bin/harness task show HT-20260616-XXXXXXX --token "$HARNESS_API_TOKEN"
./bin/harness task start HT-20260616-XXXXXXX --token "$HARNESS_API_TOKEN"
./bin/harness task reply HT-20260616-XXXXXXX --body "继续下一步" --token "$HARNESS_API_TOKEN"
./bin/harness task heartbeat HT-20260616-XXXXXXX --token "$HARNESS_API_TOKEN"
./bin/harness settings get --token "$HARNESS_API_TOKEN"
```

`task import` 使用 `JSONL`，每行一个任务对象。默认会创建为 `Ready + hidden`，也就是进入 Backlog 浏览，不会直接挤满 Ready 栏：

`--preset-project-id` 是可选参数。传入后任务会记录对应预设项目，卡片上显示项目名，并在首次启动时按该预设项目和任务 role 追加初始化字段；不传则只使用 `--folder`，不会追加 Role 初始化字段。设置中的线程初始化基础 Prompt 也只在首次启动时加入，不会在回复 run 中重复追加。

```jsonl
{"name":"登录页","role":"se","body":"实现邮箱登录页","externalTaskKey":"US-101"}
{"name":"主界面背景音乐","role":"music","body":"制作 1 分钟循环背景音乐","externalTaskKey":"MUSIC-001"}
```

如果同一个 Bearer token 再次提交相同的 `externalTaskKey`，Harness 会命中已有卡片，返回 `created=false`，不会重复建任务。

第一版默认真实调用 Codex app-server。可选配置：

```bash
CODEX_MODEL=gpt-5.5
CODEX_REASONING_EFFORT=low
CODEX_TURN_TIMEOUT_MS=0
CODEX_WORKER_CONCURRENCY=5
```

`CODEX_MODEL` 和 `CODEX_REASONING_EFFORT` 不设置时会使用本机 Codex 配置。
`CODEX_TURN_TIMEOUT_MS=0` 表示不对整个 Codex turn 设置 wall-clock 超时；Harness 只保留 app-server 握手类 RPC 的短超时。需要本地调试超时行为时，才设置为正整数毫秒。
`CODEX_WORKER_CONCURRENCY` 控制本地 worker 并发执行的 Codex run 数量，默认 5，最大值固定封顶为 5。

## 登录与公网暴露

默认服务只监听 `127.0.0.1`，本地开发不强制登录。设置下面任一密码配置后，认证会自动启用：

```bash
HARNESS_AUTH_USERNAME=admin
HARNESS_AUTH_PASSWORD=your-password
HARNESS_SESSION_SECRET=replace-with-a-long-random-secret
```

也可以用 `HARNESS_AUTH_PASSWORD_HASH` 保存 `scrypt$salt$hash` 形式的密码哈希。服务启动时会用这些 bootstrap 配置 upsert MongoDB `accounts` 集合里的管理员账户；运行时登录校验以数据库账户为准。公网或反向代理暴露前必须启用登录；如果把 `SERVER_HOST` 设成 `0.0.0.0`，但没有设置登录密码，服务会拒绝启动。HTTPS 场景建议同时设置：

```bash
HARNESS_COOKIE_SECURE=true
```

登录失败会按客户端地址限流，默认 `HARNESS_LOGIN_MAX_ATTEMPTS=8`、`HARNESS_LOGIN_WINDOW_MS=300000`。

Harness 能浏览本机目录、读取线程目录中的文件，并让 Codex 修改选定工作区。默认只应监听 `127.0.0.1`。远程使用优先通过 SSH、VPN 或零信任网络访问；不要仅依赖密码把服务直接暴露到公网。

## 验证

```bash
npm run lint
npm run build
npm run test
npm audit
```

测试使用 `mongodb-memory-server` 创建临时 replica set，并通过真实 `codex app-server` 调用 Codex。

`npm test` 会运行真实 Codex 端到端用例。GitHub 普通 CI 使用 `npm run test:ci`，只跳过这一项需要本机 Codex 登录的用例，其余 API、数据库和状态流测试照常运行；它没有 fake runner。维护者可以在已登录 Codex 的 macOS self-hosted runner 上手动触发 `Codex E2E` workflow。

版本变化见 [CHANGELOG.md](CHANGELOG.md)。

## License

本项目使用 [Apache License 2.0](LICENSE)。
