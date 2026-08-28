# 历史记录

## 当前有效结构速记（2026-05-19）

本文件是历史记录，较早章节会保留当时的阶段性结论。当前有效结构如下；如果旧章节与本节冲突，以本节为准。

- `Thread` 是系统最上层工作单位，不新增单独项目实体
- 左侧“发布任务 / 新建线程”创建一个 thread、根任务 post、task 和 run
- 一个 thread 对应一个任务和一张工作卡片
- 发布任务保留弹窗入口；设置、批量导入、Backlog 和 Archive 通过左侧导航切换为右侧主体页面
- 预设项目只作为目录别名和项目级 Role 初始化字段容器；卡片显示所属预设项目
- 线程初始化基础 Prompt 在设置中可编辑，只对线程首次 Codex run 生效
- 右侧工作区只展示当前 thread，底部输入栏只用于回复当前 thread
- Codex 执行路径只保留本地 `codex app-server`
- Codex 最终结果直接写入 `result` 回帖，不再设置独立 artifacts 区域
- worker 初始 ACK 与启动进展合并为单条 `ack`
- 运行计时、完成耗时、heartbeat、最近事件和完成状态跟随对应 Codex 回帖展示，不在 thread 顶部放大块状态面板
- 登录机制已经作为公网暴露前置保护：设置访问密码后，除 `/api/auth/*` 外的 API 和 SSE 都需要会话 Cookie
- 登录账户保存到 MongoDB `accounts` 集合，`.env` 只作为管理员 bootstrap / 恢复配置

## 2026-04-27 当前线程总结

### 1. 项目定义

本项目被定义为一套“短消息驱动的 Agent 工作协议”，而不是一个只改变外观的聊天工具。

核心交互共识如下：

- 用户用 500 字以内的短消息发起工作
- 系统把消息标准化成结构化任务
- Agent 通过 thread 式回帖推进执行
- 回帖类型以 `ack`、`progress`、`question`、`result`、`failure` 为主
- 当时曾考虑大输出通过 artifact 挂载；当前已改为直接写入 `result` 回帖，不设置独立 artifacts 区域

### 2. 500 字限制的设计意图

本线程明确了 500 字限制不是为了“更短”，而是为了把单次沟通约束成一个清晰的小决策包。

达成的关键理解：

- 500 字帖子不是缩水版 spec，而是“当前有效指令”
- thread 不是聊天记录，而是滚动演进的规格
- 这种方式适合边做边改，替代大量早期和中期的详细 spec 沟通
- 它比聊天更正式，但比正式文档更轻，更适合与 Agent 做同步和异步协作

### 3. Agent 行为原则

线程中达成的 Agent 协作原则包括：

- 优先执行任务中已经明确的部分
- 在继续推进时显式暴露自己的假设
- 只在被阻塞或猜测代价过高时追问
- 只有在状态变化、达到里程碑、需要澄清或形成可交付产物时才回帖

这意味着 Agent 的回帖不能只是拟人化聊天，而必须承载明确的状态语义。

### 4. 产品设计层结论

设计层面已经整理成单独文档，当前共识包括：

- `post` 是任务触发器
- `task` 是标准化后的工作对象
- `thread` 是滚动演进的规格容器
- `run` 表示某个任务的一次执行过程
- 当时曾引入 `artifact` 表示执行产物；当前产品不设置独立 artifacts 区域

同时，thread 界面需要强调这些信息：

- 顶部状态标签
- 当前版本卡片
- Agent 关键里程碑
- 紧凑的回帖时间线
- 当时的交付产物区；当前已移除，交付集中在 `result` 回帖

### 5. 技术实现层结论

技术层面确定采用本地 Web 应用形态：

- 用户在本地前端发布类似社交动态的任务帖子
- 每条消息进入数据库
- 后台 worker 调用本地 Codex 执行任务
- 执行结果以回帖形式返回到原始工作 thread 下

讨论中明确拆分的核心对象包括：

- `threads`
- `posts`
- `tasks`
- `task_versions`
- `runs`
- `events`
- 当时的 `artifacts`；当前不设置独立 artifacts 区域
- `context_refs`

### 6. 数据库决策

本线程后半段做出了明确数据库决策：

- 主数据库坚持使用 `MongoDB`

在这个前提下，技术方案已经调整为以 `MongoDB` 为主库，并写入如下关键约束：

- 采用多集合建模，而不是把整个 thread 嵌进一条大文档
- 当时建议 `posts`、`runs`、`events`、`artifacts` 等 append-heavy 数据拆成独立集合；当前 UI 不设置独立 artifacts 区域
- 本地 `MongoDB` 建议以单节点副本集方式运行
- 关键写路径使用事务
- 前端实时更新先用 `SSE`
- 后续可基于 `change stream` 增强多进程下的实时同步
- Codex 只输出结构化结果，不直接写数据库

### 7. 已产出的文档

本线程中已经落盘的文档包括：

- [docs/README.md](README.md)
- [docs/design-overview.md](design-overview.md)
- [docs/technical-architecture.md](technical-architecture.md)

并且已统一要求：

- 项目中的文档内容使用中文

### 8. 当前建议的下一步

基于这条线程，后续更自然的推进顺序是：

1. 把 `MongoDB` 集合设计收敛成实际 schema 和索引
2. 先实现“发帖入库 -> 生成 `ack` 回帖 -> thread 刷新”的最小闭环
3. 当时建议再接入本地 Codex worker、artifact 落盘和更完整的执行链路；当前已改为 Codex 结果直接写入 `result` 回帖

## 2026-05-19 当前线程总结

