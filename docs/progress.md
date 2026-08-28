# 项目进度

## 当前有效结构基线（2026-06-15）

本节是当前有效结构；下方较早记录保留时间线价值。若旧记录与本节冲突，以本节为准。

- 系统最上层是 `Thread`，不新增单独项目实体
- 设置里的“预设项目”只是常用工作区目录别名，保存 `name + folder`，不改变 `Thread/Post/Task/Run` 底层模型
- Kanban 是当前工作面，按 Ready / WIP / Review / Done 管理线程工作卡片
- Backlog 和 Archive 是独立浏览入口，不作为 Kanban 列展示；Backlog 展示所有 Ready 任务，Archive 展示所有 Done 任务
- 发布任务保留弹窗式入口；设置、批量导入、Backlog 和 Archive 通过左侧导航切换为右侧主体页面
- “发布任务 / 新建线程”是同一个入口；创建线程时同时填写线程名称、任务 Role、本地文件夹和根任务
- 发布任务和批量导入可以从预设项目下拉框选择工作区目录；提交时仍写入 `thread.folder`
- 预设项目保存各自的 Role 初始化字段；只有 thread 记录了 `presetProjectId` 时，首次启动才会追加对应项目和 role 的字段
- 设置保存可编辑的线程初始化基础 Prompt；它只加入每个线程的首次 Codex run，回复 run 不重复加入
- Kanban 卡片和任务库卡片显示对应预设项目
- 创建线程后创建 queued run，状态进入 Ready；Ready 栏默认显示最近 10 条和手动显示项
- Done 栏默认显示最近 10 条和手动显示项；Archive 仍可浏览全部 Done
- 拖入 WIP 并确认后才启动对应 run
- 自动模式已接入：开启时立即检查一次 Ready 栏，之后按设置中的 1 到 10 分钟间隔循环检查，默认间隔为 5 分钟；当 WIP 低于并发上限时自动把 Ready 栏中的 queued run 补入 WIP，不会在同一轮扫描 Backlog 全量
- worker 支持 1 到 5 个 Codex run 并发执行，默认并发为 5，并在服务启动时恢复 WIP 中仍为 queued 的 run
- Codex 完成后卡片进入 Review，人工确认后进入 Done
- Review/Done 不通过时，先在单卡片内回复修改意见，再拖回 WIP 启动下一轮
- 一个 thread 对应一个任务和一张工作卡片
- 单卡片工作区只展示当前 thread，底部输入栏只用于回复当前 thread
- 用户回复当前 thread 时创建同一 task 下的新 queued run，但不自动启动；再次启动时会通过 app-server thread resume 续接上一轮 Codex 线程
- Codex 执行路径只保留本地 `codex app-server`，不保留 `codex exec --json`
- Codex E2E 测试真实调用 Codex app-server，不使用测试替身
- worker 初始 ACK 与“Codex 已启动”进展合并为单条 `ack`
- `progress` 只用于真正有信息增量的阶段更新
- Codex 最终结果直接写入 `result` 回帖，不设置独立 artifacts 区域
- 运行计时、完成耗时、heartbeat、最近事件和完成状态跟随对应 Codex 回帖展示，不在 thread 顶部放大块状态面板
- 设置访问密码后启用登录保护；未登录不能访问线程、目录、任务心跳、健康检查或 SSE
- 登录账户保存到 MongoDB `accounts` 集合，`.env` 只用于 seed / 恢复管理员账户

## 2026-05-01 进度记录（历史快照）

### 当时状态

项目目前处于第一版实现阶段。

当前已确认的进度：

- 第一版只实现了发帖与回帖功能
- 当前版本尚未经过测试

### 当时完成项

- 已完成项目方向、交互模式和技术架构的文档整理
- 已确定产品形态为“短消息驱动的 Agent 工作协议”
- 已确定主数据库使用 `MongoDB`
- 已完成第一版发帖与回帖能力的实现

