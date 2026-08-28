# Harness CLI Agent 协议

这份文档不是给人类交互式使用的教程，而是给其他 Agent 使用 Harness CLI 时的稳定接入说明。

目标是让 Agent 能在**不直接访问 MongoDB** 的前提下：

- 创建单个任务
- 批量导入任务
- 启动任务
- 在线程内回复
- 查询任务状态

## 1. 基本原则

### 1.1 不要直接写数据库

Agent 不应直接写 `MongoDB`。Harness 的业务规则在服务端 API 中，而不在数据库 schema 中。

必须通过以下入口之一调用：

- `./bin/harness ...`
- `npm run harness -- ...`

### 1.2 优先使用 `--json`

CLI 同时支持文本输出和 JSON 输出。

Agent 调用时应始终带上：

```bash
--json
```

这样可以避免解析人类友好的文本输出。

### 1.3 任务默认语义

- `Thread` 是最上层任务对象
- `publicTaskId` 是人类可读业务任务号，例如 `HT-20260616-0ABC123`
- 任务创建后默认进入 `Ready`
- 只有执行 `task start` 后，任务才会进入 `WIP` 并真正启动 Codex

## 2. 鉴权

Harness CLI 面向 Agent 时使用 Bearer token，不使用浏览器 Cookie。

服务端需要配置：

```bash
HARNESS_API_TOKEN=replace-with-a-long-random-token
HARNESS_API_TOKEN_NAME=codex-cli
```

CLI 读取方式：

1. 优先读取命令行 `--token`
2. 未提供时读取环境变量 `HARNESS_API_TOKEN`

可选环境变量：

```bash
HARNESS_API_BASE_URL=http://127.0.0.1:4317
HARNESS_API_TOKEN=replace-with-a-long-random-token
```

## 3. 命令入口

查看命令帮助：

```bash
./bin/harness --help
```

当前支持的命令：

- `task create`
- `task import`
- `task list`
- `task show`
- `task start`
- `task reply`
- `task heartbeat`
- `settings get`，返回自动模式、并发、线程命名前缀、线程初始化基础 Prompt 和预设项目配置

当前**不支持**：

- `settings set`
- `service-account create`
- `service-account rotate`
- `service-account revoke`

## 4. 单任务创建

命令：

```bash
./bin/harness task create \
  --folder /abs/project/path \
  --name "实现登录页" \
  --role se \
  --body "实现邮箱登录页和基础校验" \
  --external-task-key US-101 \
  --token "$HARNESS_API_TOKEN" \
  --json
```

字段说明：

- `--folder`：线程工作目录，必须是绝对路径
- `--preset-project-id`：可选；绑定设置中的预设项目，卡片会显示该项目，首次启动时才会使用该项目下的 Role 初始化字段
- `--name`：任务卡片名称
- `--role`：`se | art | design | music | general`
- `--body`：任务正文
- `--external-task-key`：外部幂等键，建议始终提供
- `--board-display`：可选，`auto | shown | hidden`

返回 JSON：

```json
{
  "threadId": "684f1d9b...",
  "publicTaskId": "HT-20260616-0ABC123",
  "postId": "684f1d9b...",
  "taskId": "684f1d9b...",
  "runId": "684f1d9b...",
  "created": true
}
```

语义：

- `created=true`：新建成功
- `created=false`：命中已有任务，没有重复建卡

## 5. 批量导入

### 5.1 输入格式

批量导入使用 `JSONL`，每行一个 JSON 对象：

```jsonl
{"name":"登录页","role":"se","body":"实现邮箱登录页","externalTaskKey":"US-101"}
{"name":"主界面背景音乐","role":"music","body":"制作 1 分钟循环背景音乐","externalTaskKey":"MUSIC-001"}
```

每行字段：

- `name`：必填
- `role`：可选，默认 `general`
- `body`：必填
- `externalTaskKey`：建议填写

### 5.2 导入命令

```bash
./bin/harness task import \
  --file ./tasks.jsonl \
  --folder /abs/project/path \
  --preset-project-id example-app \
  --token "$HARNESS_API_TOKEN" \
  --json
```

CLI 默认会把导入任务创建为：

- `boardStage = ready`
- `boardDisplay = hidden`

也就是：

- 逻辑上是 Ready
- 显示上进入 Backlog 浏览

如果传入 `--preset-project-id`，导入的所有任务都会绑定同一个预设项目；不传则不会追加任何 Role 初始化字段。

这可以避免一次性把大量任务塞满 Ready 栏。

返回 JSON：

```json
{
  "createdCount": 2,
  "existingCount": 1,
  "items": [
    {
      "threadId": "684f1d9b...",
      "publicTaskId": "HT-20260616-0ABC123",
      "postId": "684f1d9b...",
      "taskId": "684f1d9b...",
      "runId": "684f1d9b...",
      "created": true,
      "name": "登录页",
      "role": "se",
      "externalTaskKey": "US-101"
    }
  ]
}
```