### 1. Codex 执行形态调整

本线程确认：随着 Codex CLI 增加本地 `codex app-server` 形态，Harness 不再保留旧的一次性 JSONL 进程执行方式。

新的执行共识：

- 真实执行路径只使用 `codex app-server`
- 当时 Harness 仍然保留自己的 `threads/posts/tasks/runs/events/artifacts` 产品模型；后续最新结构已移除独立 artifacts 区域
- Codex app-server 的 thread/turn 作为底层 Agent runtime 会话
- `runs.codexSessionRef` 用来记录 Harness run 与 Codex thread/turn 的关联

### 2. 测试策略调整

本线程进一步确认：测试不再保留替身 runner。需要验证执行链路时，测试直接调用真实 Codex app-server。

这意味着测试依赖：

- 本机 Codex CLI 可用
- 当前账号已登录
- 网络和模型服务可用

### 3. 后续演进方向

app-server 打通后，下一步更自然的能力包括：

1. 用户追加回帖映射到 `turn/steer` 或后续 turn
2. 取消 run 映射到 `turn/interrupt`
3. 更细粒度地把 agent message、plan、command execution、file change 映射成 Harness 事件和回帖

## 2026-05-19 线程管理补充

本线程曾确认：Harness 的系统最上层先按 thread 分割，post 只是 thread 内部的消息。

当时线程管理共识：

- 创建 thread 时需要能设定线程文件夹
- 创建 thread 时需要能设定线程名称
- 线程文件夹必须来自本地目录选择
- 前端一级导航按线程文件夹分组展示 thread
- 未创建或未选中 thread 前，右侧区域只呈现创建线程流程
- 只有创建或选中 thread 后，才出现发布任务入口
- 旧的自动标题仍可作为兼容回退，但不再是唯一线程命名来源

## 2026-05-19 回到线程顶层设计

本线程再次修正产品边界：Harness 以 thread 作为系统最上层工作单位。

最新共识：

- `Thread` 是左侧导航单位
- `Thread` 是任务本体，不只是项目下的讨论容器
- 每个 thread 对应一张工作卡片
- 左侧“新建线程”就是“发布任务”
- 新建线程时要选择本地文件夹、设定线程名称、填写根任务
- 右侧工作区展示当前 thread 的根任务、Codex 回复、用户回复和状态
- 右侧底部固定输入栏只用于回复当前 thread
- 每条关键回复都应该带状态，因为每条回复代表当前任务的一次状态推进
- Codex 返回的结果直接显示在 `result` 回帖中，不再设置独立 artifacts 区域
- worker 的初始 ACK 与“Codex 已启动”进展应合并成一条回帖，后续 `progress` 只用于真正有信息增量的阶段更新
- 运行计时、完成耗时、heartbeat、最近事件和完成状态跟随对应 Codex 回帖展示，不在 thread 顶部放大块状态面板
- 因为 Harness 能通过 Web 驱动本地 Codex，公网暴露前必须启用登录保护；当前实现是单用户账户密码登录、HttpOnly Cookie 会话和 API/SSE 统一鉴权

因此，当前产品模型为：

```text
Thread / Work Card
  Root Task Post
  Codex Replies
  User Replies
  Reply-level Status / Heartbeat
```

技术上，Codex run 的工作目录继续来自 `thread.folder`。Harness 的 `thread` 与 Codex app-server 的底层 thread/turn 不是同一个数据库对象，但可以通过 `runs.codexSessionRef` 建立关联。

## 2026-06-15 Kanban 任务管理补充

后续确认：底层结构不变，仍然是 `Thread / Work Card -> Posts -> Runs`，但任务管理视图改为 Kanban。

最新共识：

- Kanban 只管理 task/thread 工作卡片的人工阶段，不新增单独项目实体
- 每个 thread 仍然是一张工作卡片和一条完整回复流
- 看板阶段固定为 Ready、WIP、Review、Done
- 阶段使用独立 `thread.boardStage` 表示，不和 `thread.status`、`run.status`、`post.status` 混用
- 发布任务只创建 Ready 卡片和 queued run，不立即执行
- 用户把卡片拖入 WIP 并确认后，才启动 Codex worker
- Codex 成功完成后卡片自动进入 Review
- 人工检查通过后将卡片移动到 Done
- 不通过时，用户先在单卡片内回复修改意见，再拖回 WIP 启动下一轮

因此，当前产品模型可以理解为：

```text
Kanban Board
  Ready / WIP / Review / Done columns
    Thread / Work Card
      Root Task Post
      Codex Replies
      User Replies
      Runs / Reply-level Status / Heartbeat
```

## 2026-06-15 Backlog / Archive 任务库补充

后续确认：Kanban 四列只代表当前工作面，不能长期承载大量待启动或已完成任务。

最新共识：

- Backlog 不是新的 `boardStage`，而是所有 Ready 任务的全量浏览入口
- Archive 不是新的 `boardStage`，而是所有 Done 任务的全量浏览入口
- Ready 栏默认显示最近的 10 条待启动任务，且保留用户手动设置的显示项
- 用户可以在 Backlog 浏览列表中手动把 Ready 任务显示到 Ready 栏，这个变更持久化到 `thread.boardDisplay`
- Done 栏默认显示最近的 10 条完成任务，且保留用户手动设置的显示项
- WIP 和 Review 仍然完整显示，是当前真正需要处理的执行区和人工检查区

因此，当前任务管理模型变为：

```text
Task Libraries
  Backlog = all Ready threads
  Archive = all Done threads

Kanban Board
  Ready / WIP / Review / Done columns
    Thread / Work Card
```
