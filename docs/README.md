# 文档索引

当前仓库里的文档包括：

- [设计文档](design-overview.md)
- [技术文档](technical-architecture.md)
- [CLI Agent 协议](cli-agent.md)
- [进度记录](progress.md)
- [历史记录](history.md)

## 这套方案的当前定义

这个项目不是“长得像 Twitter 的聊天工具”，而是一套短消息驱动的 Agent 工作协议。最新产品层级回到以 `Thread` 为最上层：

- `Thread` 是系统最上层工作单位
- 每个 `Thread` 对应一个任务、一张工作卡片，以及这项任务下面的完整回复流
- Kanban 是当前工作面，以 Ready / WIP / Review / Done 展示这些工作卡片
- Backlog 和 Archive 是左侧导航打开的右侧主体页面，不作为 Kanban 列展示；分别浏览全部 Ready / Done
- “发布任务”就是创建新的 task thread，状态进入 Ready
- 发布任务保留弹窗入口；设置、批量导入、Backlog 和 Archive 都在右侧主体区域切换页面
- 新建线程时需要设定线程名称和本地线程文件夹
- 点击单张卡片后进入当前线程详情，也就是单卡片视图
- 单卡片视图底部固定回复输入栏，用于继续推进当前线程
- 每条用户回复或 Agent 回复都代表当前任务的一次状态推进
- Codex 回帖正文后面展示对应状态、运行计时、完成耗时、heartbeat、最近事件；线程顶部只保留轻量聚合状态

## 当前最重要的设计判断

- 500 字限制不是为了更短，而是为了把单次沟通约束成一个清晰的小决策包
- 系统最上层按线程分割，不再单独引入项目层
- 设置里的“预设项目”只是常用工作区目录别名；发布任务时选择它后仍然写入 `thread.folder`
- Role 初始化字段挂在预设项目下面；只有选择预设项目创建或导入的任务，首次启动时才会追加对应 role 的初始化字段
- 设置里的线程初始化基础 Prompt 会加入每个线程的首次 Codex run；线程内回复不会重复加入
- 线程与任务绑定：一个线程就是一个任务
- 线程在界面上表现为一张工作卡片；卡片上会显示任务所属的预设项目
- Kanban 只管理卡片阶段，不改变 `Thread/Post/Task/Run` 底层模型
- 发布任务只创建 queued run，不立即启动 Codex
- 拖入 WIP 并确认后才启动 Codex
- Codex 完成后进入 Review，人工确认后进入 Done
- 单卡片视图的输入栏只负责回复当前线程；Review/Done 不通过时，先回复修改意见，再拖回 WIP 启动下一轮
- 根帖子不是完整规格，线程里的回复流才是持续更新的工作定义
- Agent 回复必须有状态语义，不能只是自然语言闲聊
- worker 初始 ACK 与“Codex 已启动”进展合并成一条 `ack` 回帖，固定启动进展不再单独生成 `progress`
- Codex 返回的结果直接显示在对应 `result` 回帖中，不再单独设置 artifacts 区域
- 这是可以驱动本地 Codex 的 Web 前端，公网暴露前必须启用登录保护

## 当前最重要的技术判断

对本地最小可用版本，我更建议：

- `React + Vite` 做本地 Web 前端
- `Fastify` 做本地 API
- `MongoDB` 做主数据库
- `MongoDB Node.js Driver` + `Zod` 做数据访问与校验
- 本地 worker 通过 `codex app-server` 调度 Codex thread/turn
- 用 `SSE` 把状态更新和回帖推回前端
- 设置访问密码后启用单用户登录，除 `/api/auth/*` 外的 API 与 SSE 都依赖 HttpOnly Cookie 会话

在 `MongoDB` 方案下，核心关系是：

- `thread -> posts`
- `thread -> task`
- `task -> runs`
- `run -> events`
- `accounts` 保存登录账户，`.env` 只作为管理员 bootstrap
- `threads.publicTaskId` 是 Harness 自定义的唯一业务任务号，用于 UI 展示、MongoDB 查询和 API 定位，不使用 Mongo `_id` 作为人可读任务编号

所以技术文档里的关键判断是：

- 用多集合建模，不要把整个 thread 嵌成一条大文档
- 本地 `MongoDB` 建议以单节点副本集运行
- 关键写路径用事务
- `posts`、`runs`、`events` 都拆成独立集合
- 实时更新先用 `SSE`，后续可接 `change stream`

## 下一步建议

如果继续往下推进，比较自然的顺序是：

1. 将用户回复更精确地接入 Codex `turn/steer` 或 app-server thread resume
2. 将取消 run 接入 Codex `turn/interrupt`
3. 继续补强安全边界：workspace allowlist、取消 run、审计事件和更细粒度的权限控制
