# Flue 全站文档阅读与 DingBell 适配核对

核对日期：2026-10-08。适用方案：0.2 评审稿。

Flue 适合承担 DingBell 的 Agent 执行、模型与工具调用、提交去重、持久恢复和运行观察。DingBell 应直接复用这些能力，将自有代码集中在公司与店铺权限、客服协作、商品与订单知识、平台发送和业务审计。渠道包不等于完整电商客服连接器；持久执行也不等于对外发送恰好一次。

本文记录逐篇阅读结果，并对影响架构的差异核对源码。它是实施依据，不是已完成集成或通过测试的证明。

## 1. 阅读范围与版本

以 [Getting Started](https://flueframework.com/docs/guide/getting-started/) 为入口，检查站点文档目录，读取每篇正文、表格与代码示例；重复导航不重复计数。覆盖范围是 Flue 的文档站，不包括递归阅读每个外链供应商的全部文档。

| 分组 | 已读独立文章 |
| --- | ---: |
| Guide | 24 |
| API Reference | 10 |
| SDK | 5 |
| CLI | 6 |
| Ecosystem 总览 | 1 |
| Channels | 17 |
| Databases | 8 |
| Deploy | 10 |
| Sandboxes | 10 |
| Tooling | 5 |
| 合计 | 96 |

另读了站点的 `start.md` 入口说明。抓取结果按长度分成 175 段，已全部阅读；这只是阅读检查，不是运行测试。

- `/docs/guide/targets/cloudflare/` 与 `/docs/guide/cloudflare-target/` 内容重复，仅计一篇。
- [SmolVM](https://flueframework.com/docs/ecosystem/sandboxes/smolvm/) 的网页与 Markdown 均返回 404，不能标为已读，也不能据此推荐该集成。
- 排除两个链接解析产生的伪路径：`guide/getting-started/docs/guide/targets/cloudflare/` 与 `ecosystem/tooling/sentry/event.message,/`。
- 源码核对固定在 [658325942b0f4eecd888f9698ab0bebb3b749163](https://github.com/withastro/flue/tree/658325942b0f4eecd888f9698ab0bebb3b749163)，提交日期 2026-09-28；该提交的 `@flue/runtime`、`@flue/vite` 为 2.2.2。它是本稿的核对基线，不代表已经选定可上线的完整依赖组合。

实施时先锁定发布版本与依赖，再用该版本附带的 `flue docs` 和源码确认合同。不能把站点不同更新时间的示例混成一套配置。

## 2. 对原方案的实质修正

### 2.1 直接使用原生提交幂等

`dispatch` 支持调用方指定 `idempotencyKey`，最长 256 个字符，作用域为 Agent 身份与会话 ID。同键同载荷重放返回原回执，并标记 `deduplicated: true`；同键不同载荷返回 `409 submission_conflict`。已失败的提交不会因同键重放重新运行，确需重跑时创建新的业务运行和键。[提交类型](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/types.ts#L110)、[dispatch 实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/runtime/dispatch.ts)

DingBell 应在调用前持久化 `ai_run`、稳定幂等键及冻结载荷。如果平台已接受提交但本地未保存回执，使用相同目标、键和载荷有界重放，取得原回执；无需先自建一套猜测式运行历史搜索。冲突不能通过随机换键绕过。

首轮本地 workerd 验证补充：重放还必须保持同一提交入口。原生 HTTP 的 kind 为 direct，服务端 dispatch 的 kind 为 dispatch；两者同键交叉使用返回 409，防止重复输入，不会返回原入口的成功回执。DingBell 的可靠提交统一使用服务端 dispatch。[身份比较实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/runtime/agent-submissions.ts#L401)

这一能力只解决向 Flue 提交输入的去重。入站业务消息去重、预算预留、接管版本检查、向 Ozon 外发的结果核对仍然需要保留。旧运行因网络重试重新取得回执，也不获得绕过当前接管状态的发送权限。

### 2.2 修正 Cloudflare 构建合同

当前源码与 CLI 初始化模板使用以下组合：

```ts
plugins: [flue(), cloudflare({ config: flueWorkerConfig() })]
```

这只是配置片段，不是本仓库已经创建的配置。`flue()` 必须先于 Cloudflare 插件。Cloudflare Vite 插件读取用户的 Wrangler 配置、解析环境并输出部署配置；Flue 的 customizer 补充 Agent 绑定、默认 Worker 入口和兼容要求。应用资源及完整 DO 迁移历史由项目维护。当前校验的最低 `compatibility_date` 为 `2026-04-01`。[配置实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/vite/src/cloudflare-worker-config.ts)、[初始化模板](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/cli/src/lib/init.ts#L142)

不要按旧教程假设必须读取 `.flue-vite.wrangler.jsonc`，也不要手写替代 Flue 生成的 Worker 和 Agent 协调代码。Cloudflare 目标使用 DO 运行时存储；Node 的 `src/db.ts` 适配方式不能直接移植到该目标。

首轮运行验证发现：把模板的版本范围下界精确锁成 Cloudflare Vite plugin 1.39.2，会带入过旧的 workerd；Agents SDK 0.20.1 调用 startActiveSpan 时失败。本项目改为上游锁文件实际使用的 plugin 1.49.0、Wrangler 4.116.0、workerd 1.20260730.1，随后通过本地集成测试。构建成功不能替代此项运行验证。[上游锁文件](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/pnpm-lock.yaml#L10656)、[Cloudflare API 变更](https://developers.cloudflare.com/changelog/post/2026-07-28-start-active-span/)

### 2.3 恢复、调度与业务控制分清职责

当前 Cloudflare 实现用短暂的 alarm 监督流程检查持久状态并启动独立 attempt fiber，不等待模型完成才结束整个监督周期；执行及恢复复用 Cloudflare Agents SDK。应用不应另建一个 AI 轮询执行器。[协调实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/cloudflare/agent-coordinator.ts#L164)

公开的 `extend({ base, wrap })` 可以扩展 Agent 类，使用 SDK 的定时、队列、自定义方法等能力。全店铺同步、CSV 导出和业务通知仍可用 Queues/Cron；如果只是让一个 Agent 定时接收输入，优先复用原生入口。禁止覆盖 Flue 保留的 `fetch`、`onRequest`、`alarm`、`onFiberRecovered` 等生命周期。[Cloudflare 扩展](https://flueframework.com/docs/guide/cloudflare-target/)

原方案的 ConversationController 保留为业务控制与外发边界，不负责重复实现模型执行和恢复。阶段 1 应对照公开扩展能力检查是否还能删减协调代码；合并对象必须同时验证接管顺序、业务备份与 Agent 数据删除边界，不能只因为可以继承类就合并。

### 2.4 不把中止当作撤回外部操作

`abort` 是持久中止意图，后续才结算；它与已经完成的响应存在竞态。超时会触发中止，忽略信号的执行还涉及宽限期与后续强制结算。对外已经发出的网络请求不会因此自动撤销。[行为合同](https://flueframework.com/docs/reference/agent-behavior/)、[截止时间处理](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/cloudflare/agent-coordinator.ts#L848)

人工接管先持久化业务版本，再请求中止；发送出口拒绝旧版本候选。中止动作也要与恢复 AI 的动作有序协调，避免迟到的会话级中止误伤新一轮接待。框架的 attempt fencing 与业务的接管版本解决不同问题。

### 2.5 运行上限使用真实 API

Agent 的 `durability` 有 `maxAttempts` 和 `timeoutMs`；源码默认分别为 10 次与一小时。`maxAttempts` 是恢复尝试上限，不是模型轮次。首版建议的 120 秒、8 轮需要明确区分：前者可用原生超时配置，后者须通过实际支持的控制机制实现并测试，不能虚构一个 `maxTurns` 配置项。[DurabilityConfig](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/types.ts#L432)

用户体验上的等待上限与底层最终结算时刻也要分开；不能承诺配置 120 秒就保证远程副作用在第 120 秒全部停止。

### 2.6 渠道集成解决接收基础，不等于全平台无缝客服

已读的 17 种渠道提供各自的事件验证、类型与接入方式；应用仍需确定安装归属、凭证、租户映射、重复事件和外发接口。Shopify 的订单事件及 Admin API 不能推导出 Shopify Inbox 聊天权限，Salesforce Marketing Cloud ENS 也不等于完整 Salesforce CRM。[Channels](https://flueframework.com/docs/guide/channels/)、[Shopify](https://flueframework.com/docs/ecosystem/channels/shopify/)、[Salesforce Marketing Cloud](https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/)

本次目录没有 Ozon、Shopee、Lazada 的现成渠道文档。Ozon 仍采用薄连接器，把鉴权、字段转换、错误和能力检查集中维护；支持范围以平台官方资料及授权店铺测试决定。邀请邮件直接复用邮件 SDK，不为发送邀请额外接入一整套入站邮件 Agent。

### 2.7 前端复用 SDK，但保持业务消息合同

`@flue/sdk` 和 React hook 已处理读取、观察、重连与会话物化，不应重新编写 SSE 解析器。`send` 的接收成功不表示 AI 已回答；`read`、`wait` 与观察的语义不同。它们围绕指定 Agent 会话工作，不提供 DingBell 的多店铺客服收件箱。[SDK 总览](https://flueframework.com/docs/sdk/overview/)、[FlueClient](https://flueframework.com/docs/sdk/flue-client/)

消息中心仍读取业务 DTO；AI 测试页只复用经过鉴权和数据边界验证的 SDK 接入。Flue 的消息形状不意味着可以直接连接 Vercel AI SDK 的 `useChat`。内部推理、工具参数和系统提示不能先传到浏览器再隐藏。SDK 的附件 URL 也需要独立的访问控制，不能假设它继承流式请求的鉴权头。

### 2.8 原生观测不能直接充当计费与审计

运行时 `observe` 是当前 isolate 的实时观测，不是可补读的持久消费队列；回调返回的 Promise 不会变成可靠业务事务。重试及幂等重放可能再次产生观测事件。业务计量以唯一发送意图的确认结果为依据。[Events Reference](https://flueframework.com/docs/reference/events/)

`turn` 用量与 response/operation 等汇总只选择一个层次加总，不能重复累计。`useResponseFinish` 可同步附加响应元数据，不能在同步钩子中假装异步落账已完成；失败/中止时的费用仍需核对。模型目录价格是估算，未知模型返回零估价不能解释为免费。[Observability](https://flueframework.com/docs/guide/observability/)、[Models](https://flueframework.com/docs/guide/models/)

Cloudflare tracing 与 OTel 适配器默认可采集内容。DingBell 的默认配置应明确关闭内容采集，并单独处理 AI Gateway 日志及工具自己的日志；不能仅凭未安装外部监控就认定没有提示词记录。首先使用原生指标，外部 Sentry/OTel/Braintrust 按需启用。[内容采集设置](https://flueframework.com/docs/guide/observability/#protect-sensitive-content)

### 2.9 首版不需要沙箱和多 Agent

客服 Agent 使用查询、回复意图、转人工这些明确工具即可。当前模型没有隐式沙箱；不调用 `useSandbox()` 就不需要为客服问答安装 Containers、E2B、远程浏览器或文件执行环境。[Migration Guide](https://flueframework.com/docs/guide/migration/)

Skills 可复用过程说明，但其 `allowed-tools` 元数据不是运行时强制权限边界；也不能替代店铺知识的发布、版本与撤回。Subagents 和 MCP 只在出现实际需求时引入，不作为首版客服基础依赖。[Skills](https://flueframework.com/docs/guide/skills/)、[Subagents](https://flueframework.com/docs/guide/subagents/)

### 2.10 存储升级必须按格式兼容性判断

当前源码使用 `format_version = 1`，不兼容版本会拒绝启动，不会替业务安全地完成任意格式迁移。SQL 迁移实现有一个明确例外：旧 `schema_version = 8` 的同构存储可只更换标记，不改数据。不能把这个例外扩展成所有版本都能原地升级。[格式版本实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/format-version.ts)

升级先验证历史数据、运行恢复、删除及备份路径。遇到不兼容格式，停止放行并采用经过确认的迁移或运行世代重建；不得把自动清空运行时作为生产升级脚本的默认动作。

## 3. 文档之间的差异与处理方式

| 主题 | 阅读发现 | 本方案采用的依据与动作 |
| --- | --- | --- |
| 提交幂等 | Channels/Events 有说明，部分 Agent/HTTP/SDK 参数列表未完整列出 | 以固定提交的类型、参数校验和 dispatch 实现确认；增加相同键重放及冲突测试 |
| Cloudflare 配置 | 部分教程仍展示旧生成配置文件的连接方式 | 以 `cloudflare-worker-config.ts` 与 CLI 模板的 `flueWorkerConfig()` 为基线 |
| Cloudflare 执行 | 旧文字描述 alarm 等待模型完成 | 当前源码为监督循环加独立 fiber；不按旧描述设计应用超时 |
| 隐式沙箱 | 部分部署蓝图仍提默认虚拟沙箱 | 以 Migration Guide 与当前 hooks 合同为基线，明确选择是否使用沙箱 |
| 存储版本 | Migration Guide 仍说 schema 8；新持久层参考说明 format 1 | 源码确认 format 1 及 schema 8 同构重标记例外；其他格式不能推定兼容 |
| 流式读取优化 | 旧协议说明强调从原点重放；新持久层支持可选 fold checkpoint | 复用 SDK/运行时；不复制内部事件折叠算法，长会话成本另测 |
| SDK 失败语义 | 部分错误说明过于笼统，容易误以为 HTTP 错误总表示未接收 | 网络断线或部分服务端失败可能发生在接收后；使用稳定幂等键取得原结果 |
| OTel 关闭资源 | Tooling 蓝图与较新的生命周期说明对自动 dispose 的文字不一致 | 首版不依赖该可选集成；需要时按锁定版本验证 flush/dispose，不复制旧假设 |

上述差异是版本核对事项，不代表全部功能不可用。参考文档和示例用于理解意图，固定源码用于核对当前实现，云端合同测试用于验证实际依赖组合。

## 4. 复用清单与实施边界

| 能力 | 首版处理 |
| --- | --- |
| Agent 定义、模型、工具 Schema、结构化生成、压缩 | 直接复用 Flue；只写客服业务定义与受控工具 |
| 提交幂等、队列执行、恢复尝试、中止、读取 | 复用公开 API；业务运行持久化稳定目标、键和回执 |
| 持久工具步骤 | 使用 `durable`/`step.do`；对外副作用另做业务幂等，不宣称恰好一次 |
| Cloudflare Worker 入口与 Agent DO | 沿用构建集成和扩展入口；不 fork 协调器 |
| UI 的 Agent 传输 | 在合适的受控入口使用 SDK；消息中心保留业务 API |
| 模型日志与评估 | 原生指标先行；复用 Vitest Evals 方法，质量评估与确定性安全断言分开 |
| 账号、公司、成员邀请 | 使用既定认证/组织中间件；Flue 不提供这套 SaaS 产品能力 |
| 入站渠道验签 | 有官方包的渠道优先用包；应用仍校验安装及公司归属 |
| Ozon、外发、接管、业务审计 | 必要的薄业务实现，不能用框架日志或提示词代替 |
| 数据库生态适配 | 8 篇都属于 Node 的运行时存储选项；Cloudflare 首版不额外部署其中数据库 |
| 沙箱、远程桌面、多 Agent | 当前业务无必需场景，首版不安装 |
| Vercel | 生态中的 Vercel Sandbox 是远程执行环境，不是整套 Flue 的 Vercel 部署适配 |

`flue add` / `flue update` 输出集成蓝图，供开发者或 coding agent 按项目调整；不能视为自动安装并配置完整 SaaS 模块。`flue init --force` 会覆盖文件，后续施工应在临时目录生成参考再选择性合并，保留本项目的设计与计划。`flue run` 是 Node 执行入口，不能作为 Cloudflare 运行时验收。[CLI add](https://flueframework.com/docs/cli/add/)、[init](https://flueframework.com/docs/cli/init/)、[run](https://flueframework.com/docs/cli/run/)

## 5. 逐篇阅读记录

以下 96 条均已读取。每条记录的是对 DingBell 有影响的要点，适用限制见前文；不是仅列出抓取到的链接。

### 5.1 Guide 共 24 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [Agent Hooks](https://flueframework.com/docs/guide/agent-hooks/) | 区分每轮声明、异步 Agent 生命周期和同步响应元数据钩子；不在错误阶段发副作用。 |
| [Agents](https://flueframework.com/docs/guide/building-agents/) | 使用同步函数与 use agent 指令；固定 agentName，复用 dispatch/read/abort。 |
| [Channels](https://flueframework.com/docs/guide/channels/) | 优先复用验签与事件类型；稳定事件键用于提交去重，安装与店铺归属由应用验证。 |
| [Cloudflare](https://flueframework.com/docs/guide/cloudflare-target/) | 复用 DO、公开 extend 与 Agents SDK 能力；部分旧构建和 alarm 描述以固定源码校准。 |
| [Database](https://flueframework.com/docs/guide/database/) | 运行时库记录执行状态，不保存完整业务数据；Cloudflare 使用 DO，Node 才选数据库适配器。 |
| [Deploy](https://flueframework.com/docs/guide/deploy/) | 部署要同时具备执行、状态与配置，不是只上传前端；各目标必须独立验收。 |
| [Durability](https://flueframework.com/docs/guide/durability/) | 恢复重放及步骤缓存不能保证外部效果只发生一次；发送仍需唯一意图和核对。 |
| [Evals](https://flueframework.com/docs/guide/evals/) | 固定输入、可核对标准和质量评估可复用；权限与副作用用确定性断言，不能只用模型评分。 |
| [Getting Started](https://flueframework.com/docs/guide/getting-started/) | 理解最小工程与运行入口；初始化示例只作参考，Cloudflare 配置按当前源码校准。 |
| [MCP](https://flueframework.com/docs/guide/mcp/) | 原生支持外部工具接入；认证、令牌与可调用范围仍是应用责任，首版不开放任意 MCP。 |
| [Migration Guide](https://flueframework.com/docs/guide/migration/) | 同步 Agent、显式路由、显式沙箱等变化会影响旧示例；存储版本数字需对照当前源码。 |
| [Models](https://flueframework.com/docs/guide/models/) | 使用原生模型与提供商配置；模型、成本和工具能力必须按允许列表验证。 |
| [Node.js](https://flueframework.com/docs/guide/node-target/) | 同一会话需要唯一活跃执行归属；共享外部 DB 不自动支持多副本或短生命周期函数。 |
| [Observability](https://flueframework.com/docs/guide/observability/) | 原生事件、tracing 和用量有不同粒度；明确关闭默认内容采集，不能把观察回调当审计账本。 |
| [Project Layout](https://flueframework.com/docs/guide/project-layout/) | 沿用 app.ts、Agent 模块和目标扩展入口；业务模块留在同一工程。 |
| [React](https://flueframework.com/docs/guide/react/) | 复用单 Agent 的观察和会话状态；业务收件箱、权限和人工消息不能直接交给该 hook。 |
| [Routing](https://flueframework.com/docs/guide/routing/) | 显式挂载路由和鉴权；仅由内部 dispatch 驱动的 Agent 无需公开 HTTP 路由。 |
| [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) | 沙箱文件与运行时持久化分离；只使用业务工具的客服可以完全不配沙箱。 |
| [Schedules](https://flueframework.com/docs/guide/schedules/) | 平台触发器投递 Agent 输入；跨店铺业务到期任务保留 due_at，单 Agent 定时可复用扩展。 |
| [Skills](https://flueframework.com/docs/guide/skills/) | 可组织过程说明；allowed-tools 不是强制权限，不能替代知识发布与工具白名单。 |
| [Subagents](https://flueframework.com/docs/guide/subagents/) | 具名委派有独立上下文和成本；首版客服没有必须拆多个 Agent 的需求。 |
| [Tools](https://flueframework.com/docs/guide/tools/) | 复用 Valibot 工具校验、harness 与持久步骤；工具参数验证不等于租户授权。 |
| [Why Flue?](https://flueframework.com/docs/guide/why-flue/) | 框架价值在持久 Agent、可组合工具和多目标运行，不包含完整多租户客服产品。 |
| [Workflows](https://flueframework.com/docs/guide/workflows/) | 普通应用代码与 Agent 的持久执行边界不同；前后数据库和平台请求没有共同事务。 |

### 5.2 API Reference 共 10 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [Agent API](https://flueframework.com/docs/reference/agent-api/) | 核对 dispatch/read/abort、uid 和 initialData；uid 是会话世代控制，不是业务幂等键或权限。 |
| [Agent Behavior](https://flueframework.com/docs/reference/agent-behavior/) | 忙时输入可在轮次边界合并，多个提交可共享一次响应；中止与已完成响应存在竞态。 |
| [Agent Hooks API](https://flueframework.com/docs/reference/agent-hooks-api/) | initialData 是创建时数据，持久状态有提交边界；不能当跨 await 的业务事务锁。 |
| [Configuration](https://flueframework.com/docs/reference/configuration/) | 明确 Node/Cloudflare 配置的归属，利用 Worker 扩展入口，不复制生成协调器。 |
| [Data Persistence API](https://flueframework.com/docs/reference/data-persistence-api/) | 包含提交、fencing、流和格式合同；首版不自建存储适配器，删除与备份不能依赖私有表。 |
| [Errors Reference](https://flueframework.com/docs/reference/errors/) | 用稳定错误类型和代码分类；对用户隐藏内部堆栈，区分可重试与输入/权限失败。 |
| [Events Reference](https://flueframework.com/docs/reference/events/) | observe 是实时、进程内信号；重放和重复观察存在，不能充当唯一计费依据。 |
| [Provider API](https://flueframework.com/docs/reference/provider-api/) | 原生提供商合同包含工具、流和用量；没有实际模型缺口时不新写 provider。 |
| [Sandbox Adapter API](https://flueframework.com/docs/reference/sandbox-api/) | 适配器的生命周期、文件和执行能力可不同；客服首版不依赖这层。 |
| [Streaming Protocol](https://flueframework.com/docs/reference/streaming-protocol/) | 复用 SDK 的快照/事件折叠和重连；自定义业务 DTO 不直接冒充原始协议。 |

### 5.3 SDK 共 5 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [createFlueClient(...)](https://flueframework.com/docs/sdk/create-flue-client/) | 连接地址、动态鉴权头及请求传输要在受控边界配置；附件访问单独鉴权。 |
| [Errors](https://flueframework.com/docs/sdk/errors/) | 区分 API 拒绝和传输异常；丢回执时用提交幂等核对，不能一律当作未接收。 |
| [Events](https://flueframework.com/docs/sdk/events/) | 客户端观察与服务端运行事件不是同一接口；复用类型与重连，产品只输出允许的数据。 |
| [FlueClient](https://flueframework.com/docs/sdk/flue-client/) | 区分 send 接收、read 结果、wait 结算、观察和 abort；调用返回不等于已向消费者发送。 |
| [Flue Agent SDK](https://flueframework.com/docs/sdk/overview/) | 面向已知 Agent 会话的客户端，不是会话列表、组织管理或客服系统 SDK。 |

### 5.4 CLI 共 6 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [flue add](https://flueframework.com/docs/cli/add/) | 输出集成蓝图并可交给 coding agent；不等于自动装好鉴权、存储和平台配置。 |
| [flue docs](https://flueframework.com/docs/cli/docs/) | 可读取安装版本的离线文档；与锁文件、源码一起用于版本核对。 |
| [flue init](https://flueframework.com/docs/cli/init/) | 生成文件但不替应用完成集成；后续在临时目录生成参考，避免 force 覆盖已有文件。 |
| [CLI](https://flueframework.com/docs/cli/overview/) | CLI 提供初始化、文档、蓝图及本地运行入口；生产能力仍来自应用和部署目标。 |
| [flue run](https://flueframework.com/docs/cli/run/) | 用于 Node 目标的直接 Agent 运行；不加载完整应用路由，也不证明 Workers 兼容。 |
| [flue update](https://flueframework.com/docs/cli/update/) | 帮助按当前蓝图更新集成；产生的变更仍需审查与目标环境测试。 |

### 5.5 生态总览与渠道 共 18 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [Ecosystem](https://flueframework.com/docs/ecosystem/) | 生态目录提供可组合蓝图；按首版实际需求挑选，不把全部生态装成必需依赖。 |
| [Discord](https://flueframework.com/docs/ecosystem/channels/discord/) | HTTP 交互验签与及时响应可复用；Gateway 是不同接入，权限和外发仍需业务处理。 |
| [GitHub](https://flueframework.com/docs/ecosystem/channels/github/) | 复用签名校验及事件类型，外发用官方 API；事件身份不等于租户授权。 |
| [Google Chat](https://flueframework.com/docs/ecosystem/channels/google-chat/) | 校验 OIDC/PubSub 交付与空间归属；外发、服务账号和订阅生命周期仍需配置。 |
| [Intercom](https://flueframework.com/docs/ecosystem/channels/intercom/) | 可接收工作区会话事件并用官方 API 回复；地域、安装和授权需映射到公司。 |
| [Linear](https://flueframework.com/docs/ecosystem/channels/linear/) | 处理 Linear 事件并访问其 API；这是产品自身集成，不提供电商订单与买家消息的统一模型。 |
| [Facebook Messenger](https://flueframework.com/docs/ecosystem/channels/messenger/) | Meta 事件需要去重和过滤 echo/standby；外发受渠道消息窗口与权限限制。 |
| [Notion](https://flueframework.com/docs/ecosystem/channels/notion/) | 变更通知仍需读取实际页面；可作未来知识源，但不会自动得到发布、版本和 RAG。 |
| [Resend](https://flueframework.com/docs/ecosystem/channels/resend/) | 入站邮件通知与正文读取分开；邀请邮件只需发送 SDK，不必启用邮件 Agent。 |
| [Salesforce Marketing Cloud](https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/) | 范围是 Marketing Cloud ENS；不能将此蓝图宣传为全量 Salesforce 客服/CRM 接入。 |
| [Shopify](https://flueframework.com/docs/ecosystem/channels/shopify/) | 复用原始正文 HMAC、无损大整数解析及 Admin API；订单事件不能证明 Inbox 聊天可用。 |
| [Slack](https://flueframework.com/docs/ecosystem/channels/slack/) | 事件、交互和命令各有接入合同；过滤机器人回显，response URL 等按敏感能力处理。 |
| [Stripe](https://flueframework.com/docs/ecosystem/channels/stripe/) | 复用回调验签与官方 SDK；订阅与支付状态用确定性代码处理，不需要计费 Agent。 |
| [Microsoft Teams](https://flueframework.com/docs/ecosystem/channels/teams/) | 校验 OIDC 及租户/服务地址关联；不要把要求 Node 的 SDK 直接带入 Workers。 |
| [Telegram](https://flueframework.com/docs/ecosystem/channels/telegram/) | 校验共享 secret header，按 update ID 去重；正确区分 chat、topic 和 business 归属。 |
| [Twilio](https://flueframework.com/docs/ecosystem/channels/twilio/) | 验签依赖真实 URL 与原始请求形式；发送状态、用户退订和正文消息分别处理。 |
| [WhatsApp](https://flueframework.com/docs/ecosystem/channels/whatsapp/) | 处理 Meta 批量事件、业务身份与媒体访问；所列依赖另有 Node 版本要求，后续接入再锁定。 |
| [Zendesk](https://flueframework.com/docs/ecosystem/channels/zendesk/) | 该集成针对受支持的事件订阅；不自动覆盖自定义 trigger、Sunshine 或所有账号功能。 |

### 5.6 运行时数据库 共 8 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [libSQL](https://flueframework.com/docs/ecosystem/databases/libsql/) | Node 运行时选项；驱动与事务仍由应用配置，Cloudflare 首版使用原生 DO。 |
| [MongoDB](https://flueframework.com/docs/ecosystem/databases/mongodb/) | Node 运行时选项；事务能力依赖部署配置，不能假设任意独立 Mongo 实例均符合合同。 |
| [MySQL](https://flueframework.com/docs/ecosystem/databases/mysql/) | Node 运行时选项；连接、事务、TLS 和所有权由部署承担，不是首版额外依赖。 |
| [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/) | Node 运行时选项；事务回调需同一连接，不能把无会话 HTTP 查询冒充交互事务。 |
| [Redis](https://flueframework.com/docs/ecosystem/databases/redis/) | Node 运行时选项；要求合适的持久与不驱逐配置，不能把临时缓存当可靠执行库。 |
| [Supabase](https://flueframework.com/docs/ecosystem/databases/supabase/) | 提供 Node 的 PostgreSQL 存储路径；共享数据库不解决 Agent 多实例执行归属。 |
| [Turso](https://flueframework.com/docs/ecosystem/databases/turso/) | 提供 Node 的 libSQL 路径；持久历史、连接与部署生命周期需要一起配置。 |
| [Valkey](https://flueframework.com/docs/ecosystem/databases/valkey/) | Node 的 Redis 兼容路径；保持事务及可靠存储约束，首版不新增该基础设施。 |

### 5.7 部署 共 10 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [Deploy Agents on AWS](https://flueframework.com/docs/ecosystem/deploy/aws/) | 蓝图采用常驻 Node 运行方式；不能直接外推到 Lambda 或其他短函数执行模型。 |
| [Deploy to Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/) | 首版重点；应用绑定与迁移必须明确，旧生成配置示例按当前 customizer 实现修正。 |
| [Deploy Agents with Docker](https://flueframework.com/docs/ecosystem/deploy/docker/) | 容器启动、持久卷与环境变量是部署责任；只有镜像不能保证会话及后台运行可靠。 |
| [Deploy Agents on Fly.io](https://flueframework.com/docs/ecosystem/deploy/fly/) | 适用于常驻 Node 与持久存储；扩容前处理同会话唯一归属。 |
| [Build Agents for GitHub Actions](https://flueframework.com/docs/ecosystem/deploy/github-actions/) | 适合一次性任务或评估；不作为 24 小时客服会话协调器。 |
| [Build Agents for GitLab CI/CD](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/) | 适合流水线任务；作业结束的生命周期不满足持续客服后台要求。 |
| [Deploy Agents on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/) | 需生产持久库和稳定进程；开发默认状态与生产保留行为不能混用。 |
| [Deploy Agents on Railway](https://flueframework.com/docs/ecosystem/deploy/railway/) | 常驻服务与持久状态部署蓝图；共享库并不自动实现多副本安全。 |
| [Deploy Agents on Render](https://flueframework.com/docs/ecosystem/deploy/render/) | 常驻服务蓝图；实例重启、磁盘与 Agent 归属需部署配置保证。 |
| [Deploy Agents on SST](https://flueframework.com/docs/ecosystem/deploy/sst/) | 基础设施封装不改变 Node 运行归属约束；当前不增加另一套部署工具链。 |

### 5.8 沙箱 共 10 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [boxd](https://flueframework.com/docs/ecosystem/sandboxes/boxd/) | 远程命令与文件工作区；运行环境的存续和清理由应用负责，客服首版不用。 |
| [Cloudflare Computer](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-computer/) | 早期预览的远程计算机能力；不是首版客服与一键部署的可靠必需基础。 |
| [Cloudflare Sandbox](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/) | 远程容器沙箱有镜像、绑定和生命周期成本；纯业务工具客服不需要它。 |
| [Daytona](https://flueframework.com/docs/ecosystem/sandboxes/daytona/) | 远程执行提供方；会话身份、重用和清理需独立设计，不能替代业务持久化。 |
| [E2B](https://flueframework.com/docs/ecosystem/sandboxes/e2b/) | 远程执行与文件环境；不用它也可运行 Flue 的模型和业务工具。 |
| [exe.dev](https://flueframework.com/docs/ecosystem/sandboxes/exedev/) | SSH 远程机器路径；机器生命周期和秘密管理是额外运维，首版不引入。 |
| [islo](https://flueframework.com/docs/ecosystem/sandboxes/islo/) | 隔离执行环境选项；只在确需运行代码时评估，不为普通客服问答配置。 |
| [Mirage](https://flueframework.com/docs/ecosystem/sandboxes/mirage/) | 远程沙箱选项；其状态与 Flue 会话数据库独立，恢复不能互相替代。 |
| [Modal](https://flueframework.com/docs/ecosystem/sandboxes/modal/) | 外部计算环境选项；增加独立账号与运行资源，当前业务没有采用必要。 |
| [Vercel Sandbox](https://flueframework.com/docs/ecosystem/sandboxes/vercel/) | Vercel Sandbox 是远程执行环境；不表示整套 Flue 支持 Vercel 函数部署。 |

### 5.9 工具与评估 共 5 篇

| 文档 | 对 DingBell 的结论 |
| --- | --- |
| [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/) | 可选评估与追踪服务；内容边界及尽力发送可能丢失，不作为可靠业务账本。 |
| [Jetty](https://flueframework.com/docs/ecosystem/tooling/jetty/) | 外部评估环境/评分集成；首版先用项目内固定数据与断言，避免必需外部账号。 |
| [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/) | 可选追踪出口，SDK/exporter 生命周期需配置；内容采集默认值必须显式处理。 |
| [Sentry](https://flueframework.com/docs/ecosystem/tooling/sentry/) | Cloudflare 的 wrap 可覆盖 Agent DO；应用 Worker 的监控要单独覆盖，不能遗漏或重复初始化。 |
| [Vitest Evals](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/) | 可复用测试流程和隔离会话方法；真实模型质量评估与可靠性合同测试分开报告。 |

## 6. 对施工和验收的落点

1. 阶段 1 固定版本、构建方式与 Agent 身份；验证原生幂等、公开扩展、云端恢复和历史格式兼容。对应 AC-085—AC-087、AC-093。
2. 阶段 6 验证输入合并、异步中止、超时与业务接管的组合；同一响应可以覆盖多个提交，不能重复发送。对应 AC-088—AC-089，并继续执行 AC-026—AC-039。
3. 阶段 8 验证观测丢失/重放、内容采集默认值和用量口径。对应 AC-090—AC-092；同样适用于不收费的自部署版。
4. 阶段 9 在部署、升级与真实云端故障场景重跑受影响合同，记录实际依赖版本。以上新增项目均未整项放行；已验证的本地子场景见实施进度。

阅读后更新了[实施计划](01-implementation-plan.md)、[架构设计](02-architecture.md)、[验收清单](03-acceptance.md)和[调研与决策](04-research-and-decisions.md)。获准实施后完成了[首批本地验证](06-implementation-progress.md)。Ozon 店铺能力、Flue 运行中恢复与数据删除，以及完整一键部署仍是实测门槛。