### 当时未完成项

- 尚未对第一版发帖与回帖流程进行测试
- 当时尚未确认任务标准化、运行状态流转、artifact 挂载等完整执行链路；当前结构已改为 Codex 结果直接写入 `result` 回帖
- 与本地 Codex worker 的完整联动能力仍需后续继续推进和验证

### 当时风险与注意事项

- 由于尚未测试，现阶段实现状态只能视为“已开发，未验证”
- 发帖和回帖流程是否稳定、数据是否正确落库、前端交互是否完整，仍需通过实际测试确认

### 建议的下一步

1. 先对第一版发帖与回帖主流程进行基础测试
2. 确认 `MongoDB` 写入、读取和 thread 展示是否正常
3. 再继续补齐任务执行链路与本地 Codex 联动

## 2026-05-19 进度记录

### 当前状态

项目执行桥接层已从旧的一次性 JSONL 执行进程切换为本地 `codex app-server` 协议。

当前已确认的进度：

- 真实 Codex 执行路径只保留 app-server runner
- app-server runner 会创建 Codex thread/turn，并监听通知事件
- `runs.codexSessionRef` 开始记录 app-server thread/turn 关联
- worker 继续负责把 Codex 事件、结果、失败状态写回 MongoDB
- 测试改为通过真实 Codex app-server 调用，不再使用测试替身

### 当前完成项

- 已移除旧的一次性 JSONL 执行路径
- 已移除测试替身 runner 配置
- 已新增 app-server JSON-RPC runner
- 已把 Codex app-server 通知落库为 `codex_event`
- 已更新 README 中的运行和测试说明

### 当前风险与注意事项

- `codex app-server` 目前在 CLI 中仍标记为 experimental
- 真实 Codex 集成测试依赖本机 Codex 登录状态、网络和模型可用性
- app-server 会加载本机 Codex 配置、插件和 MCP，测试耗时会高于旧的替身测试

### 建议的下一步

1. 基于真实 app-server 路径验证一次完整 UI 发帖闭环
2. 将用户后续回帖映射到 `turn/steer` 或新 turn
3. 增加取消 run 能力，对应 `turn/interrupt`

## 2026-05-19 线程管理更新（已被当前流程取代）

### 当时状态

系统曾阶段性调整为按 thread 组织，用户需要先选择本地目录并创建线程，然后才能在线程内发布任务。该记录是历史阶段，不代表当前操作流程。

该方向随后继续收敛为当前的 thread 顶层流程，并明确“新建线程 = 发布任务”。

### 当时完成项

- `threads` 增加 `folder` 和 `name` 字段
- 新增独立的线程创建接口 `POST /api/threads`
- 新增本地目录浏览接口 `GET /api/local-directories`
- 当时发布任务曾改为 `POST /api/threads/:id/posts`
- 新增任务心跳接口 `GET /api/tasks/:id/heartbeat`，用于前端轮询未完成任务状态
- 前端左侧为线程导航栏，按文件夹分组展示已有 thread
- 当时前端右侧在未选中线程时只显示创建线程流程；该流程后来被“创建线程时直接发布根任务”取代
- 前端在线程详情中展示任务运行状态，并对未完成任务定时心跳查询
- Codex runner 已改为使用线程文件夹作为 cwd，避免业务任务误写 Harness 自身源码

### 当时风险与注意事项

- 旧数据兼容逻辑已移除；当前运行时按新结构读取 thread/task/run
- 当前线程内再次发布任务仍按新的 root task/run 处理，后续需要继续细化多任务 thread 的追加语义
- 当前心跳只做可观测状态提示，不会自动取消或恢复后端任务

## 2026-05-19 回到线程顶层设计

### 当前状态

最新产品层级重新确定为 `Thread -> Posts / Runs`：