## 6. 幂等规则

### 6.1 幂等范围

`externalTaskKey` 的幂等范围是：

- `service account name`
- `externalTaskKey`

也就是说，Harness 当前按下面的组合去重：

- `externalTaskSource = HARNESS_API_TOKEN_NAME`
- `externalTaskKey`

结果：

- 同一个服务账号，重复提交同一个 `externalTaskKey`，会返回已有卡片
- 不同服务账号，可以使用相同 `externalTaskKey`

### 6.2 Agent 建议

对于来自外部系统的任务，Agent 应始终提供稳定的 `externalTaskKey`，例如：

- Jira issue key
- User story key
- 自己生成的 deterministic key

如果不提供这个字段，Harness 会每次都创建新任务。

## 7. 查询命令

### 7.1 列表

```bash
./bin/harness task list --token "$HARNESS_API_TOKEN" --json
```

返回值是 `ThreadListItemDto[]`。

最关键字段：

- `id`
- `publicTaskId`
- `name`
- `role`
- `folder`
- `boardStage`
- `boardDisplay`
- `status`
- `externalTaskSource`
- `externalTaskKey`

### 7.2 详情

```bash
./bin/harness task show HT-20260616-0ABC123 --token "$HARNESS_API_TOKEN" --json
```

返回值是 `ThreadDetailDto`，包含：

- `thread`
- `posts`
- `task`
- `run`
- `versions`
- `artifacts`

如果 Agent 要继续推进一个已有线程，通常先读 `task show`。

### 7.3 心跳

```bash
./bin/harness task heartbeat HT-20260616-0ABC123 --token "$HARNESS_API_TOKEN" --json
```

返回值是 `TaskHeartbeatDto`。

关键字段：

- `state`
- `label`
- `isTerminal`
- `taskStatus`
- `runStatus`
- `runPhase`
- `activeForMs`
- `inactiveForMs`

常见状态：

- `queued`
- `working`
- `long_running`
- `completed`
- `failed`
- `cancelled`

## 8. 启动与回复

### 8.1 启动 Ready 任务

```bash
./bin/harness task start HT-20260616-0ABC123 --token "$HARNESS_API_TOKEN" --json
```

这个命令等价于把卡片从 `Ready` 拖到 `WIP` 并确认。

成功后：

- `thread.boardStage = wip`
- worker 会入队
- Codex 真正开始执行

### 8.2 在线程里回复

```bash
./bin/harness task reply HT-20260616-0ABC123 \
  --body "继续下一步，补齐移动端样式" \
  --token "$HARNESS_API_TOKEN" \
  --json
```

语义：

- 在当前线程下创建一条用户回复
- 生成新的 queued run
- 任务重新回到 `Ready`
- 后续需要再次执行 `task start`

这和当前产品工作流一致：**回复不等于自动开工**。

## 9. 推荐工作流

### 9.1 批量拆任务

适合 Codex 或其他 Planner Agent：

1. 生成 `tasks.jsonl`
2. 执行 `task import`
3. 保存返回的 `publicTaskId`
4. 根据规则选择部分任务再执行 `task start`

### 9.2 结果检查后继续推进

1. `task show`
2. 读取最近 `result` 回帖
3. 如果需要修改，执行 `task reply`
4. 再执行 `task start`

### 9.3 轮询等待完成

1. `task start`
2. 定时调用 `task heartbeat`
3. 直到 `isTerminal=true`
4. 再用 `task show` 拉最终线程内容

## 10. 错误与重试

CLI 出错时返回非 0 exit code，并把服务端错误消息写到 `stderr`。

Agent 应这样处理：

### 可重试

- 网络失败
- 5xx
- 超时

### 不应盲重试

- 400：输入格式错误
- 401：token 缺失或无效
- 404：任务不存在
- 409：状态冲突，例如任务正在运行，或当前阶段不允许直接启动

### 幂等重试建议

- `task create` / `task import`：带 `externalTaskKey` 时可以安全重试
- `task reply`：默认不是幂等操作，不要盲重试
- `task start`：重试前先查 `task heartbeat` 或 `task show`

## 11. 当前限制

当前 CLI v1 的已知限制：

- 没有 `settings set`
- 没有 service account 管理命令
- 没有 `task cancel`
- 没有 `task archive` / `task display`
- 没有 JSON Schema 文件导出

## 12. 最佳实践

给 Agent 的建议：

1. 始终使用 `--json`
2. 始终提供 `externalTaskKey`
3. 批量任务优先走 `task import`
4. 大批量任务默认先进 Backlog，不要直接挤 Ready
5. 启动前先确认任务是否真的该进入 `WIP`
6. 回复后记得显式再执行一次 `task start`
