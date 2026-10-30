# DingBell 调研依据与架构决策

版本：0.2，评审稿。核对日期：2026-10-08。

2026-10-29 决策更新：用户确认同时保留 Cloudflare、Vercel、自建服务器三个完整部署目标，采用共用业务核心与平台适配层；Pi Durable 作为替换 Flue 的执行内核方向。范围、适配方案及实施顺序以 [ADR-11](#adr-11-共用核心与三个完整部署目标2026-10-29) 为准。下文 Flue 调研保留为历史兼容依据。2026-10-30 三端适配已实现，技术验证、实际版本及保留边界见 ADR-11 的实施状态和[部署证据](../probes/deployment/README.md)。

本文件记录选型依据、适用边界和仍需工程验证的事项。官方文档说明某组件具有某项能力，不代表 DingBell 已经完成集成；完整部署、平台权限和故障恢复须按验收清单验证。

本版补充了 Flue 全站 96 篇可访问文档的逐篇阅读，并将关键差异与固定源码核对。完整范围、失效页面及每篇结论见[Flue 文档核对](05-flue-documentation-audit.md)。

## 1. 证据等级

| 标识 | 意义 | 可以怎样使用 |
| --- | --- | --- |
| 已确认需求 | 用户明确选择或已形成的产品要求 | 作为范围基线 |
| 官方文档/源码已核对 | 本次或前序调研读取官方来源 | 支持技术判断，仍受版本及平台限制影响 |
| 架构建议 | 针对 DingBell 的工程选择 | 在用户评审后成为实施基线 |
| 待实测 | 依赖真实账号、云运行时、版本组合或平台权限 | 不能作为已交付功能宣传 |
| 待用户决定 | 业务权限、预算、收费等尚未确认 | 使用明确建议值规划，不视为已批准 |

## 2. Flue 应复用与不应假定的能力

| 主题 | 官方依据与核对结论 | DingBell 决策 |
| --- | --- | --- |
| HTTP 路由 | [Routing](https://flueframework.com/docs/guide/routing/)：app.ts 显式组织路由，常用 Hono；Agent 路由不自动带业务鉴权 | 沿用 Hono，所有业务入口自行检查公司与店铺权限 |
| 运行时存储 | [Database](https://flueframework.com/docs/guide/database/)：保存 Agent 会话和提交等运行状态；不替代业务数据库 | 公司、订单、审计、策略单独建模 |
| Cloudflare | [配置源码](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/vite/src/cloudflare-worker-config.ts)：flueWorkerConfig() 交给 Cloudflare Vite 插件组合源配置；Agent DO 原生持久化 | 首版沿用当前构建入口，应用绑定与 DO 迁移由项目维护 |
| 提交幂等 | [提交类型](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/types.ts#L110)：idempotencyKey 原生收敛到相同提交；载荷冲突拒绝 | 预先持久化稳定键与冻结载荷；丢回执同键重放，不自建替代机制 |
| Node | [Node target](https://flueframework.com/docs/guide/node-target/)：每会话需要唯一活跃归属进程；共享 DB 不自动使多实例安全 | Vercel 适配另做执行归属与恢复验证 |
| 持久工具 | [Durability](https://flueframework.com/docs/guide/durability/) 与 [Tools](https://flueframework.com/docs/guide/tools/)：可持久记录步骤，但外部副作用仍可能重复 | 发送前有业务幂等、状态检查和未知结果核对 |
| 定时任务 | [Schedules](https://flueframework.com/docs/guide/schedules/)使用目标平台触发器；[Cloudflare 扩展](https://flueframework.com/docs/guide/cloudflare-target/)也可使用 Agents SDK 定时与队列 | 单 Agent 定时优先原生扩展；跨店铺业务作业使用 Cron/Queues 与持久 due_at |
| 工作流 | [Workflows](https://flueframework.com/docs/guide/workflows/)：外部脚本与 Agent 提交不是共同事务 | 不把 dispatch 成功前后所有业务步骤都当作自动耐久 |
| 前端 | [React](https://flueframework.com/docs/guide/react/)：提供会话观察与交互；消息类型并非 AI SDK transport | 不公开原始内部轨迹；业务消息 UI 单独用受控 DTO |
| 模型 | [Models](https://flueframework.com/docs/guide/models/)：提供模型接入与运行控制 | 沿用 Flue 接入，模型/预算使用经测试的配置 |
| 可观测 | [Observability](https://flueframework.com/docs/guide/observability/)与 [Events](https://flueframework.com/docs/reference/events/)：可复用事件、用量和 tracing；实时观察不是持久账本 | 默认明确关闭内容采集；用量只累计一层，业务审计与计量由持久事实核对 |
| 评估 | [Evals](https://flueframework.com/docs/guide/evals/)：提供评估实践和工具接入方式 | 建立自己的电商事实、权限、语言和接管评估集 |
| Shopify | [官方源码文档](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/apps/docs/src/content/docs/ecosystem/channels/shopify.md)：Webhook 验证及 Admin API 接入基础 | 不能推定拥有 Shopify Inbox、完整安装授权或多商家凭证生命周期 |
| 沙箱 | [Migration Guide](https://flueframework.com/docs/guide/migration/)：当前没有隐式文件/代码环境 | 首版客服仅注册业务工具，不必配置沙箱、多 Agent 或远程浏览器 |
| 存储格式 | [格式实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/format-version.ts)：format 1；SQL 可同构重标记旧 schema 8，其他不兼容会拒绝 | 独立做带数据升级测试，不能默认清空或推定通用迁移 |

调研的仓库提交为 658325942b0f4eecd888f9698ab0bebb3b749163。该提交的 runtime 包版本为 2.2.2，开发 Node 要求见[包声明](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/package.json)。实施时以兼容性验证后的锁文件为准，不在部署脚本中依赖浮动 latest。

## 3. 中间件与服务比较

| 需求 | 首选/候选 | 采用理由 | 其他方案及取舍 |
| --- | --- | --- | --- |
| 认证与组织 | Better Auth | [组织插件](https://better-auth.com/docs/plugins/organization)直接覆盖成员与邀请；[D1 支持](https://better-auth.com/blog/1-5)减少适配 | 外部认证 SaaS 会增加每位自部署者的账号/配置依赖，首版不设为必需 |
| ORM | Drizzle | [D1/Workers 支持](https://orm.drizzle.team/docs/sqlite/connect-cloudflare-d1)，贴近 SQL 和迁移 | 不同时引入第二套业务 ORM；不声称 D1 与 PostgreSQL 能零成本互换 |
| API 类型 | Hono RPC + Valibot | [RPC](https://hono.dev/docs/guides/rpc)共享合同，标准 Schema 可接 Valibot | 不为相同需求额外叠加 tRPC 或复制 DTO |
| 表单校验 | React Hook Form + resolver | [官方 resolver 库](https://github.com/react-hook-form/resolvers)有 Valibot 适配 | 表单 UI 和后端权限仍需实现 |
| 列表与筛选 | TanStack Query/Table | [Query](https://tanstack.com/query/latest/docs/framework/react/overview)与[Table](https://tanstack.com/table/latest/docs/framework/react/guide/column-filtering)提供数据/筛选状态基础 | 服务端筛选和公司范围仍由 API 负责，不将全量客户数据拉到浏览器过滤 |
| 后台任务 | Cloudflare Queues/Cron | 同一部署账号，原生绑定；[Queues](https://developers.cloudflare.com/queues/)可处理批次/重试/死信 | [BullMQ](https://docs.bullmq.io/)基于 Node/Redis，会增加基础设施；pg-boss 适合另有 PG/常驻 worker 的部署，不作为当前默认 |
| 多步长流程 | Cloudflare Workflows，后续按实际需要使用 | [官方限制与执行模型](https://developers.cloudflare.com/workflows/reference/limits/)适合跨步骤等待/恢复 | 首版不并列引入 Temporal、Inngest、Trigger.dev 等另一套必需服务；出现跨天审批再评估 |
| 知识检索 | Vectorize 为可实施基线；AI Search 优先验证替代 | [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/)可控；[AI Search](https://developers.cloudflare.com/ai-search/)可减少导入、分块与检索基础代码 | 按 ADR-08 决定唯一实现；不同时维护两套 RAG 管道 |
| 知识解析 | 明确支持类型的轻量解析库；托管解析候选 | 当前范围是文本、Markdown、商品与 CSV，避免先引入重型解析服务器 | OCR/PDF 需要时再比较 AI Search 或独立解析服务的成本与隔离 |
| 知识 CSV 导入（5B-9 已接入） | `csv-parse@7.0.3` Browser ESM sync | [官方非 Node 分发](https://csv.js.org/parse/distributions/browser_esm/)；无新增传递依赖，MIT；本地 workerd 已验证 BOM/引号/多行解析 | 应用负责字节/行数/范围/幂等及失败恢复；限制 64 KiB/20 条，不把同步解析扩展为无限文件任务 |
| 策略条件 | 类型明确的条件集合；复杂组合可用 JsonLogic | [JsonLogic](https://jsonlogic.com/)将可序列化条件作为数据 | 不把商家输入当任意 JavaScript；不先建设通用可视化工作流平台 |
| CSV | json2csv WHATWG | [官方实现](https://github.com/juanjoDiaz/json2csv/tree/main/packages/whatwg)支持 Web Streams 和格式处理 | 快照、鉴权、公式防护、异步任务仍由业务层处理 |
| 大整数 JSON | lossless-json，只在需要的连接器使用 | [项目说明](https://github.com/josdejong/lossless-json)支持保留原数值信息 | 不对所有应用 JSON 一律换解析器；外部 ID 转换前必须保真 |
| 邮件 | Resend 作为首个候选 | [Cloudflare 集成](https://resend.com/cloudflare)便于邀请/找回邮件接入 | 不把邮件 API 等同于 Ozon 买家聊天 API；发送域名和配额需配置 |
| 支付 | Better Auth Stripe 插件候选 | [官方插件](https://better-auth.com/docs/plugins/stripe)支持订阅、组织关联及回调基础 | 价格、可用经营主体和实际计量仍需业务确认；开源核心可关闭 |
| 多平台接入 | Flue 已有渠道优先，Ozon 薄连接器 | 对首个实际平台保持明确接口和能力测试 | [Nango](https://nango.dev/docs/getting-started/intro-to-nango)能处理认证和集成运行；多 OAuth 平台出现后再权衡额外服务 |
| 电商聚合 API | API2Cart 后续候选 | [官方平台页面](https://api2cart.com/supported-platforms/)提供聚合接入入口 | 当前证据不足以确认覆盖 Ozon 的全部买家消息、建聊和问答需求，不能作为无缝接入承诺 |
| 可观测 | Flue 事件 + Cloudflare 原生 | 首版不增加另一个必配账号 | Sentry/OTel 输出可选；AI 质量评估独立于错误追踪 |

这些选择追求减少总维护量，既计算业务代码，也计算安装、迁移、密钥、故障定位与升级成本。某库减少几行调用但引入额外必需服务，不一定适合一键自部署。

## 4. 架构决策记录

### ADR-01 首版 Cloudflare 完整部署

状态：历史决策；部署目标和新运行时方向已由 ADR-11 更新。现有实现使用 Workers/Static Assets 承载 UI 与 API，Flue 原生 DO 运行 Agent；这仍是旧运行收尾与迁移的基线。

验证：全新账号部署、已有数据升级、后台任务与 AI 中断恢复。不能以静态页面上线代替完整支持。

### ADR-02 开源与托管共用核心

状态：用户已确认。商业版在同一核心上提供托管、用量与收费。自部署不依赖 DingBell 商业中心。

验证：关闭 billing 后核心闭环完整，源码和迁移可独立复现；默认遥测不向运营方发送客户数据。

### ADR-03 Flue 与业务状态分离

状态：现有 Flue 实现的职责边界；后续运行时和平台解耦遵循 ADR-11。Flue 负责 AI 运行；自有控制对象负责负责人、接管、业务命令和外发。这些业务能力不是 Flue 的持久队列自然提供的。

复用约束：Flue 的提交幂等、attempt 恢复、流式读取与公开 extend 不另写替代。独立业务对象的理由是业务控制、审计与数据生命周期；阶段 1 对照原生扩展检查能否减少封装，合并须通过同一组接管与恢复验收。

验证：接管在生成中生效、迟到输出被拒、业务状态恢复后不回退、原始 Agent 数据不直接暴露。

### ADR-04 D1 主库与派生搜索库分离

状态：架构建议。D1 主库有关系数据与业务日志；全文索引放独立可重建数据库。

理由：D1 支持 FTS5，但[官方导出说明](https://developers.cloudflare.com/d1/best-practices/import-export-data/)列出虚拟表相关限制。不能把删除生产索引作为常规备份步骤。

验证：主库可以备份与恢复，搜索从消息记录重建，索引中遗留数据不能绕过主库权限校验。

### ADR-05 发送以意图和结果核对管理

状态：架构建议。平台副作用走唯一出口，区分 queued/sending/sent/failed/unknown/canceled/skipped。

理由：[队列至少一次投递](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)和外部平台超时都要求应用处理重复与歧义。

验证：明确成功只记一次；未知结果不会直接重发；恢复数据库后与平台对账再开放外发。

### ADR-06 AI 首版不改订单与资金

状态：待用户确认的建议。模型可查询、回答、收集资料和转人工；退款/取消/发券由人工处理。

变更条件：如果需要 AI 执行，增加单独动作授权、额度、审批、平台幂等与补偿，重新评审受影响验收。

### ADR-07 公司配置与权限不能由提示词代替

状态：架构建议。策略内容和范围用经校验的版本化数据；确定性代码执行租户、发送及预算边界。

验证：恶意提示词、错误模型工具参数和修改前端请求都不能绕过后端检查。

### ADR-08 知识检索先验证托管方案能否减少代码

状态：明确的阶段 1 决策门槛。当前架构稿用 Vectorize 描述可控基线；优先对 AI Search 运行同一组验收，全部通过则选择 AI Search 并删除对应自建导入/分块/嵌入基础代码，只保留业务版本与权限控制。

官方资料已确认 AI Search 提供[自动索引、混合检索及 OCR](https://developers.cloudflare.com/ai-search/)，并支持[按租户实例或共享实例过滤](https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/)。不能以“不支持多租户”为由排除它。

必须验证的六项：

1. 全新账号能够随模板/初始化创建所需资源，无额外未说明的手工控制台步骤；账号实例配额满足目标规模。
2. 服务器指定公司/店铺范围；草稿、撤回、旧版本及其他租户不能进入生产回答。
3. 只取检索结果交给 Flue，不额外引入第二个对客回答模型；引用能映射回业务修订版。
4. 发布前能够确认索引就绪；删除/撤回有可验证的生效路径；共享索引模式也能稳定过滤版本。
5. 自部署成本、测试方式和资源清理可解释；本地无法模拟的部分有远程测试与确定性替身。
6. 原文件和版本事实仍由 DingBell 保存，恢复时可重建索引，AI Search 公共匿名端点关闭。

AI Search 的[检索 API](https://developers.cloudflare.com/ai-search/api/search/rest-api/)与[过滤文档](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/)是验证依据。当前没有完成实际部署测试，因此不声称六项已经通过。

若验证失败，采用架构稿 Vectorize 路径；若通过，阶段 1 更新资源表、知识管道与成本表。发布、隔离、引用、删除的产品验收保持不变，不同时实施两种引擎。

### ADR-09 首版工作台使用业务增量轮询

状态：架构建议。消息中心采用有游标、可见页增量刷新；AI 测试所需流式数据独立处理。

理由：当前试点规模尚未确认，先实现与数据库/权限一致的恢复语义；不为 20 在线客服的假设增加独立实时 SaaS 或广播集群。

变更条件：AC-083 达不到已批准的更新时效，或实际协作人数/在线指标证明需要推送，再评估 DO 推送或 SSE 通知；事件和游标合同保留。

### ADR-10 有边界的一致 CSV 导出

状态：架构建议。异步任务开始时创建事务内数据快照，然后分批格式化、写文件；暂定 100,000 行上限需实测。

验证：状态在生成期间变化不导致漏行/重复；撤销权限使生成或下载失效；超限明确提示。不能把不断变化的分页结果称作固定快照。

### ADR-11 共用核心与三个完整部署目标（2026-10-29）

状态：用户已确认 Cloudflare、Vercel、自建服务器三个部署目标，并同意共用核心与平台适配方向。以下为实施基线；具体版本、依赖组合和部署配置须经过兼容验证，当前仓库仍是 Flue/Cloudflare 实现。本记录不表示三端已经支持。

2026-10-29 最小执行探针已实测：Pi 1.4.0、Agents 0.30.0、durable-harness 0.0.1 组合通过 Node SQLite、本地 World 自动队列恢复、本地 workerd、Cloudflare 真云恢复/重新部署，以及 Vercel 真云 Function 超时/队列恢复/重新部署原回执检查。Vercel 执行层直接使用官方 `durable-harness/pi-durable` 适配器；共用 Pi 模型与工具，不需要 Sandbox 或外部数据库保存 Agent 检查点。完整应用未迁移。原生同键不同载荷返回原提交，须保留业务载荷冲突校验。可复跑源码、观察器修正及非阻断构建诊断见[探针结果](../probes/pi-portability/RESULTS.md)。

追加约束：用户要求 Vercel 只使用内置能力，拒绝另配远程 libSQL 业务库。Vercel Agent 执行优先采用下表的 **Pi Durable + durable-harness + World/原生队列**，其恢复与重新部署已通过独立真云验证。World 的 Agent 检查点不替代公司、权限、预算等业务关系数据。

业务存储另保留 **Sandbox 内的 Node/SQLite + Drives 持久磁盘** 候选，探索复用自建业务后端。Drives 可跨 Sandbox 会话保留文件且只允许单个读写挂载，挂载只能在 Sandbox 中使用；Hobby 每次 Sandbox 会话最长 45 分钟，仍须处理单写入归属、持久唤醒、故障恢复、升级及入口鉴权。仅保存快照或只在用户请求时启动不能满足后台客服任务。Blob 支持 ETag 条件写入，但不据此自行实现关系数据库。最小存储合同已在 Vercel Hobby 真云通过：Node 24.22.1/SDK 3.9.1 的 SQLite WAL 回滚、第二写入实例拒绝、跨 Sandbox 原回执/预算保留及清理均通过。该存储探针独立于 Agent 执行验证；完整业务合同、持久唤醒及安装链路尚未完成，不启用 Vercel 部署按钮，也不引入第三方数据库。

依据：[Drives](https://vercel.com/docs/sandbox/concepts/drives)、[Sandbox 持久性](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes)、[Sandbox 配额](https://vercel.com/docs/sandbox/pricing)、[当前存储产品](https://vercel.com/docs/storage)、[Blob 条件写入](https://vercel.com/docs/vercel-blob#conditional-writes)。部署和探针状态见[部署验证](../probes/deployment/README.md)。

#### 范围与完成定义

三个目标均覆盖工作台、身份与权限、业务 API、持久业务数据、Agent 执行、后台任务、知识检索和受控发送。每个部署使用部署者自己的资源和凭证，可独立运行；自建服务器的核心闭环不依赖 Cloudflare、Vercel 或 DingBell 商业中心的账号。仅部署前端、代理到另一台服务器上的 Agent，不算对应平台的完整支持。

全平台共用 TypeScript 业务规则、API DTO、提示词版本、业务工具和审计合同。继续复用现有 Hono、Drizzle、身份及 UI 组件。平台差异在适配层解决，按部署目标装配依赖和构建入口。

#### Agent 执行方案

| 部署目标 | 目标执行方案 | 持久化与恢复 | 必须验证的边界 |
| --- | --- | --- | --- |
| Cloudflare | Pi Durable + Agents SDK 的 PiHarness | DO SQLite；由 Lifecycle 提供持久唤醒与恢复 | 驱逐、alarm、存储错误和重复唤醒；保留已有 DO 迁移历史及旧 Flue 回执 |
| Vercel | Pi Durable + `durable-harness/pi-durable` | Vercel World 存储与队列；注册 Harness 重开入口 | 函数超时、重新部署、并发提交和队列重复投递；运行状态不能依赖本地 SQLite 文件或请求结束后的内存任务 |
| 自建服务器 | Node + Pi Durable，首个目标为单进程 | SQLite 文件放持久卷；进程管理器重启后重开存储并恢复任务 | 进程中断、重启、定时任务恢复、卷备份和唯一写入进程；多节点另做协调及后端验证 |

官方依据：[Cloudflare PiHarness](https://developers.cloudflare.com/agents/harnesses/pi/)、[Vercel Pi Durable 接入](https://vercel.com/docs/agent-harnesses/pi)、[Pi Durable 存储与恢复](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)。这些能力是适配基础，不能代替 DingBell 的运行验证。

Pi Durable 管理模型与工具步骤；PiHarness 和 durable-harness 分别承担目标平台的存储及恢复接入。`durable-harness` 只作为需要它的平台适配依赖；核心不要求所有安装者配置 World、AI Gateway 或 Sandbox。模型供应商通过 Pi AI 的配置接入，自建部署使用自己的供应商或模型服务。客服工具继续限制为明确的业务操作。

Pi Durable 和相关适配 API 仍在快速变化。实施前锁定经验证的 Pi、Agents SDK、durable-harness 和 World 版本，并验证共用工具定义能够在各目标运行；不能因 peer dependency 范围匹配便认定行为兼容。现有 `pi-ai@0.87.1`、`agents@0.20.1` 和 Flue 依赖在兼容验证前保持原样。新增依赖时记录具体用途、版本、许可证和目标产物，检查重复依赖及未使用适配代码是否进入构建。

#### 核心与平台边界

以现有 `SupportRuntime` 为执行接口提取起点，统一提交、回执恢复、状态读取、取消意图与终态核对；复用已有翻译和问答测试的业务合同。核心及业务工具不直接导入 `cloudflare:workers`、D1/DO/Workflow 类型、Vercel SDK 或 World 存储类型。Pi 的宿主存储在适配层注入，业务对象通过带公司/店铺范围的接口访问。

| 边界 | 共用合同 | 适配要求 |
| --- | --- | --- |
| 业务数据 | 公司隔离、预算预留/结算、唯一键、版本冲突和审计 | 提取现有 D1 SQL 与事务假设；继续使用 Drizzle，关系库后端按合同验证，不能把 ORM 等同于数据库零成本互换 |
| 会话与店铺协调 | 命令顺序、接管版本、执行归属、共享限流 | Cloudflare 可保留 DO；其他环境通过事务或带失效版本的租约实现相同约束 |
| 后台任务 | 持久任务 ID、到期时间、重试上限、结果核对 | 平台触发器负责唤醒，任务状态可恢复；进程内定时器不能作为唯一事实 |
| 知识与检索 | 不可变修订、发布事实、检索范围、引用复核 | 向量及全文索引可按已发布源重建；业务层不直接依赖 Vectorize 类型或返回格式 |
| 文件 | 文件身份、公司范围、授权、大小/摘要校验 | 适配对象存储或自建文件存储；保留现有同步导出与可选文件能力的状态边界 |
| HTTP 与观察 | 受控 DTO、鉴权、幂等提交和可恢复状态读取 | 各宿主复用 Hono；内部提示词、工具参数和原始执行日志不直接作为客户端协议 |

业务数据库与 Agent 检查点分开建模。自建 Agent 使用 SQLite，不代表已经移植 D1 业务库；Vercel World 保存运行状态，也不替代业务数据库、向量索引或对象存储。按实际能力选定每个平台的一套后端实现，避免同时维护功能重复的存储与检索方案。

#### 正确性与迁移

现有公司/店铺权限、预算账本、接管版本、冻结输入与知识、单次发送许可和 unknown 状态合同继续作为约束。框架恢复或队列重投不能新增供应商调用许可、释放不明费用或重新发送结果未知的消息。模型重试和工具重放必须服从已预留预算与业务幂等；取消不表示已发生的外部操作被撤回。

平台回执由适配器映射并保留运行时、版本和执行归属证据。不能用新 operation ID 冒充历史 Flue UID，也不能在缺少同等终态/关闭证据时解除预算或发送限制。

首个跨平台迁移合同采用有维护窗口的导出/导入：停止新准入，收尾可完成的任务，冻结并记录未完成和未知结果，再导出业务数据、幂等键、费用/发送账本、知识源、文件清单及运行版本。密钥通过独立安全渠道迁移；索引按原发布事实重建。目标验证完成并取得执行归属后再恢复入口，避免源端与目标端同时处理同一任务。

不同宿主的原生检查点不假定能直接互拷。尚未具备可验证转换器的任务保留原运行证据并进入明确的待核对状态，不以新任务重放替代迁移。保留源端恢复材料；导入失败不触发对外发送或未知费用释放。

#### 实施顺序与验收

1. 抽离核心接口和业务工具，保留现有 Cloudflare/Flue 路径及回归证据；先验证版本兼容和预算/发送合同，再切换新运行。
2. 跑通 Node/SQLite 单进程 Agent 与自建部署所需的业务存储、任务、知识及文件适配，用完整客服闭环证明核心不依赖云平台。
3. 接入 Cloudflare PiHarness，验证 DO 驱逐与旧运行收尾；现有 Flue 实例的数据和回执按迁移合同处理。
4. 接入 Vercel Pi Durable/World，验证函数中断、队列恢复及整套业务后端；不以工作台能够打开作为完成证据。
5. 三端执行同一组业务合同测试，并各自完成全新部署、升级、故障恢复和停机迁移演练，逐项登记平台与版本证据后再标记支持。

共同验收至少覆盖：租户隔离、重复消息/提交、并发命令、人工接管与迟到输出、预算和用量核对、发送成功/失败/unknown、知识撤回与引用、后台任务重启恢复、备份导入及旧版本升级。类型、Lint（按项目实际配置）、构建、核心交互、响应式、基础无障碍和依赖检查沿用项目交付要求。最小执行探针证据不替代这组完整业务验收；Vercel 真云及三端应用迁移仍待完成。

#### 2026-10-30 实施状态与保留边界

三端适配现已实现：独立 Pi AI / Pi Durable / Chord 1.4.0 运行图，Cloudflare Agents 0.30.0 PiHarness，Vercel durable-harness 0.0.1 / World 原生队列，Node 24 SQLite。业务 SQL、身份、协调器、预算、原始回执、受控工具与单次尝试发送器复用同一业务规则；Vercel 数据库位于自有 Sandbox Drive，不使用第三方数据库。Node HTTP 接入复用已安装的官方 @hono/node-server 2.1.4；没有引入第二套 Web 框架。Flue 仅保留开发回归和历史材料，便携产物有依赖图门禁。

Cloudflare 和 Vercel 的完整应用技术基线已有真云部署、鉴权、隔离、设置持久化与升级证据；Vercel 另外被动观察了停止 Sandbox 后的原生队列重新挂载和维护。具体证据及局限见[部署验证](../probes/deployment/README.md)。安装向导和真实 owner 邮件仍待授权配置，按钮保持暂缓。最初“全平台知识检索”的目标尚未全部完成：Node/Vercel 默认没有 Workers AI/Vectorize 等价适配，不以关闭能力冒充功能一致。跨平台完整停机迁移与跨服务灾备也不由本次基础验证推定通过。

项目许可证按用户明确选择落实为 MIT；各目标锁文件及第三方条款独立检查。旧版本升级要求先暂停并收尾 Flue 运行，保留原检查点/回执，原生检查点不跨宿主直接转换。

## 5. Ozon 能力验证表

官方入口为 [Ozon Seller API](https://docs.ozon.ru/api/seller/)。本次读取该入口出现重定向循环，未获得可核对的完整正文。社区 SDK/镜像只用来发现需要核实的问题，不作为方法版本、套餐或时间窗口的施工依据。

| 编号 | 必须确认的问题 | 所需证据 | 未确认时的行为 |
| --- | --- | --- | --- |
| OZ-01 | 当前店铺鉴权字段、角色与凭证生命周期 | 官方说明及授权测试响应 | 不保存为“全部能力已连接” |
| OZ-02 | 买家聊天列表和历史是否可读、分页与回调能力 | 官方方法版本、脱敏响应及游标测试 | 只显示已验证数据来源 |
| OZ-03 | 哪些会话可回复、是否要求特定套餐/订阅、文本限制 | 官方权限/窗口与真实店铺结果 | 自动回复不开启 |
| OZ-04 | 主动建聊与 FBO/FBS/rFBS 的关系 | 分履约方式样本，成功/失败/时间边界 | 主动通知不可启用 |
| OZ-05 | 售前商品问答与私聊是否分别可读写 | 官方入口与商品关联样本 | 不宣称全面售前覆盖 |
| OZ-06 | 商品、价格、库存和政策可读取的字段 | 数据合同和更新时间定义 | AI 不推测缺失数据 |
| OZ-07 | 订单、包裹、取消/退货/待取件/签收状态 | 实际枚举、变更样本和多包裹测试 | 未映射状态不触发通知 |
| OZ-08 | Webhook 验证、重试、顺序及事件 ID | 官方签名/来源规则、重放测试 | 使用已授权轮询；不接收未经验证事件 |
| OZ-09 | 发送响应含义、请求幂等、历史核对能力 | 接收成功/超时/回显的真实证据 | 结果不明转 unknown，禁止盲重发 |
| OZ-10 | 接口级/店铺级速率限制和退避语义 | 官方限额及 429 样本 | 保守限流、持续观测，不写死未经证实额度 |
| OZ-11 | 图片、文件和下载 URL 边界 | 类型、大小、有效期、来源规则 | 文本优先，附件功能关闭并解释 |
| OZ-12 | 评价邀请、优惠券、营销通知的允许内容和触达范围 | 平台适用规则、商家权限和模板审核 | 不自动发送未经确认的营销/评价激励内容 |

能力记录至少包含：平台文档链接/版本、核对时间、店铺授权类型、履约模式、方法、输入、脱敏结果、限制、失败原因、结论和复核人。不得在此表贴真实 API Key。

## 6. 平台约束及其工程影响

| 已核对事实 | 影响 | 官方来源 |
| --- | --- | --- |
| Workers Static Assets 可与 Worker API 组合 | 工作台与 API 同域，减少 CORS/多项目部署配置 | [Static Assets](https://developers.cloudflare.com/workers/static-assets/) |
| 部署按钮可自动配置多类资源，支持迁移脚本 | 仍需验证 Flue 生成绑定与资源发现顺序 | [Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) |
| D1 付费单库上限 10 GB，单库查询串行处理 | 先控制保留期/索引，接近容量或吞吐边界时独立迁移评审 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| D1 batch 可组成原子语句组；session 提供顺序一致性 | 本地事务可用，但不当成跨资源或任意 await 事务 | [D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/) |
| DO 存储提供事务与强一致 | 控制版本和发送意图在单个对象内协调 | [DO storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| Queues 至少一次投递 | 所有消费者按业务键去重，不能依赖只执行一次 | [Delivery guarantees](https://developers.cloudflare.com/queues/reference/delivery-guarantees/) |
| 队列消息/延迟/保留期与执行时长有边界 | 大数据放 R2；长等待用 due_at；任务拆批 | [Queues limits](https://developers.cloudflare.com/queues/platform/limits/) |
| Vectorize 写入/删除异步生效 | 发布就绪和撤回需要业务版本二次检查 | [Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/) |
| Vectorize 元数据过滤与 namespace 可限制范围 | 范围由服务端决定，仍需检索后授权校验 | [Metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) |
| D1 Time Travel 只恢复对应数据库 | 不能代替 DO/R2/索引共同恢复及外部发送对账 | [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) |
| Vercel Workflows 有持久执行能力 | 可作为后续适配候选，但不是 Flue 完整兼容证据 | [Vercel Workflows](https://vercel.com/docs/workflows) |
| Vercel 部署按钮能指定环境变量及集成 | 部署 UI 简化不代表执行模型已经适配 | [Deploy Button](https://vercel.com/docs/deploy-button) |

平台数字按本次读取日期记录，实施锁定版本和上线前重新核实；费用需要实际使用量及当时价目表计算。

## 7. 开源许可证与素材

以下是已读取仓库许可证的基础记录，正式发布仍需检查锁定依赖及其传递依赖，而不只检查顶层名称。

| 项目 | 核对结果 | 来源 |
| --- | --- | --- |
| Flue | Apache-2.0 | [LICENSE](https://github.com/withastro/flue/blob/main/LICENSE) |
| Better Auth | MIT | [LICENSE](https://github.com/better-auth/better-auth/blob/main/LICENSE.md) |
| Drizzle ORM | Apache-2.0 | [LICENSE](https://github.com/drizzle-team/drizzle-orm/blob/main/LICENSE) |
| shadcn/ui | MIT | [LICENSE](https://github.com/shadcn-ui/ui/blob/main/LICENSE.md) |
| Hono | MIT | [LICENSE](https://github.com/honojs/hono/blob/main/LICENSE) |
| Valibot | MIT | [LICENSE](https://github.com/open-circle/valibot/blob/main/LICENSE.md) |
| json2csv | MIT | [LICENSE](https://github.com/juanjoDiaz/json2csv/blob/main/LICENSE.md) |
| csv-parse | MIT | [官方包清单](https://github.com/adaltas/node-csv/blob/master/packages/csv-parse/package.json)；锁定 7.0.3，实际安装包 LICENSE 已保留 |

DingBell 自身许可证已按用户明确选择落实为 MIT，见 [LICENSE](../LICENSE)；2026-10-08 原稿建议 Apache-2.0 的决策已被替代。云平台、模型和邮件服务属于使用者自行配置的外部服务，不因 SDK 开源而变成开源或免费基础设施。

当前设计说明记录 Obra shadcn/ui Community Edition 来源及 CC BY 4.0 归属要求。发布 UI 素材前核对[原始社区文件](https://www.figma.com/community/file/1514746685758799870)及下载版本，保留适用归属说明；不把第三方 Figma kit 与 shadcn/ui 代码许可证混为一谈。字体、Lucide 图标和新增组件同时进入素材清单。

## 8. 仍需实测的关键事项

| 编号 | 问题 | 验证阶段 | 失败后的确定动作 |
| --- | --- | --- | --- |
| V-01 | flueWorkerConfig() 与部署按钮能否组合创建资源及正确迁移 | 1 | 修复部署模板后再开发依赖该模板的功能，不能宣称一键部署 |
| V-02 | 已确认的 dispatch/read/abort 与幂等在实际云端的组合；删除/备份公共路径仍需确认 | 1 | 调整边界/向上游确认；不直接改私有表绕过 |
| V-03 | Ozon 私聊、问答、主动通知的实际权限 | 1、3 | 关闭不可用能力，明确调整首版对外范围 |
| V-04 | AI Search 能否满足 ADR-08 六项门槛 | 1 | 未通过则使用已描述的 Vectorize 基线，不维护双实现 |
| V-05 | D1 CSV 原子快照的时间和资源限制 | 4、7 | 调整公开导出上限或另行设计快照，不能返回部分成功 |
| V-06 | 中俄文 FTS5 查询体验与成本 | 4 | 调整搜索范围/分词方式并同步 UI 说明；不进行无界主库扫描 |
| V-07 | 云端恢复与删除跨存储完整性 | 1、9 | 未通过不接入真实客户数据或不放行生产 |
| V-08 | 模型质量、翻译与运行成本 | 6、9 | 改模型/知识/范围，保持人工辅助模式 |
| V-09 | 商业支付、经营主体、币种及套餐口径 | 8 | 开源版照常独立验收，真实收费保持关闭 |

## 9. 评审记录模板

每项变更记录：关联需求/ADR、原决定、调整后的决定、原因、受影响表/API/UI/任务、迁移与回滚、验收变化、批准人及日期。

方案批准表示允许进入对应施工阶段，不表示本文件中“待实测”的事项已通过。实际实施以证据更新结论，并把重大范围变化交回评审。

## 10. 中俄嵌入初测补充（2026-10-10）

沿用已实现的 `@cf/baai/bge-m3` 和 1024 维 profile。模型发布者说明支持多语种，查询无需另加检索指令前缀；本次使用既有分块与原问题，没有新增推理框架或依赖。[模型发布者](https://huggingface.co/BAAI/bge-m3)。Cloudflare 当前生成的参数表与 `text` 示例不一致，本次 3 批实测仍使用已有 `text` 与关闭截断的合同，全部返回预期维数，不根据文档表格静默更换适配器。[Cloudflare 模型页](https://developers.cloudflare.com/workers-ai/models/bge-m3/)。

在用户已有账号的 Safari 用量页观察到每日约 0/10k 神经元、过去 24 小时嵌入约 0.05 后，执行 48 段合成输入（4701 UTF-8 字节）的有限试验；没有修改订阅或生产配置。免费额度是账户共享额度，控制台有舍入/延迟，后续仍应按实际用量核对，不能把本次结果宣传为无限或生产免费。[计费规则](https://developers.cloudflare.com/workers-ai/platform/pricing/)。

初测保留了真实向量、逐批尝试/结果、数据集摘要和全部题目排名。28 个正例均命中第一名，但与 8 个无依据问题的分数范围重叠；不能将余弦分数直接转换为回答可靠性。本地精确排序只提供语义组件证据，不改变 ADR-08 的唯一检索实现约束，不增加另一条生产检索管道。实际生产问答、更大/困难语料、托管索引及生成前后依据检查继续按独立门槛实施，详见实施进度第 61 节。