- `Thread` 是系统最上层工作单位
- 每个 thread 对应一个任务和一张工作卡片
- 左侧导航显示已有 thread
- 左侧“新建线程”就是“发布任务”
- 创建 thread 时需要选择本地文件夹、设定线程名称、填写根任务
- 右侧工作区展示当前 thread
- 右侧底部固定回复输入栏，用于继续当前任务
- 每条关键回复都应带状态，因为每条回复代表当前任务的一次状态推进

### 当前完成项

- 已将 [docs/README.md](README.md) 更新为 thread 顶层结构
- 已将 [docs/design-overview.md](design-overview.md) 更新为“新建线程 = 发布任务”的产品模型
- 已将 [docs/technical-architecture.md](technical-architecture.md) 更新为 `threads/posts/tasks/runs/events` 的建模方向
- 已将根 [README.md](../README.md) 的当前闭环描述同步为线程工作区
- 已将 `POST /api/threads` 改为一次性创建 thread、根任务 post、task、run；当前最新流程改为进入 Ready，不立即入队执行
- 已新增独立 `boardStage`，以 Ready / WIP / Review / Done 管理线程工作卡片
- 已新增 `boardDisplay=auto|shown|hidden`，用于保存 Ready/Done 是否显示在看板栏的偏好
- 已将 Backlog 设计为所有 Ready 任务的浏览入口，Ready 栏是其显示子集
- 已将 Archive 设计为所有 Done 任务的浏览入口，Done 栏是其显示子集
- 已新增 Harness 自定义业务任务号 `publicTaskId`，MongoDB 上建立唯一索引；Kanban 卡片、任务库和详情页均显示“任务ID”，API 的 `/api/threads/:id` 系列接口可用该业务任务号定位线程
- 已新增 `PATCH /api/threads/:id/board-stage`，拖入 WIP 并确认后才入队执行
- 已新增 `POST /api/threads/:id/replies`，用于右侧工作区回复当前线程
- 已将前端左侧入口改为“发布任务”，创建视图包含线程名称、本地文件夹和根任务
- 已将右侧工作区输入栏移动到底部，并改为“回复当前线程”
- 已为关键 post 增加 `status` 和 `runId`，前端可在回复流中展示回复级状态和当前 heartbeat
- 已移除右侧 artifacts 区域，Codex 最终结果直接显示在 `result` 回帖中
- 已移除长结果自动写 artifact 的 worker 分支
- 已将 worker 初始 ACK 与“Codex 已启动”进展合并为单条 `ack` 回帖，避免模板化进展刷屏
- 已将大块 heartbeat 状态从 thread 顶部移动到对应 Codex 回帖后面
- 已在回帖状态块中增加运行中计时和完成后耗时统计
- 已增加单用户账户密码登录机制：`/api/auth/me`、`/api/auth/login`、`/api/auth/logout`
- 已新增 MongoDB `accounts` 集合和唯一用户名索引
- 已将 `.env` 中的管理员账号和密码哈希作为启动 bootstrap，写入/更新 `accounts`
- 已将除 `/api/auth/*` 外的 API 和 SSE 纳入 HttpOnly Cookie 会话校验
- 已增加登录失败限流，默认 5 分钟 8 次
- 已增加 `SERVER_HOST` 公网监听保护：未启用登录时禁止直接绑定公网地址

### 当前风险与注意事项

- `POST /api/threads/:id/posts` 旧入口已移除；当前回复入口是 `POST /api/threads/:id/replies`
- 用户回复当前线程时创建同一 task 下的新 run；再次启动时通过 app-server `thread/resume` 继续原 Codex 线程
- 旧数据兼容逻辑已移除；当前回复级状态依赖新结构中的 `post.status` 和 `post.runId`
- 取消 run 仍需接入 Codex `turn/interrupt`
- 公网反向代理即使后端仍监听 `127.0.0.1`，也必须显式配置登录密码、稳定 `HARNESS_SESSION_SECRET` 和 HTTPS 下的 Secure Cookie
