# DingBell 架构设计

版本：0.2，评审稿。日期：2026-10-08。首版目标：Cloudflare 上的开源、多租户、AI 与人工协作客服系统。

**2026-10-29 架构更新：** 完整部署目标已扩展为 Cloudflare、Vercel、自建服务器，采用共用业务核心、Pi Durable 与平台适配层。以[ADR-11](04-research-and-decisions.md#adr-11-共用核心与三个完整部署目标2026-10-29)确定新方向与迁移验收。2026-10-30 的实际运行时与业务适配见[7.74](#774-pi-durable-与三种宿主2026-10-30)及[部署证据](../probes/deployment/README.md)。下文 Flue 章节保留历史 Cloudflare 合同和升级依据；原回执、预算和发送保护继续保留。

本文件给出拟实施合同。Flue、Cloudflare 和 Ozon 的能力边界见[调研与决策](04-research-and-decisions.md)；阶段与验收见[实施计划](01-implementation-plan.md)和[验收清单](03-acceptance.md)。

## 1. 架构原则与技术基线

1. 一个 TypeScript 工程、一个主要应用 Worker，按业务模块组织；模块不是微服务。
2. 复用 Flue 的模型、工具与持久执行；复用 Hono 路由，不额外增加另一套后端框架。
3. 用成熟库处理身份、表单、类型、CSV 等通用能力；自己实现公司隔离、客服状态和发送正确性。
4. 业务规则保存为有结构、经校验的配置；权限、收件人校验、幂等和预算检查由确定性代码执行。
5. 公共 HTTP/API、数据库、对象存储及第三方平台之间没有全局事务；跨边界通过持久记录、幂等与核对恢复。
6. 所有对消费者产生副作用的出口必须受控。AI 最终文本和内部工具输出不能直接等同于已发送客户消息。

| 层 | 首版选择 | 边界 |
| --- | --- | --- |
| 页面 | React、Vite、TypeScript、shadcn/ui、Lucide | SPA 工作台；产品官网的 SEO 单独评估 |
| 页面数据 | TanStack Query、TanStack Table、React Hook Form | 不再同时增加多个全局状态管理库 |
| 路由与 API | Hono、Hono RPC、Valibot | 共用输入合同；所有运行时边界仍做校验 |
| 身份与组织 | Better Auth、Organization 插件、D1 支持 | 公司数据和店铺权限仍由业务层限制 |
| AI | Flue | 不叠加 LangChain/Mastra 等第二套执行框架 |
| 业务数据库 | D1、Drizzle | 主库保存业务记录；认证表由 Better Auth 官方生成方案管理 |
| 搜索 | 独立派生 D1 搜索库的 FTS5 | 可重建；不与主库备份混在一起 |
| 会话协调 | 自有 ConversationController Durable Object | 只管客服控制状态、命令去重、发送意图和结果 |
| AI 持久化 | Flue 生成的 Durable Object | 保存 Flue 的会话及执行状态，不手写替代品 |
| 店铺协调 | 自有 StoreCoordinator Durable Object | 同步游标、并发租约与共享 API 限流；不保存全量订单正文 |
| 异步任务 | Cloudflare Queues、Cron Triggers | 同步、导入、通知、导出；AI 执行由 Flue 自己负责 |
| 文件 | 私有 R2 | 附件、知识原文件、导出和备份 |
| 知识检索 | Vectorize 为基线；AI Search 按 ADR-08 优先验证替代 | 只实施一套；元数据、发布事实与权限仍在 D1 |
| 邮件 | Resend 为首个候选，封装小型邮件接口 | 邮件服务须配置；缺失时明确禁用邀请邮件/找回邮件 |
| CSV | json2csv 的 WHATWG 实现 | CSV 转义及流式格式化；公式防护和权限由应用实现 |
| 监控 | Flue 事件、Workers 日志与指标 | Sentry 等外部平台可选，不作为自部署启动条件 |
| 商业订阅 | Better Auth Stripe 插件为候选 | 模块可关闭；实际支付供应商待经营条件确认 |

Hono RPC 可共享 API 类型，标准 Schema 校验可使用 Valibot。此处复用其合同能力，不据此免除权限检查。[Hono RPC](https://hono.dev/docs/guides/rpc)

## 2. 总体拓扑

~~~mermaid
flowchart LR
    UI[React 工作台] --> API[Hono API 与 Better Auth]
    OZ[Ozon 回调或轮询] --> IN[接收与规范化]
    API --> DB[(D1 业务主库)]
    IN --> DB
    DB --> OUT[持久 Outbox]
    OUT --> Q[Cloudflare Queues]
    CRON[Cron 调度与补偿扫描] --> OUT
    Q --> CC[ConversationController DO]
    Q --> SC[StoreCoordinator DO]
    CC --> FLUE[Flue 客服 Agent DO]
    FLUE --> TOOLS[受控业务工具]
    TOOLS --> CC
    TOOLS --> DATA[知识与订单查询]
    CC --> SEND[唯一平台发送出口]
    SEND -->|申请限流许可| SC
    SEND --> OZAPI[Ozon API]
    CC --> DB
    API --> FILES[(私有 R2)]
    DATA --> DB
    DATA --> VECTOR[(Vectorize)]
    API --> SEARCH[(派生搜索 D1)]
~~~

图中的模块默认属于同一个应用部署。自有 DO 与 Flue DO 的职责不同：前者管理客服业务的授权状态及外发，后者运行 AI。额外的协调对象用于补齐 Flue 未提供的业务功能，不重新实现 Agent 调度。

Flue 提供公开的 extend({ base, wrap }) 扩展，可使用底层 Agents SDK 的定时、队列与自定义方法。单 Agent 的这些需求优先复用；是否合并业务控制对象须验证接管顺序、删除与备份边界，当前仍以独立业务控制为基线。不能覆盖 Flue 的 fetch、onRequest、alarm、onFiberRecovered 等保留生命周期。[文档与源码核对](05-flue-documentation-audit.md)

StoreCoordinator 返回限流许可，不替控制对象排队后自行发送。真正的平台请求仍由 ConversationController 的统一出口发起，确保等待限流后仍会重新检查人工接管状态。

本图的知识路径描述 Vectorize 基线。如果阶段 1 的 ADR-08 验证通过，Vectorize 与自建索引任务由 AI Search 托管检索替代，其余业务边界不变；随后更新资源表，只部署一种检索实现。

### 2.1 运行时资源

| 资源 | 用途 | 首版约束 |
| --- | --- | --- |
| ASSETS | Vite 构建的静态工作台 | API 路径优先进入 Worker，SPA 回退不吞掉 API 错误 |
| DB | 组织关联的业务表、任务与审计 | 初期单库；所有查询有公司/店铺范围 |
| SEARCH_DB | 原文与译文的派生全文索引 | 可丢弃重建，不参与发送决策 |
| FILES | 附件、知识、导出 | 私有 bucket，业务下载经权限检查 |
| BACKUPS | 恢复包与清单 | 单独权限/保留策略；不能与删除正文的生命周期混用 |
| WORK_QUEUE 与 DEAD_LETTER_QUEUE | 业务后台作业 | 用任务类型和并发限制隔离；有证据显示互相阻塞后再拆队列 |
| CONVERSATION_CONTROLLER | 每个业务会话一个控制对象 | ID 从服务器确认的公司/店铺/会话派生 |
| STORE_COORDINATOR | 每个店铺一个协调对象 | 全店铺 API 调用共享限流，不只限制同步任务 |
| Flue 生成绑定 | 每个客服 Agent 的运行对象 | 由构建集成生成；业务使用生成类型与稳定 Agent 身份，不复制生成类实现 |
| KNOWLEDGE_INDEX | 知识向量索引 | 嵌入模型与维度固定到索引版本 |

Cloudflare 部署按钮可创建多种资源，但 Flue 构建集成与资源发现的组合必须在全新项目实测。当前源码采用 plugins: [flue(), cloudflare({ config: flueWorkerConfig() })]；Cloudflare Vite 插件读取源 Wrangler 配置并生成部署配置，Flue customizer 补充 Agent 绑定和兼容要求。应用资源与完整 DO 迁移由项目维护；不依赖旧教程的 .flue-vite.wrangler.jsonc。Cloudflare 目标不配置 Node 的 src/db.ts。[部署按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[固定版本配置实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/vite/src/cloudflare-worker-config.ts)

### 2.2 拟定工程结构

~~~text
src/
  app.ts                    Hono 路由、身份与权限中间件
  cloudflare.ts             业务 DO、queue 与 scheduled 导出
  agents/support.ts         Flue 客服 Agent
  web/                      页面、组件、路由、局部状态
  contracts/                API DTO、Valibot Schema、错误码
  modules/
    identity/               Better Auth 配置、组织权限映射
    stores/                 店铺连接、凭证、能力检查
    conversations/          接待状态、消息、备注、发送服务
    knowledge/              来源、版本、导入、检索
    policies/               自动回复、通知、发布与测试
    audit/                  业务日志、查询、分析、导出
    usage/                  技术用量、配额、预算
    billing/                可选商业支付
  connectors/
    ozon/                   官方接口客户端、转换、限流、错误分类
    fake/                   确定性测试平台，生产模式禁用
  jobs/                     持久任务处理和补偿
  platform/cloudflare/      D1、R2、DO、队列的具体接入
db/migrations/              顺序执行、已提交的主库 SQL 迁移
db/search-migrations/       可重建搜索库迁移
tests/                     单元、合同、集成、端到端、评估夹具
docs/                      产品、架构、验收、部署与排障
~~~

不预先创建空插件框架、多云通用 ORM 或每模块独立包。只隔离已经真实存在差异的连接器、邮件和平台调用；Vercel 适配时基于实测增加实现。

## 3. 数据归属与一致性

### 3.1 哪个地方保存最终依据

| 数据 | 权威来源 | 其他位置的用途 |
| --- | --- | --- |
| 用户、成员、角色、有效会话 | Better Auth 对应 D1 表 | 页面缓存不决定最终权限 |
| 店铺归属、凭证版本、启用开关 | D1 主库 | Coordinator 只使用带版本的缓存 |
| 客服接待、负责人、控制版本、发送意图 | ConversationController 的事务存储 | D1 是供列表、日志和分析读取的投影 |
| 平台订单、物流与平台消息 | 平台返回的可核对记录 | 本地保留带来源时间的副本，不能编造平台状态 |
| AI 执行历史和提交状态 | Flue 持久化 | 业务库保存关联 ID、状态、依据及用量摘要 |
| 知识源、发布指针与策略版本 | D1 主库 | Vectorize 和搜索库都是派生索引 |
| 文件字节 | R2 | D1 保存归属、校验和、尺寸与状态 |
| 支付订阅事实 | 支付平台经验证的对象 | D1 保存同步状态和业务权限 |

“权威来源”不意味着平台状态已经由本地发起改变。例如收到 Ozon 请求成功响应，只有当接口语义确认为消息接受成功时才标记已发送；投递、已读分别按平台是否提供数据展示。

### 3.2 本地事务与跨资源事务

- D1 可使用 batch 执行原子语句组；不要把 SQLite/D1 假设成支持任意跨 await 的交互事务。
- ConversationController 用自己的事务存储同时更新控制版本、命令结果及领域事件。
- D1 与 DO、Queues、R2、Vectorize、Ozon 之间没有共同事务。
- 写入本地事实和 Outbox 同时提交。队列只是唤醒方式；重复队列消息按任务键去重。
- DO 的领域事件带单调递增 sequence。写入 D1 时按对象 ID 与 sequence 唯一约束，投影只接受更新版本。
- 每次对外承诺“已保存”时，至少已有对应权威存储的可靠记录；D1 投影落后时显示同步中，不回退已确认状态。

[D1 batch 与会话一致性](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[DO 事务存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

### 3.3 补偿与恢复路径

1. 入站：D1 中原子写入规范化事件、入站消息和 ingest outbox，提交成功后确认回调或推进轮询水位。控制对象引用消息 ID，不再保存另一份全量聊天正文。
2. 分发：队列消费者把事件交给 ConversationController；后者按事件 ID 返回第一次处理结果。
3. 控制：控制对象提交状态变更和领域事件后返回；向 D1 投影失败不撤销已接受命令。
4. 唤醒：原有队列消息在关键结果持久化前不确认；定时扫描逾期任务/未投影会话，重新询问控制对象。
5. 核对：D1 的会话目录保存对象身份和最后投影 sequence，支持从控制对象读取缺失的领域事件。
6. 清理：领域事件在投影确认并纳入恢复检查点后才能按保留策略压缩；不能先删除唯一可恢复记录。

首次创建控制对象前先提交 D1 会话目录，防止产生无法枚举的孤立对象。控制对象只向已确认关联的公司/店铺写入事件。

## 4. 多租户、身份与权限

### 4.1 租户边界

- 使用 Better Auth 的 organization 作为公司，不另建一套平行组织账号体系。
- 平台店铺、消费者标识与会话属于公司和店铺；同一消费者显示名不能用于跨店合并身份。
- 业务请求的 organization_id 由已验证会话与选择的公司共同确定，服务器再验证成员关系。
- 外部回调通过店铺绑定和已验证的来源确定公司，禁止信任请求体中的公司 ID。
- 后台任务记录公司、店铺及发起人；任务执行和下载阶段再次检查有效授权。
- D1 没有在本方案中提供自动行级安全，ORM 和组织插件也不会自动隔离所有业务表。
- 复合唯一约束及查询条件同时包含归属范围；关联实体必须属于同公司同店铺。

### 4.2 首版权限矩阵

| 操作 | 所有者 | 管理员 | 客服 |
| --- | --- | --- | --- |
| 查看消息与上下文 | 全公司 | 全公司或被限制店铺 | 已授权店铺 |
| 认领、回复、备注、接管 | 是 | 是 | 已授权店铺 |
| 转交会话 | 是 | 是 | 同店铺授权成员之间 |
| 查看业务日志 | 是 | 是 | 已授权店铺，不含部署运维秘密 |
| 导出客户数据 | 是 | 是 | 默认否，需明确授予 export 权限 |
| 编辑知识/策略草稿 | 是 | 是 | 可按公司权限授予 |
| 发布知识/策略、启用自动化 | 是 | 是 | 否 |
| 连接、轮换或解绑店铺 | 是 | 是 | 否 |
| 邀请和调整普通成员 | 是 | 是，不能修改所有者 | 否 |
| 转移所有权、删除公司 | 是，二次身份确认 | 否 | 否 |
| 账单、套餐和预算上限 | 是 | 默认仅查看用量 | 仅自己的业务提示 |
| 平台运维与总开关 | 独立部署运营权限 | 不由商家公司角色推导 | 否 |

成员停用后新请求与新任务拒绝授权，活跃订阅/轮询失效。已经发往平台的网络请求不能被事后当作从未发生，必须保留审计结果。

### 4.3 初始账号与邀请

- 初次部署由安装令牌认领，令牌为部署者独有的随机 Secret。用原子条件更新认领唯一初始化任务，状态为 unclaimed → provisioning → initialized；身份与组织创建复用 Better Auth 公共接口，不能假定这些调用与安装状态属于共同事务。
- 初始化步骤记录完成位置并可恢复；失败重试只完成同一认领任务，不创建第二个所有者。provisioning 期间拒绝其他认领者；只有已验证的部署者可恢复或重置失败任务。完成后关闭安装入口，不能因超时自动重新开放认领。
- 本地开发使用隔离测试账户；生产没有固定账号、默认密码或自动升级角色入口。
- 邀请绑定公司、规范化邮箱、角色、店铺范围和有效期；接受者验证邮箱，不能由邀请者任意替别人接受。
- 撤销、过期、重复接受均有稳定结果；最后一个所有者不能被停用或移除。
- 自部署注册默认关闭，邀请可用；托管版允许创建公司但有邮箱验证与速率限制。
- 邮件服务未配置时显示明确的部署待配置状态，不显示“邮件已发送”。

Better Auth 提供组织、成员、邀请与角色基础能力，本表中店铺和业务动作权限由 DingBell 补齐。[Organization 插件](https://better-auth.com/docs/plugins/organization)

### 4.4 成员变更的原子边界（阶段 2A 已实施）

- 公司角色只接受 `owner`、`admin`、`member` 单值。管理员可调整和移除非所有者（含其他管理员及自己）；授予、降级或移除所有者仅限所有者，并在同一请求内验证操作者当前密码。交接分为先增加所有者、再调整原所有者两步，不宣称是一次原子转让。
- 当前 Better Auth 1.7.7 的成员更新/删除最终仅按成员 ID 写入，最后所有者检查也发生在写入之前。D1 不支持交互事务，因此这两条业务命令使用范围很窄的条件 SQL；身份、会话和密码验证仍使用官方 SDK，不建立第二套成员表或认证系统。
- 最终写入同时匹配公司、目标 ID、`expectedRole`，并检查操作者当前角色、有效 session 和已验证邮箱。目标提升为所有者、操作者降权或 session 撤销之后，旧请求不能凭早先检查继续修改。
- `0004_membership_guards.sql` 在数据库写入时保护最后所有者，覆盖删除、降级、改公司和替换用户。触发器属于手工业务迁移，重新生成官方认证 schema 时不能丢弃；尚未提供公司/账号删除入口。
- 所有者密码确认走官方 HTTP handler 的数据库持久限流，当前窗口为每 60 秒 5 次。原生 `/verify-password` 不作为 DingBell 的独立公开入口。
- 请求审计记录操作者、公司、目标成员、原角色、目标角色及结果；`started` 表示尝试，只有 `succeeded` 表示确认完成，删除的目标角色为 null。审计意图保存失败时不写成员，结果审计失败时返回待确认。前端重新读取身份和公司信息，不自动重放写请求。
- 移除仅撤销该公司的成员资格；历史审计、已完成邀请凭据、账号及其他公司权限保留。每个新请求实时校验成员关系，已有前端在重新验证时清除旧权限页面；未来长连接及排队业务任务仍须另行验收。

## 5. 数据模型合同

阶段 2A 店铺权限首批落地边界：所有者和管理员管理公司内全部店铺，普通成员仅能读取明确授权的店铺元数据和能力状态。暂未实现“管理员被限制店铺”或细分回复/导出权限。授权绑定 `member.id`，移除成员会级联删除授权；同一账号重新加入公司也必须重新授权。未来消息、任务与下载处理必须沿用此范围，但不能用当前元数据接口验证代替那些流程的验收。

### 5.1 通用规则

- 内部 ID 使用不可猜测的字符串；平台 ID 即使看似整数也以原字符串保存，避免 JavaScript 大整数精度损失。若平台在 JSON 中返回超安全范围的数值 ID，连接器必须先做无损 JSON 解析再转字符串，不能先 JSON.parse 再 String；优先采用已验证的现成无损解析库。
- 时间保存 UTC 时间戳；同时记录平台事件时间、接收时间、处理时间。展示及策略静默时段使用公司 IANA 时区。
- 金额为币种加最小单位整数；百分比等结构化数值按 Schema 校验，不以浮点字符串自由混用。
- 常用查询字段结构化；原始响应 JSON 只作证据和兼容缓冲，不能代替业务索引。
- 客户消息正文默认不可覆盖；译文、编辑预览与发送结果单独存储或版本化。
- 表和索引名称最终由迁移确定，下面是逻辑实体合同。

### 5.2 逻辑实体

| 实体 | 必需字段或关系 | 关键约束 |
| --- | --- | --- |
| Auth 实体 | user、session、account、verification、organization、member、invitation | 使用插件生成结构；不重复手写密码和会话实现 |
| company_settings | organization_id、timezone、locale、work_hours、retention、budget、version | 每公司一条当前配置，变更审计 |
| store | organization_id、platform、platform_store_id、status、credential_version | 公司内同平台店铺唯一；停用不删历史 |
| store_secret | store_id、encrypted_payload、key_version、nonce、updated_at | 无明文返回 API；加密附带公司和店铺上下文 |
| store_capability | store_id、capability、status、reason、checked_at、expires_at | unknown/available/denied/unsupported 分开 |
| store_grant | organization_id、store_id、member_id、permissions | 成员与店铺必须同公司 |
| customer_ref | organization_id、store_id、platform_customer_id、display_name | 按店铺关联；缺少稳定平台 ID 时不跨会话猜测合并 |
| conversation | scope、channel_type、platform_thread_id、controller_id、last_sequence、status_projection | 归属加平台线程唯一；控制字段只是 DO 投影 |
| conversation_order | conversation_id、order_id、posting_id、association_source | 多对多关联，未确认关系不自动授权查询 |
| message | scope、conversation_id、platform_message_id、sender_type、direction、body、language、event_at、received_at | 入站平台消息唯一；内部备注具有独立类型 |
| message_translation | message_id、source_hash、target_language、text、model、version、confirmed_by | 原文改变时旧译文失效；人工确认版本可追溯 |
| send_intent | intent_id、conversation_id、body_hash、recipient_ref、source、source_run_id、control_epoch、input_revision、policy_version、source_refs、state | 权威记录在控制 DO；D1 保存投影；AI 来源绑定不可变运行；引用记录修订版 |
| send_attempt | intent_id、attempt_no、request_started_at、response_at、result_class、platform_receipt | 不存秘密请求头；未知结果不可伪造成功或失败 |
| conversation_event | conversation_id、sequence、event_type、actor、payload、occurred_at | 同会话 sequence 唯一，只追加 |
| product_snapshot | scope、platform_product_id、variant、facts、source_updated_at、synced_at | 区分已过期数据和当前查询结果 |
| order_snapshot 与 posting_snapshot | scope、platform_order_id、posting_id、status、status_at、synced_at | 一个订单可有多个包裹，不能把局部状态冒充整单状态 |
| knowledge_document | scope、type、title、product_ref、active_revision_id | 公司通用与店铺专用可区分 |
| knowledge_revision 与检索片段引用 | document_id、revision、source_hash、content_ref、index_version、provider_ref、status | 修订版不可覆盖；自建或托管分块均可追溯，不重复保存整套索引 |
| reply_policy 与 policy_version | organization_id、logical_rule_id、kind、scope、priority、revision、config、published_at | 自动回复/主动通知独立发布；版本不可变 |
| ai_run | run_id、conversation_id、trigger_id、epoch、input_revision、runtime_id、dispatch_key、payload_ref、payload_hash、submission_id、response_id、policy_version、status、usage | 提交前冻结目标、键、载荷与授权版本；运行关联由服务器设置；共享 response 不重复计量 |
| integration_event 与 job | scope、type、dedup_key、payload_ref、cursor、state、attempt、due_at、lease_until | 重复投递只推进同一任务；保留任务结构版本 |
| outbox | owner_ref、event_id、topic、next_attempt_at、acknowledged_at | 本地事实和 outbox 同事务产生 |
| attachment | scope、object_key、hash、content_type、size、status | 先验证归属和文件状态，再提供下载 |
| export_job 与 export_row | requester、frozen_filters、selected_ids、snapshot_at、state、object_key、expires_at | 任务绑定权限；临时快照行有自动清理期限 |
| audit_event | scope、actor、action、resource、request_id、before_after_summary、at | 应用层只追加；不宣称可防数据库管理员篡改 |
| usage_event 与 entitlement | scope、source_id、metric、quantity、period、subscription_ref | 计量唯一键；配额与技术成本分开 |
| usage_reservation | scope、run_id、period、reserved_units、settled_units、state、expires_at | 同一运行唯一；预留、结算与释放幂等 |
| deletion_job 与 restore_manifest | scope、resources、checkpoint、status、operator | 跨存储删除/恢复可核对，可中断恢复 |

### 5.3 最低索引要求

**当前店铺物理实现（0005_stores.sql）：**上表仍是逻辑实体合同。首批将 `store_secret` 的完整密文信封和 `store_capability` 当前快照合并在 `store` 单行，连同凭证版本、数据版本及检查租约进行条件更新，避免拆表后出现凭证与版本部分写入。`store_grant` 通过复合外键同时限定店铺和成员属于同公司；新增 `member(id, organization_id)` 唯一索引支撑此约束。`store_audit_event` 单独保存操作者、动作、目标成员、前后版本与结果，不保存凭证材料，也不随成员删除。尚未创建其他业务逻辑实体。

1. 会话列表：organization_id、store_id、work_state、last_activity_at、id；负责人队列另建 member_id 前缀索引。
2. 消息分页：organization_id、conversation_id、event_at、id；平台消息唯一键包含店铺和渠道。
3. 审计：organization_id、occurred_at、id；常用资源和事件类型按实测补索引。
4. 任务：state、due_at、lease_until；dedup_key 唯一。
5. 投影：controller_id、sequence 唯一；保存最后投影 sequence。
6. 知识：organization_id、store_id、status、document_id、revision。
7. 发送：intent_id 唯一；conversation_id、state、created_at 用于待发送/待核对查询。

使用 EXPLAIN QUERY PLAN 和 rows_read/rows_written 验证实际查询。禁止用新增大量无使用证据的索引换取“看起来完整”。

## 6. 会话状态与控制命令

### 6.1 分开建模的三个维度

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| 生命周期 | open、resolved、archived | 平台新消息可重新打开 resolved；归档是本地组织方式 |
| 接待方式 | ai、human、paused | 谁可以产生下一次自动回复 |
| 工作状态 | needs_reply、waiting_customer、waiting_internal；resolved 时为 null | 当前等待谁，独立于负责人 |

assigned_member_id 允许为空，表示未分配。AI 运行中是执行状态而非生命周期。页面上“待我”“未分配”“全部”是这些字段与权限组合出的视图。

业务阶段 presale/order/aftersale/unknown 用于分流和分析；AI 判断可被人工修正，不能据此授权访问未关联订单。

### 6.2 命令合同

| 命令 | 前提 | 持久效果 | 对 AI 的影响 |
| --- | --- | --- | --- |
| claim | 未分配，成员有店铺权限，expectedVersion 一致 | 设置负责人和新版本 | 若同时接待切换，按 takeover 处理 |
| takeover | 有接管权限 | reception=human；control_epoch 增加；取消未开始的 AI 意图 | 请求 abort；旧 epoch 的后续输出被拒绝 |
| transfer | 目标成员有效且有同店铺权限 | 负责人改变、版本增加、审计原因 | 保持人工接待，避免转交时自动恢复 AI |
| resume_ai | 明确操作，有有效策略与渠道能力 | reception=ai，新 epoch | 默认仅处理此后新输入；补处理旧消息需明确选择 |
| resolve | 有处理权限，操作者确认结束 | lifecycle=resolved，control_epoch 增加 | 暂停当前运行并取消尚未发送的自动回复 |
| reopen | 新有效客户消息或人工操作 | lifecycle=open，needs_reply | 人工接管过的会话保持人工，直到显式恢复 AI |
| set_work_status | open，会话访问权限有效，expectedVersion 一致 | 设置待回复/等待消费者/等待内部，保留负责人和接待方式 | 不恢复 AI、不产生客户回复 |
| add_note | 有会话访问和备注权限 | 创建 internal_note | 不触发客户外发，不计首次响应 |

命令携带 command_id 与 expectedVersion。相同操作者和载荷的重复 command_id 返回首次回执，并另带当前权威状态；并发版本冲突返回 409，客户端重新 GET 当前权威状态再决定下一次操作，不以最后写入静默覆盖。

### 6.3 阶段 4B1：持久人工控制

阶段 4A 的只读页面没有客服控制状态。4B1 增加认领、接管、解决及刷新后恢复；不把接口成功等同于平台已回复，也不在此次切片承诺 AI 中止或新消息自动重开。当前 GET `/api/companies/:companyId/conversations/:id/control` 返回控制状态，POST 同范围的 `/commands` 接受严格的 `commandId`、`expectedVersion`、`action`。认领设置当前 member 为负责人并切人工；接管保留负责人；解决只改变 lifecycle，保留 reception 和负责人作为后续重开的上下文。已解决状态拒绝新的认领、接管和解决命令。

1. 每个控制对象固定公司、店铺和内部会话 ID。D1 先持久化可枚举的对象目录，再调用 DO；旧会话首次控制的初始状态为 open、paused、未分配。负责人使用当前公司的 `member.id`，不能用 `user.id` 代替。
2. 同一个 DO 事务保存状态、命令回执和待投影审计事件。授权查询和 D1 投影在事务外执行；事务内重新检查版本，不执行网络或 D1 调用。沿用已验证的 SQLite-backed DO 存储 API，不覆盖 Flue 的生命周期。Cloudflare 的[存储事务合同](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)只覆盖该对象的存储，不能当作与 D1 的分布式事务。
3. 命令严格包含 ID、期望版本和固定动作；同 ID、同操作者、同规范载荷才返回首次回执，改变任一项返回冲突。每次调用（包括重放）都在 DO 内重新核验有效 session、成员及店铺权限；普通客服不能误走只允许管理员的同步授权函数。D1 授权完成后到 DO 提交之间仍有跨资源间隙，不承诺两者同时原子撤权。
4. D1 是列表与审计的投影，以对象 ID 和事件序号去重，版本只允许前进。投影失败不回滚已经接受的命令，也不向用户报告为未保存；权威控制查询和命令回执来自 DO。前端不得用旧命令回执覆盖更高版本。
5. 持久 alarm 与目录补偿共同恢复投影；目录调度需要有界且公平推进，不能一直重扫同一批对象。Cloudflare [alarm 自动重试次数有限](https://developers.cloudflare.com/durable-objects/api/alarms/#alarm)，不能单靠抛异常保证长期故障后恢复。同事件重复投影、乱序投影、重启及投影故障必须有真实运行时测试。
6. 本切片先验收并发抢单只有一个成功、回执丢失重放不重复、撤权后不能重放、事务失败不留下半状态、投影故障仍能读到已接受结果，以及 0009 后带数据升级。转交、等待、备注、重新打开和实时输入事件随后按同一控制入口推进；不另建绕过 DO 的 D1 状态写入口。

持久目录和投影位于 `conversation_control`，操作事件位于 `conversation_control_event`；由 `0010_conversation_control.sql` 新增，不改写既有消息。首次只读未创建目录时返回固定的 version/epoch/sequence=0、updatedAt=0；首次命令先授权写目录再 RPC。对象本地状态丢失且存在 scope/回执/待投影痕迹，或本地状态落后 D1 已确认投影时，明确拒绝重建，保留故障证据；D1 投影不是可以单独恢复控制对象的备份。恢复同版本时也必须保持全部字段一致。

投影每次处理至多 20 个事件，确认 D1 batch 成功后只删除该批事件；延迟期间到达的新事件保留。alarm 持久退避 1—60 秒，分钟 Cron 有界扫描最多 50 个到期目录，并在 RPC 前推进重试时间，避免坏对象占住首批。正常目录五分钟再次检查，失败一分钟后进入补偿；同步调度与控制修复各自隔离失败。云端绑定新增 `CONVERSATION_CONTROLLER` / `ConversationController` 和 DO migration `v2`，保留既有协调器 `v1`。端到端验收及未完成边界见实施进度，不以接口存在代表完整人工客服闭环。

### 6.4 阶段 4B2：人工重新打开

已补 `reopen`，后续依次加入工作状态、转交和内部备注，不把不同的数据升级混进同一批。人工重新打开仅允许 resolved → open，保留 reception 和 assignedMemberId；版本、控制 epoch 和事件序号各加一。已是 open 返回状态冲突，重复原命令仍按首次回执重放。不消费入站事件，不自动恢复 AI，不修改平台状态。页面已解决时提供“重新打开”，沿用当前禁重复、未知结果核对和权限撤销处理。

保持状态 schemaVersion=1、DO ID/类/绑定和存储键不变。新增 `0011_conversation_reopen.sql`，仅重建 `conversation_control_event` 子表以扩展动作约束，完整保留原事件和 receipt 文本、索引、外键及触发器，不改 0010、不重建控制父表。HTTP/RPC/客户端同步扩展动作枚举。旧 Worker 不认识尚待投影的 reopen 事件，不能未经核对直接回滚；升级必须先迁移数据库再部署兼容代码。

已在本地验证：0010 带历史事件升级不改原回执；旧 resolved 会话重启后可重开；并发只有一个新动作成功；重复重开幂等；撤权不能重放；重开后重放旧 resolve 返回旧回执和当前 open；迟到的旧 resolve 投影不能再次关闭当前会话。后续加入 workStatus 时才升级状态格式，且只升级当前状态，保留旧回执和待投影事件，先归一化已知格式再比较 D1 下界，未知格式继续拒绝。

### 6.5 阶段 4B3：独立工作状态与兼容升级

新增 `set_work_status`，仅允许 open 会话在 `needs_reply`、`waiting_customer`、`waiting_internal` 之间切换。保持 reception 和 assignedMemberId，不触发消费者外发或 AI 恢复。设置为当前状态返回状态冲突；claim/takeover 保留工作状态，resolve 清为 null，reopen 回到 needs_reply。有效操作仍令 version/controlEpoch/sequence 各加一。同 commandId 重放必须连同 workStatus、expectedVersion 和操作者一起匹配。HTTP 与内部 RPC 都严格验证动作对应字段，旧动作不能夹带 workStatus。

当前状态升级为 schemaVersion=2。只识别已知 v1/v2：旧 open 归一化为 needs_reply，旧 resolved 为 null；v2 的 open 必须有三种状态之一，resolved 必须为 null。DO 在事务内先校验 scope，再将本地状态和 D1 下界归一化比较，最后按需保存 v2。格式升级本身不增加业务版本、不改时间、不产生事件，也不改旧 receipt/outbox。旧回执可以仍是 v1，响应中的当前 view 始终为 v2；浏览器比较同版本时做相同的归一化，保留原回执作为历史事实。

新增 `0012_conversation_work_status.sql`，重建控制父子表以增加 work_status 和动作约束。外键保持开启；先复制新父和新子，再先删旧子、后删旧父，恢复索引和触发器。v1 数据仍保存为 schema 1/work_status NULL，新目录显式写 schema 2/needs_reply。审计 JSON 保留既有编码顺序，避免旧回执重投时因字段顺序不同产生伪冲突；投影使用归一化状态，并保持序号单调。迟到 v1 事件可补审计，不覆盖更高版本的等待状态。

部署先迁移 D1、再部署同时兼容 v1/v2 的 Worker 和客户端。仍沿用原 DO 类、ID、绑定与存储键；没有新增 Cloudflare DO migration。数据库兼容旧行不等于旧 Worker 能读 v2 权威状态：首次升级后不能直接回退到仅支持 v1 的代码。当前切片提供详情中的工作状态操作；列表按等待状态筛选、待办数量统计和新消息自动回到待回复，随列表读模型及入站控制事件后续实施，不把历史同步当作新消息。

### 6.6 阶段 4B4：负责人转交

继续使用 schemaVersion=2 和现有 DO。新增 `transfer` 命令，携带 targetMemberId、必填转交原因（去首尾空白后 1—500 字符）、commandId 和 expectedVersion。仅 open 且目标不同于当前负责人时生效；允许为未分配会话指定同事。接受后负责人切换为目标成员，reception=human，保留 workStatus，三个业务计数各加一。审计保留实际操作者、目标成员和原因，后续成员离职不能抹除这些历史事实。

增加会话范围内的候选成员读取接口，复用现有 storeAccess SQL 授权条件与 100+1 有界分页方式，不放宽团队管理或店铺授权管理接口。候选只含同公司、邮箱已验证、当前具备本店访问权限的实际成员；owner/admin 无需额外 grant，member 必须有本店 grant。待邀请和已移除成员不进入候选；离线不影响接单资格。提交时重新读取操作者和目标的当前权限，选择列表不能成为权限依据。

原回执优先于新的目标资格判断：操作者仍需当前会话权限和相同成员身份；但已接受的转交，在目标后来失权时仍能重放原回执并查看当前状态。只有新命令要求目标当前有效。目标失效单独报告冲突，不能误作操作者失权的 404；载荷中的目标和原因均参与 commandId 冲突比较。D1 授权读取与 DO 提交仍有跨资源间隙，不承诺原子撤权，不因目标失权静默重分配。

界面复用已有 Dialog、NativeSelect、Input 和 Button；弹窗明确区分未分配时的“分配负责人”和已有负责人时的“转交会话”。保留打开时看到的版本，选择目标和原因后提交，后台轮询不能改写确认基线。候选请求按公司/会话隔离，每页最多 100 人，offset 最高 10000，不把分页列表当作冻结快照。冲突重新读取候选与权威状态后关闭弹窗，重新打开时再次选择；提交结果未知时沿用现有锁定与核对流程，不自动再次转交。0013 只扩展事件表动作约束，保持 0012、父表、状态和旧回执编码不变；先迁移 D1，再部署 Worker/客户端。旧代码不理解待投影的 transfer 回执，不能直接回滚。

候选授权、目标撤权、原回执重放、并发转交、事务恢复、旧数据升级及弹窗版本冻结已有本地验证，见进度第 30 节。负责人展示不能依赖候选列表，因为历史负责人可能已失去接手资格；成员删除或重新加入不能改写旧 memberId 的含义。当前展示合同见下一节，内部备注见第 6.8 节。

### 6.7 阶段 4B4a：当前负责人展示

在 GET control 和已接受命令的 HTTP control 对象上增加独立 assignee 字段，不修改 ControlState、DO 存储、历史 receipt 或迁移。未分配时为 null；已分配时为精确 memberId、当前姓名和 eligible/ineligible；成员已移除时 name=null、status=removed。资格沿用同店铺、验证邮箱与角色/grant 条件，不把离线当失权，也不因失权自动重分配。

先取得 DO 权威 view，再按 view.state.assignedMemberId 查询同公司成员；不能使用可能滞后的 D1 投影或旧回执中的负责人。最终 SQL 同时复核访问权限及 view.viewerMemberId，避免读取之间移除/重加入的成员身份被替换；同一账号重新加入不能把旧负责人 ID 映射到新成员。原成员失权仍可展示姓名，跨公司 ID 不暴露姓名。未分配也必须通过最终授权查询。

姓名和资格可在同一控制版本下更新，前端仅对 state 做同版本一致性比较；assignee 必须与当前 assignedMemberId 匹配。资料读取失败按不可用处理，不冒充“已移除”；命令已接受后读取失败仍返回结果未确认，沿用读取核对，不再次写命令。前后端协议一起发布，旧响应缺失该字段时客户端明确拒绝，不能静默编造姓名或资格。界面显示“负责人：姓名”，本人另标“我负责”；失权显示“当前无法接手”，已移除单独显示“负责人已移除”，空白姓名显示“未填写姓名”。这些标记不改变待回复/等待/已解决状态。

### 6.8 阶段 4B5：团队内部备注

新增 add_note 命令，沿用 commandId、expectedVersion 和操作者当前权限。正文保留原文，要求非全空白、最多 4000 个 UTF-16 单位且为有效 Unicode；拒绝 C0 控制字符（保留制表符、回车和换行）及 DEL。保留 HTTP 16 KiB 上限，不因备注扩大所有接口的请求体限制。只增加 version、sequence 和 updatedAt，controlEpoch、生命周期、接待方式、负责人和等待状态均不变；open/resolved 都可备注。只检查将要增加的两个计数上限。

授权查询同时读取作者姓名，由服务端只为新备注生成 authorName 快照，不能由客户端提交。原文和原成员身份参与幂等比较，重放不以新的姓名替换快照。旧动作回执的字段及编码保持不变。0014 仅扩展事件动作约束，继续使用现有 schemaVersion=2、DO 和事务 outbox。

在同一 persistCommand 事务中保存状态、回执、事件及 note:<16位补零序号> 到 commandId 的索引。GET notes 从权威 DO 索引/回执有界读取，默认 20、最多 50 条，序号倒序；续页使用排他的 end 边界，游标绑定公司、店铺、会话、controller 和 beforeSequence。索引引用缺失/不匹配的回执时明确报错，不静默跳过。无目录时返回授权空页，不创建目录或业务命令；已有目录沿用现有的惰性初始化/格式升级。旧对象没有备注索引是合法状态；不新增对索引全损的灾备承诺。分页边界遵循 [Cloudflare Storage API](https://developers.cloudflare.com/durable-objects/api/legacy-kv-storage-api/#list)。

首批备注使用独立的团队备注列表与输入框，明确与平台原文分页区分；不会发送给消费者、修改平台消息或触发 AI。共用会话操作的忙碌和结果核对状态。提交结果未知时保留当前编辑会话中的冻结正文和原 commandId，不清草稿、不自动新建或重发命令；只有取得匹配的原回执才确认保存，允许用户显式使用原命令重试。暂不提供编辑、删除、附件或持久草稿。后续统一时间线需单独完成跨来源排序和分页合同，不能把最新备注机械追加到任意历史消息页。

## 7. 入站处理与 AI 执行

~~~mermaid
sequenceDiagram
    participant P as 电商平台
    participant I as 接收层
    participant D as D1 与 Outbox
    participant Q as 业务队列
    participant C as 会话控制 DO
    participant F as Flue Agent
    P->>I: 消息或轮询响应
    I->>I: 验证来源及规范化
    I->>D: 原子写入消息、事件和任务
    I-->>P: 确认已接收
    D->>Q: 唤醒任务，可重复
    Q->>C: ingest(eventId)
    C->>C: 去重，推进输入版本及处理计划
    C->>C: 检查接待方式和策略
    C->>F: 提交受控输入
    F->>F: 检索与查询工具
    F->>C: 提交回复意图或转人工
    C->>C: 重新校验控制版本
    C->>D: 投影消息与执行摘要
~~~

### 7.1 入站合同

- 内部事件包含 schemaVersion、eventId、organizationId、storeId、channelType、platformThreadId、platformMessageId、occurredAt、receivedAt、payloadRef、traceId。
- org/store 来源于已验证绑定，不由消费者文本指定。
- message ID 缺失时优先使用官方事件 ID；只能使用复合去重时，保留依据和冲突处理，不用正文哈希合并两个不同的真实消息。
- 平台乱序事件保留原发生时间和接收序号；聊天展示顺序稳定，不依据机器收到的先后覆盖更晚的订单状态。
- 同一会话默认同一时刻一个 AI 运行计划；提交前可在短暂、可配置的窗口内合并连续输入，建议初值 1 秒，压测后调整。首轮不向繁忙的 Flue 会话追加新业务运行；新输入先推进业务输入版本，使旧候选失效，等待旧运行终止并确认已发出的中止命令已处理后，再以新运行处理最新输入。
- 自家发送的回显通过平台消息 ID/本地关联消重，不重新当客户输入触发 AI。

### 7.2 Flue 调用边界

Flue 接受提交、恢复状态与处理模型/工具执行；DingBell 记录触发事件和运行计划。提交合同如下：

1. 调用前持久化 ai_run、稳定 dispatch_key、目标 Agent/会话及冻结载荷；run_id、epoch、input_revision、policy_version 在该运行内不可变。会话目标由公司、店铺、业务会话与运行世代确定，不能接受客户端任意指定。
2. 将 dispatch_key 传给原生 idempotencyKey，成功后保存 receipt/submission ID；同入口、同键、同载荷重放返回原回执。接收成功与本地存回执之间崩溃时，有界重放同一请求取得回执，不另建猜测式运行历史搜索。HTTP 与服务端 dispatch 的提交 kind 不同，同键跨入口返回冲突，不能切换入口重试。
3. 相同键但载荷不同的 submission_conflict 是可见错误，禁止随机换键绕过。已失败提交用原键仍返回原结果；业务决定重跑时重新检查权限、接管状态与预算，并记录新的运行和键。
4. 网络持续不可用时保留待核对与预算预留。对无法取得稳定键的旧数据单独处理，不能宣称不存在重复风险。框架幂等键不替代业务输入、发送和用量唯一约束。
5. Flue 的忙时输入可能合并，多个 submission 可对应一个 response。首轮不依赖此行为；只有原生回执、共享 response、工具调用与不可变业务运行版本的映射，以及用量去重验证通过后，才启用繁忙合并。不能用“读取最后一条 assistant 消息”猜测归属；无法确定归属的候选禁止发送。

原生 key 的范围是 (agent, id)，最长 256 字符；uid 是运行时会话世代标识，不是幂等键或业务授权。initialData 只存创建时的稳定标识。工具调用及其异步完成结果由服务端绑定生成时的 run_id、epoch、input_revision、policy_version，不能由模型传值决定。当前密钥、权限、策略及接管状态从受控上下文读取，仅用于执行与新鲜度校验；不得把最新版本写回旧运行或旧工具输出，使它重新取得发送资格。版本失效时拒绝旧输出，另建运行或转人工。[提交类型](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/types.ts#L110)、[Agent Behavior](https://flueframework.com/docs/reference/agent-behavior/)

Flue 的持久步骤不能保证外部平台恰好执行一次；发送副作用仍经过会话控制对象。[Flue 持久性](https://flueframework.com/docs/guide/durability/)、[工作流边界](https://flueframework.com/docs/guide/workflows/)

锁定 2.2.2 的实际探针还确认：首轮 `submission_running.maxAttempts` 可能先报告默认值 10，随后按 Agent 配置的 1 次执行限额结算；不能用首轮观察事件替代冻结配置。配置的 3 秒 submission timeout 在本次云端约 30 秒后完成结算，因此业务发送资格必须自行检查冻结截止时间、接管世代与当前权限，不能等待框架超时通知来阻止旧候选。详见[验证记录](06-implementation-progress.md)。

### 7.3 AI 工具白名单

| 工具 | 输入来源 | 允许返回 | 副作用 |
| --- | --- | --- | --- |
| search_knowledge | 问题、当前会话已绑定范围 | 当前可用知识片段和引用 | 无 |
| get_product | 当前商品或经过验证的商品选择 | 规格、说明、时间戳 | 无 |
| get_order_status | 已绑定且权限确认的订单/包裹 | 真实状态、更新时间、缺失字段 | 无 |
| submit_reply | 回复文本和可见引用；会话及不可变运行版本由服务端附加 | 意图 ID 或拒绝原因 | 只提交意图，实际发送另行检查 |
| request_handoff | 原因、问题摘要、所需资料 | 新接待状态 | 切换为待人工并暂停 AI |

不注册退款、取消、发券、任意 HTTP、shell、浏览器登录或执行商家自定义 JavaScript 的工具。平台写能力若以后开放，作为独立审批与动作模块设计。

首版无需 useSandbox、Subagents 或任意 MCP 接入。Flue Skills 的 allowed-tools 元数据不强制执行权限，不能替代工具白名单或业务授权。[Migration Guide](https://flueframework.com/docs/guide/migration/)、[Skills](https://flueframework.com/docs/guide/skills/)

### 7.4 提示词与模型配置

提示词由版本化应用约束、商家有效策略、已授权上下文和明确标记的不可信客户内容构成。商家可编辑语气、语言、转人工和场景说明；不可覆盖系统的权限和发送检查。

运行记录包含 model_provider、model_name、model_config_version、prompt_version、policy_version、knowledge_revision_ids、tool_schema_version。模型可配置但默认只有经评估的允许列表，防止切换到不支持所需工具或语言的模型。

不使用模型自报的“置信度 90%”作为唯一放行标准。依据缺失、订单不匹配、工具失败、明确要求人工等确定条件先决定转人工。评估集用于验证其余回答质量。

初始运行预算建议：最大模型轮次 8、提交墙钟时间 120 秒、工具请求设超时、输入长度设上限。时间使用原生 Agent.durability.timeoutMs；maxAttempts 单独限制恢复尝试，不能当模型轮次。8 轮通过锁定版本支持的控制机制实现并验证，不虚构 maxTurns 配置项。供应商等待/重试消耗也计入成本。[DurabilityConfig](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/types.ts#L432)

超时先请求中止，最终结算还受监督周期、宽限期与外部调用影响；不是第 120 秒撤销全部副作用的保证。人工接管的业务版本立即独立生效；会话级中止与恢复 AI 的命令有序协调，避免迟到 abort 中止新运行。

### 7.5 前端与 Agent 数据的分离

消息中心读取业务 DTO，不公开原始 Agent 路由。后端复用 Flue SDK 的读取/观察能力，并以白名单输出运行状态、最终候选、引用和用量摘要。

SDK 已提供快照、SSE/长轮询及重连处理，不重写传输解析器；其单 Agent 会话数据不提供业务收件箱枚举。附件 URL 需要独立的业务下载鉴权，不能假定继承观察请求的鉴权头。

Flue React 的消息类型不是 Vercel AI SDK 的传输协议。不能把 shadcn/AI Elements 的视觉组件与 useChat 自动接通作为既定事实。首版消息中心采用业务 API；AI 测试页可使用经过验证且不会泄露原始轨迹的适配。禁止将完整推理内容、内部提示词和凭证发到浏览器后仅通过 UI 隐藏。[Flue React](https://flueframework.com/docs/guide/react/)

### 7.6 阶段 6A-1：受控问答测试的上下文与引用复核

`modules/reply-tests/service.ts` 提供内部只读准备与结果复核；持久预算和模型 Agent 见 7.7，受限业务 HTTP 与后台测试入口见 7.8。它不复用翻译预览的运行身份或预算用途，也不另建执行调度器。准备与复核合同如下：

1. 管理员/所有者选择现有会话、当前最新的一条消费者文字消息、已生效的自动回复策略、业务阶段和测试语言。服务端读取公司/店铺/成员、控制器目录、消息原文与追加序号、有效策略及 SKU 映射；不能传入替代问题、订单号或任意商品范围。文本最多 16 段、拼接后 1000 个 UTF-16 码元且不超过 2400 UTF-8 字节，图片、超限、已有更新消息或已解决会话明确拒绝，不截断原问题。
2. 创建服务器生成的 `runId`，冻结成员/会话、控制 `version`/`controlEpoch`、`conversation.message_sequence` 作为本测试的 `inputRevision`、生效策略修订及内容、商品映射和问题摘要。当前追加序号包括历史回填，回填也会保守地使旧测试失效。未发布策略草稿不影响当前生效策略；独立发布、暂停、成员替换、客户追加内容或控制状态改变使旧上下文失效。冻结数据只供内部存储，不接受浏览器/模型回传后直接信任。
3. 控制状态通过注入的权威 DO 读取器取得，D1 只提供路由与权限，不能用滞后的投影替代实际接管状态。普通客服暂不能启动本阶段的管理测试。已由人工接待的会话可以做只读模拟，不能因此取得自动接待资格；当前控制状态还没有启用 `ai` 模式。
4. 嵌入结果必须绑定原问题哈希和当前 `knowledgeProfile`，维数/数值有效后才进入既有 `retrieveKnowledge`。商品范围来自所选消息 SKU 在同公司同店铺的唯一映射；缺少或歧义映射只检索通用资料。检索前后重验原上下文，不把最新版本写回旧运行。此方法不调用嵌入模型；正式调用仍需先预留预算并持久化原输入。
5. 模型输入投影前与生成结果复核时均重新解析全部已检索引用，检查生效修订、权限、正文与哈希，并在 I/O 后复核上下文。模型只应收到问题、回复语言、语气/商家指引及明确标为不可信的分块正文/编号，不包含登录会话、成员、运行或控制器身份。商家指引仍是受限内容，不能授予工具权限；实际提示词与工具边界随 Flue Agent 接线验收。
6. 候选输出严格区分回答、澄清、转人工建议；回答要求引用已检索分块中的原文，模型不能指定版本、接管世代或任意动作。结果始终为 `review_required`、`simulated=true`、`canSend=false`、`factCheck=not_evaluated`。原文匹配仅证明引用可追溯，无法证明生成正文蕴含于证据；不以相似度或存在引用替代事实核对，也不真正改变会话接待或产生发送意图。

这些是读取时的前后复核，不是跨 D1/DO 的原子外发锁。测试运行持久化、预算预留/结算和 Flue 原生 dispatch/read 的已实现范围见 7.7；UI 测试台见 7.8；运行中止、订单受控工具、自动接待及最终发送临界区仍按阶段 6 后续实施。原生测试证明 DO 接管在投影失败和运行时重启后仍能拒绝旧上下文，不代表已验证运行中的真实模型中止。

### 7.7 阶段 6A-2：持久预算与 Flue 问答测试执行

本节继续 7.6 的只读合同，接通内部模拟运行，不改变线上会话的接待模式。部署新增 Worker 前先应用 `0029_reply_test_runs.sql`，保留 Wrangler 的既有 v1–v3 迁移并追加 v4 `FlueReplyTestAgent`。没有新依赖或新调度器；调用方仍需是可信服务端代码，浏览器不能提交自造的上下文/知识快照。

**输入和财务记录。** `reply_test_run` 持久化原上下文、检索证据、只向模型提供必要内容的投影及其摘要、原成员、请求标识和价格配置。JSON 上限为 96 KiB。原始输入和价格不可覆盖；同一公司/请求的重放采用原配置，不因当前模型价格变化而重新预留。服务入口复制输入，防止异步校验期间调用方修改对象。财务计算只复用翻译模块已验证的整数微美元舍入与配置校验，账表、用途、原生实例及预算均独立。

`reply_test_budget` 同时限制微美元金额和累计获准次数。默认禁用，只能由当前已验证会话的所有者/管理员创建和按版本启停；同公司预算时间窗不能重叠。上限、窗口和原始身份不可改写。D1 批事务同时预留金额、增加次数并插入运行；插入失败全部回滚。明确配置为零价格仍消耗次数，已关闭的测试也不返还次数。当前运行的预留持有到取得有效用量或证明确实未调用；预算窗口结束不自动取消既有运行或退还金额。

**原生执行。** `ReplyTest` 使用 Flue 原生 `init/dispatch/read/getAgentInstance`，实例名为 `reply-test:<runId>`，首次创建使用 `uid:null`，相同运行保持相同 idempotencyKey 和创建载荷。返回原生 submission/uid/acceptedAt 后绑定 D1；遗失回执允许明确恢复同一原生提交。若实例身份丢失且已有调用许可，不创建替代运行，不重新请求模型。读取结果前后核对原生 uid，并在返回资料前再次检查当前访问权。

Flue 的提供方注册按 ID 全局覆盖，因此本 Agent 使用 `dingbell-reply-test` 注册名，实际模型保持 NVIDIA `nvidia/nemotron-3-super-120b-a12b`，不覆盖现有翻译的 `nvidia` 注册。运行要求 `grounded-reply-v1` 提示词与 `nvidia-reply-test-v1` 模型配置；输入预留至少覆盖模型上下文窗口，输出限制 1–2048 token。`REPLY_TEST_ENABLED` 默认关闭，模型密钥仅在 Worker 中解析。

**调用界限。** DO 中仅保存本运行不可改绑的载荷，以及一次生成、一次 HTTP 尝试和提供方证据。模型请求前同时经过 DO 一次性许可和 D1 原子调用许可；D1 再检查原会话/成员、消息追加版本、生效策略和知识修订，并在此前读取控制 DO 的权威状态。调用许可已经保存但响应丢失，不会作为第二次许可返回。Flue 最多执行一次尝试，SDK 不重试；请求只到固定 NVIDIA HTTPS 地址，45 秒超时，响应缓冲不超过 1 MiB。复用已验证的 SSE 传输解析，未知结果保留预留。

本模拟不注册工具或沙箱。Flue 2.2.2 自动附带的 task 声明通过 SDK 的公开 payload hook 移除，出现其他工具声明拒绝；收到工具调用也拒绝作为答案。用户问题与知识正文被提示为不可信数据，商家指引只能指导表达，不能授予外部操作权限。这是能力限制，不是提示注入或答案事实正确性的完整验收。

**结果与恢复。** 提供方完成证据和 Flue 用量匹配后，以原生回执结算实际费用；实际费用超过预留也如实计入，后续预算不足则拒绝新运行。已发生费用不因候选无效、资料撤回或会话变化而退回。成功输出严格解析 JSON，再用 7.6 的引用/上下文复核生成 `review_required` 模拟结果；读取时重新复核，因此历史答案不能绕过后来撤回。原生输出和提供方证据留在 Flue/DO，D1 保存财务与回执，不另建第二个结果调度器。

若执行失败但 DO 已记录完整、有效的提供方用量，仍结算该费用；若尚未消耗任何 HTTP 尝试，必须先原子关闭原 DO，再用其零请求证明释放金额。无回执、超时、进程中断以及查询不到实例均不足以证明可以退款。已消耗尝试但在最终 D1 门禁被拒绝的情况当前也保守持有，不猜测为零费用。

**本批边界。** 已验证的是带合成模型响应的本地原生执行和恢复，不是 NVIDIA 真实回答质量、托管云运行或自动客服上线。问题嵌入准入、受限业务 API 和 UI 测试台由 7.8 接续；取消运行、实际订单工具/人工转接、后台结算修复与保留期限管理仍待后续实施。结果仍明确模拟、不可发送、事实正确性未评估；本批不生成发送意图。跨 D1/DO 的读取时重验不能替代最终外发临界区。

### 7.8 阶段 6A-3：问题嵌入准入与管理员问答测试面板

消息中心的所有者/管理员可打开「测试 AI 回复」侧边面板，选择当前店铺适用的生效自动回复策略、咨询阶段和消费者语言。先「检索依据」，核对知识后再「生成测试回复」。问题来自最新消费者文字消息；浏览器不能提交问题正文、任意商品/订单范围、价格、向量、控制版本或原生回执。普通客服没有该入口或 API 权限。已有人工接管状态可做内部模拟，不改变接待权或生成发送意图。

**新增记录与费用边界。** 部署新版 Worker 前应用 `0030_reply_test_query.sql`。`reply_test_query` 保存原上下文、原请求/成员、问答与嵌入价格配置及其摘要、一次嵌入许可、向量与知识证据；原输入、价格和已确认的向量/证据不可改写。`reply_test_query_usage` 在同一 D1 批事务内按 UTC 日期限制整个安装的预留微美元和次数；并发准入不能透支最后一份额度，重放不重复计数。查询费用与每公司 `reply_test_budget` 的生成费用分开；检索前检查生成预算可用，真正生成时才预留其金额/次数，期间预算可能被其他操作消耗。

嵌入复用 `@cf/baai/bge-m3`、1024 维 profile 与现有 Vectorize 检索。每次预留完整输入窗口的价格上限，输入字节仍由原问题上限约束；这里记录的是保守额度，不是供应商实际 token 用量或账单。已获准额度不自动退回，零价格仍受次数限制，不假定免费层或自动采用在线价格。`maxInputTokens` 至少 60000；完整配置须由部署管理员审核。官方模型窗口与价格参考 [Cloudflare BGE-M3](https://developers.cloudflare.com/workers-ai/models/bge-m3/)，不能把该页面当前标价等同于用户账户实际应付金额。

**恢复约束。** D1 先记录一次调用许可，再调用嵌入；20 秒未得到结果按未知处理，未宣称已中止提供方。许可回执丢失、进程中断或提供方报错都不发第二次嵌入、不自动退款。保存成功的向量独立于后续 Vectorize 查询：索引读失败可在原测试上继续检索，复用原向量。已保存引用每次读取重新复核；生成和异步观察后再复核一次。消费者新消息、接管变化、策略版本变化、资料撤回或成员变化使旧测试显示失效，并隐藏旧依据/答案。前一天尚未开始嵌入的许可不可跨日启动；已开始或已有向量的记录继续采用原状态核对。

**API 合同。** 以下均使用真实登录会话、公司/会话权限及规范编码的 `X-DingBell-Member-Id`，写入检查同源；JSON 限流沿用现有中间件，响应 `no-store`。

| 方法和路径 | 输入与行为 |
| --- | --- |
| `POST /api/companies/:companyId/conversations/:id/reply-tests` | 仅 `{requestId,messageId,policyId,stage,language}`。同编号同目标重放，恢复既有检索；不同目标冲突。服务端选择生效公司预算、冻结配置和原上下文。 |
| `GET …/reply-tests/:requestId` | 核对原记录、引用、Flue 回执/结果与用量，不提交模型。资料过时返回 `changed`；无权限或原成员不匹配不可读取。 |
| `POST …/reply-tests/:requestId/generate` | 仅空对象。依据必须有效；按原上下文/证据/价格预留并执行原 Flue 实例。恢复回执不创建替代运行。 |

公开 DTO 只包含公司/会话/当前成员、原问题/测试目标、策略版本、当前引用和模拟结果，不返回向量、价格密钥、原始载荷、登录会话或控制器身份。`prepared/retrieving/ready/changed/unconfirmed/index_unavailable` 区分检索状态；生成另有 `pending/review_required/unconfirmed/unavailable` 和额度状态。没有资料时保留空证据，模型只能按既有合同澄清或建议转人工；引用成功不等于事实核对成功。

**前端恢复。** 使用现有 ShadCN Sheet、表单和结果组件，不新增依赖。发送首个请求前，sessionStorage 必须成功保存按用户/公司/成员/会话隔离的原请求标识与目标；不保存消费者正文或生成答案。不能确认保存时停止派发。刷新或重新打开读取原编号，等待状态只轮询 GET；未知 POST 不自动重试、不自动换编号。索引失败和遗失原生回执分别提供明确的原测试恢复入口。新建测试需用户主动操作；不存在发送按钮或自动写回回复草稿。旧缓存读取失败时隐藏，跨成员结果由客户端合同再次拒绝。

**部署配置。** 默认 `REPLY_TEST_ENABLED=false`。启用要求 `NVAPI_KEY`、`FLUE_REPLY_TEST_AGENT`、`KNOWLEDGE_AI`、`KNOWLEDGE_INDEX` 和以下两个服务端 JSON 配置，同时需要当前有效且已启用的公司生成预算：

- `REPLY_TEST_CONFIG_JSON`：沿用 `TranslationConfig` 的金额单位和严格字段，模型 `nvidia/nemotron-3-super-120b-a12b`、`modelConfigVersion=nvidia-reply-test-v1`、`promptVersion=grounded-reply-v1`、输入窗口至少 262144、输出 1–2048；四类 token 单价必须明确审核，不能借用翻译运行。
- `REPLY_TEST_QUERY_CONFIG_JSON`：`profile=bge-m3-1024-bytes2400-v1`、`priceVersion`、`maxInputTokens`、`inputMicrosPerMillion`、`dailyLimitMicros`、`maxQueries`。窗口 60000–1000000，次数 1–1000000，金额为非负安全整数微美元。

公司生成预算现由 7.9 的管理页面和审计 API 配置；不在用户打开测试页时静默创建预算。完整开源一键部署、后台预算核对、历史测试列表/保留清理和真实模型效果仍待后续完成。本批所有验收模型响应均为合成结果；未部署云端或创建资源，R2 云端验证继续保留待办。

### 7.9 阶段 6A-4：公司问答测试预算管理

所有者和管理员在「公司设置 → AI 回复测试预算」创建、启用或暂停生成预算。普通成员不显示预算用量或控件，API 同时拒绝访问。复用 `reply_test_budget` 的金额、次数和结算语义，不另建资金账本，不更改翻译预算。金额为 USD 微美元估算，不是充值余额或供应商账单。

**创建与变更。** 新预算必须提供 UTC 整日时间窗、非负金额和 1–1,000,000 次上限，默认暂停。日期不可早于当前 UTC 日，结束日期不包含在窗口内。金额最多六位小数，解析与显示使用整数和 BigInt，不用浮点乘法舍入。窗口、金额和次数创建后固定，所有窗口即使暂停也不能重叠；耗尽时不能通过重建同一窗口补额度。启停使用预期版本 CAS。暂停阻止后续准入，不撤销已有调用或费用；未知费用继续保留，次数不返还。

部署前应用 `0031_reply_test_budget_audit.sql`。新增审计表记录命令编号、原公司/用户/成员、姓名快照、不可变命令载荷、动作、结果版本和时间。预算变更、审计插入和临时提交标记清理在同一 D1 批事务内完成；审计写入失败必须回滚变更。数据库拒绝改写审计行。每次写入在 SQL 内检查有效登录、已验证邮箱、管理角色和原成员，移除后重新加入不能沿用旧命令。

**业务接口。** `GET /api/companies/:companyId/reply-test-budgets` 返回当前预算、最多 20 条按开始时间/编号倒序的历史、下一页游标、最近 10 条管理记录、本公司 UTC 当日查询次数/预留上限及服务配置是否齐全。当前预算独立固定展示，不会因翻页丢失。返回不包含其他公司的全局额度使用量、密钥或原始价格配置。

`POST` 同一路径要求规范编码的 `X-DingBell-Member-Id` 和严格命令对象：创建 `{id,action:'create',startsAt,endsAt,limitMicros,maxRuns}`；启停 `{id,action:'set_enabled',budgetId,expectedRevision,enabled}`。同命令重放返回原审计回执与当前预算，不重新执行旧动作；因此后来暂停的预算不会被旧启用命令重新打开。载荷冲突、版本变化、时间窗重叠/过期分别返回可核对的 409，范围不可访问返回 404；无法确定写入结果返回待核对状态。响应不缓存，写入校验同源。

**界面与恢复。** ShadCN Card/Dialog 展示上限、已使用估算、尚在预留、可用余额与获准次数；余额最低显示零，不掩盖原始已使用金额。检索额度单独说明受整个部署 UTC 日上限约束，不从生成预算扣除。价格和绑定仍由部署配置管理。页面定期只读刷新，修改期间避免重复提交；网络结果未知时停止写操作，要求主动读取当前预算及记录后再决定。不会自动重试 POST、自动创建/启用预算或调用模型。历史 20 条一页，审计仅最近 10 条，不宣称已提供完整审计导出或运行账单明细。

本批验收覆盖本地真实 D1/DO、浏览器和合成模型回归。它没有启用真实模型、部署云资源或向消费者发送消息。真实问答质量、翻译预算 UI、后台结算修复、安装向导与完整一键部署仍待后续实施。

### 7.10 阶段 6A-5：真实模型质量评估与提示词版本

`probes/reply-quality` 复用 Flue Node/SQLite、固定 NVIDIA SDK、应用的提示词/输出 schema 与有界 SSE 传输。它只向既有 NVIDIA 试用端点发送合成数据，无店铺连接、退款/订单工具或客户发送权限；不代表 Cloudflare 上实际生产运行或检索效果。无需新增评估框架或另一套 Agent 运行时。

固定语料为 40 个手写场景族，每族五个明确的措辞/事实变体，共 200 例：售前 60、售中 50、售后 50、安全与异常 40。这是模板化合成评估，不是 200 个独立真实商家对话。每例保存可见文档、修订与正文摘要、参考事实、预期决策、语言及人工复核项。问题嵌入和 Vectorize 检索不在此评估中执行，避免把生成质量与检索质量混为一谈。

每批显式选择最多 24 例和重复编号 1–3，每例最多一次准许生成和一次 HTTP；2,048 输出 tokens、45 秒传输上限、禁用重试/thinking/工具，使用应用相同的 NVIDIA 参数。调用前 journal 刷盘，完成后逐例保存回执、输出、SSE 证据、tokens 和延迟。执行失败/未知/截断停止批次，不自动重试、更换模型或覆盖目录。批次内调用间隔至少一秒。报告拒绝版本/数据摘要漂移、重复用例/重复编号和结果正文不匹配；未覆盖与未完成三次的 P0 用例明确列出。费用记为未定价，不能把目录标价或免费试用意图当成供应商实际账单。

**发现与版本管理。** 原 `grounded-reply-v1` 的真实小样本暴露引用标点改写、空正文、语言偏离以及虚假转接承诺。新增候选 `grounded-reply-v2` 强调非空且符合语言的正文、保持原文的最小引用、拒绝时的解释及未执行转接不可承诺。v1 的字符串逐字节保留；Agent 按运行已冻结的 `config.promptVersion` 选择版本，未知版本拒绝。部署更新不会悄悄给旧运行换系统提示词，新测试也不会自动改写服务端已有配置。

v2 首批复测仍出现错误字段、错误决策类别和将执行转接的承诺，**尚未达到自主回复放行条件**。有效 JSON/引用只能作为程序合同证据，不能宣称事实准确率。报告的语义复核始终待人工，转人工执行标记始终为未评估；当前后台生成结果继续是模拟、需核对、不可发送。

后续需验证所选托管端点实际支持的结构约束，再把关键动作及动作完成后的措辞绑定到真实业务状态；不能仅以提示词要求替代权限/状态控制。[NVIDIA 结构化生成文档](https://docs.nvidia.com/nim/large-language-models/1.15.0/structured-generation.html)描述 `guided_json` 能力，但它的容器示例不构成当前托管模型支持证明。本批没有启用结构化参数，也没有把额外模型裁判评分当作人工验收。真实采样统计与未通过项见实施进度第 66 节。

### 7.11 阶段 6A-6：有版本的结构化输出

实际 NVIDIA 托管端点已通过 schema 专项试验；随后使用完整 Flue 提示词和相同提供方链路完成 9 个既有失败样本的三轮复测。`modelConfigVersion=nvidia-reply-test-v2` 才发送 `guided_json`，`nvidia-reply-test-v1` 保留原载荷。提示词版本与模型参数版本分别冻结在既有运行配置中；部署不自动切换旧运行，未知版本拒绝，没有不带 schema 的失败重试或模型替换。

复用 Flue 已安装的官方 `@valibot/to-json-schema@1.8.0`，将它声明为直接精确依赖，没有新增底层包。schema 从应用的 Valibot 输出合同生成，限定 answer/clarify/handoff 三种分支、必要字段、引用形状和长度；只显式跳过无法转换的 `check` 函数，其他不支持项抛错。空白/Unicode/控制字符、来源唯一性、当前知识权限与原文引用仍由应用检查。JSON Schema 的字符串长度语义也不能替代应用的 UTF-16 长度校验。固定参数/schema 摘要回归保护该模型配置版本，后续合同变化必须新增版本并保留旧映射。

评估器通过 `DINGBELL_REPLY_MODEL_CONFIG_VERSION` 显式选择格式。旧 v1/v2 提示词的归档语料摘要不变；新格式的语料计划记录模型配置和完整约束参数，摘要不同，禁止合并不同格式报告。约束被改写时，在记录新尝试和网络访问前拒绝。

本次 27 次真实复测均有完整响应，未出现结构、引用和语言存在检查失败，但只有 20 次满足全部程序合同，另 7 次决策类别不符。三次人工请求虽然均返回 handoff，后两次正文仍要求消费者等待人工，可能暗示并未执行的排队/转接。**格式约束不是语义或动作权限保证**。结果继续模拟、需人工复核且不可发送；下一步实际转人工须由既有会话控制器持久变更状态，确认文案只能依据已确认的业务回执。不得把模型 handoff 标签当作已执行，或让测试运行触发真实转接。独立俄语复核、完整覆盖、其他 P0 三次验证和自动接待仍未完成。

### 7.12 阶段 6B-1：AI 运行归属与实际转人工

会话控制器新增内部 `startAi` 与 `requestHandoff` RPC，共用原有 Durable Object 事务、递增控制世代、命令回执、投影 outbox 和修复调度。它们没有公开 HTTP 入口，不接受问答模拟结果作为授权。`AI_RECEPTION_ENABLED` 默认关闭；首次准入还要求当前会话开放且未分配、店铺状态可用、最新文本来自消费者、已发布且启用的 automatic 策略覆盖店铺/阶段并使用 automatic 模式。建议模式不授予执行权限。

准入前冻结服务端生成/持久传递的运行编号、公司/店铺/会话范围、原消息及输入版本、已发布策略修订/正文、语言和 60 秒截止时间。控制器保存 `aiRun`、起始回执和 `ai_start` 事件，再进入 `reception=ai`；该状态只允许开放、未分配且待回复。重复原请求返回原运行，不重建上下文。发布草稿与编辑草稿分开：未发布编辑不使当前已发布内容失效；暂停立即阻止新的工具授权，重新发布的修订不能重新授权旧运行。

模型可提供的转人工内容只有原因、摘要和所需资料，不能指定运行、公司、负责人、控制版本、语言、确认正文或动作来源。`requestHandoff` 从控制器原运行读取授权上下文，再检查当前消息/已发布策略和原控制世代。成功后同一事务记录回执、原因、摘要和待投影事件，并设置待人工、未分配、待回复，推进控制世代。人工接管/其他控制变更使旧运行失效。回执重放只读历史，不重新切换状态；返回的状态在投影等待后重新读取，避免较晚完成的响应掩盖已发生的人工接管。

新增人工命令不能使用 `ai-start:` / `ai-handoff:` 保留前缀，避免内部备注先占用回执键而阻止 AI 转交或超时处理。历史人工作用域及原载荷一致的回执仍可重放；准入发现历史同名回执时拒绝该运行编号，不覆盖原记录，也不进入无法转交的 AI 状态。

确认文案由应用根据已持久提交的回执和冻结语言生成，表示已进入人工待处理队列，不采用模型生成的“已转接”或“正在退款”正文。当前返回明确 `sent=false`、`canSend=false`，没有消费者发送意图。控制器到期告警使用 system 来源记录超时转人工，即使策略已暂停也能收回当前 AI 运行的控制权；迟到的 agent 请求不能覆盖系统回执。告警不是供应商停止计算或 Flue abort 成功的证据。

迁移 `0032_ai_reception.sql` 扩展接待枚举及系统审计，系统事件的人工账号字段为 NULL，不伪装为员工操作。迁移保持外键启用，先保存控制/事件/发送意图/发送尝试，重建必要表与触发器，完整恢复记录。既有人工作用域、不可变审计及单次发送保护继续生效。前端接受合法的 AI 接待状态并显示“AI 处理中”，保留人工接管操作。

**后续仍需实现：** 此步是内部控制基础，还没有注册生产客服 Flue Agent、生成预算/回执接线、受控工具调度、真正的 Flue 中止、最终发送或入站自动启动。保留原 `aiRun` 阻止未经运行终态核对的再次准入；显式恢复 AI 与后续运行轮转尚未实现，不能通过删除记录解锁。客户新输入只会使旧工具授权失效，自动取消、合并与重新调度仍待衔接。平台外发开关和质量验收状态不变。

### 7.13 阶段 6B-2：Flue 转人工工具

`createHandoffTool` 用已持久准入的 `AiRun` 和会话控制器创建 `request_handoff`，克隆并校验原运行，绑定控制器方法。模型输入继续复用 `aiHandoffSchema`；不能选择公司、会话、运行、控制版本、语言或确认正文。工具不会重新读取当前状态后给旧输出附上新授权，也不接收问答模拟结果作为准入。

复用 Flue 的 `defineTool`、持久 `step.do`、10 秒工具时限和终止结果，不增加自定义工具运行时。转交仍由控制器以原运行编号幂等提交；只有完整回执的来源、原运行和原输入全部匹配，工具才返回 committed。拒绝返回 rejected，缺失/错配回执或 RPC 异常返回 unconfirmed。结果只包含状态和 `canSend=false`、`sent=false`；没有公司/消费者资料、模型总结、确认正文或客户发送。committed 表示该运行曾提交转交，不表示稍后仍未分配客服。

三种业务结果均请求结束当前响应，避免收到已转交或不确定结果后继续编写消费者文案。Flue 的输入校验错误发生在工具处理函数之前，并不触发本工具的终止返回；多工具批次也只有全部结果终止才结束。因此该工具本身不替代生产 Agent 的轮次预算、工具集合限制或最终发送校验。持久步骤重复执行仍依赖控制器业务幂等；本步只验证完成后的重放/重启，没有冒充中途进程崩溃恢复证据。参考[工具指南](https://flueframework.com/docs/guide/tools/)、[持久性合同](https://flueframework.com/docs/guide/durability/)与[API 终止语义](https://flueframework.com/docs/reference/agent-api/)。

本地集成使用真实 Flue **Node/SQLite** 工具循环连接真实 Cloudflare/Miniflare 会话控制器，模型为 faux 合成响应。验证提交、人工抢先接管、丢响应、非法模型参数、完成后重复 dispatch 和两端重启读取，未生成外发意图。它不是客服 Agent 在原生 Cloudflare Flue 上的完整生产验收。尚未注册生产客服 Agent；后续须先建立独立的生产预算和运行账本，再接入 Worker 执行、中止及入站调度。现有问答测试预算绑定管理员模拟，不能默认为后台自动服务授予调用权限。

### 7.14 阶段 6B-3：生产 AI 预算与执行账本

生产自动接待使用独立的 `ai_budget`、`ai_budget_audit`、`ai_execution` 和 `ai_generation`，不借用管理员问答模拟的授权或余额。预算管理复用既有命令校验、微美元计算与 D1 事务；仅当前所有者/管理员可操作，创建默认暂停，预算周期/上限固定，公司内周期不可重叠，启停使用版本检查及不可变审计。预算周期控制新运行准入；已预留运行仍受原 60 秒截止时间和当前预算启停控制。

控制器内部 `readAiRun` 返回仍有效的原运行，复核实际 DO 身份、AI 接待状态、控制世代、输入、已发布策略及截止时间。预留和每轮调用许可都先查询该入口，再在 D1 财务事务中核对当前投影、店铺、输入及策略。历史起始回执不是当前执行授权；跨 DO/D1 检查也不是最终外发的原子证明。

预留前冻结原运行、初始模型输入、模型/提示词/价格配置、1–8 轮上限、`Support` Agent、`ai-support:<runId>` 实例和固定 dispatch key，并保存摘要。缺少价格拒绝准入，显式零价格仍占一次运行配额。预留额是单轮输入/输出成本上限乘以轮数；重复原请求读取同一账本，不重新扣额度。当前初始模型输入只有消费者问题、语言/阶段及商家语气/指引，知识和订单工具尚待接入；运行时还须校验支持的配置版本及上下文上限。

每轮生成在 D1 中取得一次持久许可，序号连续且不得超过冻结轮数。上一轮用量未知、当前预算暂停/透支、授权失效或账本关闭时，不授予下一轮许可。此许可必须在供应商 HTTP 之前取得，后续运行时须另外确保框架恢复、请求重试与丢失回执不会重复发出同一轮请求，不能只依靠模型提示或 Flue 的恢复次数限制。

已知原始用量按冻结价格一次性结算，事务同时减少该轮预留、累加实际费用并保存证据。实际超额照实记账并阻止后续调用，不裁剪费用以维持预算表象。关闭执行只释放从未获得许可的轮次；已许可但未知的请求继续保留额度。迟到的有效用量可在关闭后结算，却不能重新打开运行或退回已消耗的运行次数。结算、关闭或审计写入失败必须整体回滚。

关闭凭据目前是内部可信服务合同：绑定原实例、原生回执、许可总数和永久关闭证明；未派发运行须证明没有回执且零许可。凭据不能来自模型或公开 HTTP 参数。**本步尚未实现生成此凭据的原生运行时，也未注册生产客服 Agent/Provider。** 因此仅证明账本事务和授权读取，不证明实际 HTTP 至多一次、原生中止完成或生产费用对账。迁移 `0033_ai_execution.sql` 只新增四张表及保护触发器，保留既有业务数据与外键关系。管理 UI、后台核对、入站调度、恢复/轮转及消费者外发继续后续施工。

### 7.15 阶段 6B-4：原生 Cloudflare Support 执行

新增独立 `Support` Agent 和 `dingbell-support` 提供方，复用 Flue 原生 lookup / creating dispatch / read、Cloudflare 扩展、NVIDIA SDK 及既有转人工工具。Wrangler 的 `v5` 只增加 `FlueSupportAgent`；已有同步、控制、翻译和问答测试类不替换。`AI_RECEPTION_ENABLED` 继续默认关闭，没有新增公开 Agent HTTP 入口或后台自动启动入口。

执行先从 D1 读取原冻结计划，在目标 DO 内保存一份不可重绑的本地账本。模型/提示词版本须为明确支持的 `support-v1`，输入预留覆盖所选模型的完整上下文上限，输出不超过 2048 tokens；不会把新版本套给旧运行。初始消息必须逐字匹配原模型输入，附件和改写载荷拒绝。每轮持久记录独立生成序号、一次 HTTP 许可、原始响应证据和是否交付给 SDK；上轮未知或传输未被接受，均不能开始下一轮。Flue 的恢复次数限制与业务轮数上限分别生效。

调用方尚未保存提交回执时，提供方通过同一原生目标、原 creating 载荷和固定键重放 dispatch，核对真实 incarnation，再保存原 `submissionId/uid/acceptedAt`。原生测试刻意只提交而不保存回执，证明执行器可自行取回原回执且只产生一次模型 HTTP。它不是跨入口重试，也不构造假的回执。已有许可或回执的执行丢失原生身份时，保持未确认，不重建身份继续调用。

复用现有有界 SSE 传输，默认仍禁止工具。Support 显式只允许一个 `request_handoff` 调用，拒绝框架 `task`、混合批次、同槽改换调用 ID 和非法参数形状；保留原 SSE 字节交给官方 SDK。工具参数的业务 schema 继续由 Flue 校验，非法参数可以消耗后续回合，但最多使用原冻结的生成额度。对被传输层拒绝的响应，不再发出下一次 HTTP。记录原始用量后等待 D1 幂等结算，再让 SDK 继续。没有真实有效用量或请求结果不明时，保留原预留，不按零计费。

转人工仍由会话控制器提交；Cloudflare RPC 方法先包在普通函数中，再交给工具，避免对 RPC 代理直接使用函数 `bind`。消费者确认正文不交给模型生成。当前 Agent 只接通转人工工具，普通模型文本仍是内部未审核结果；编排接口不返回该文本，始终 `canSend=false`。知识、订单、澄清及最终回答候选链路尚待接入。

核对服务用原回执读取真实 Flue 终态，并在读取前后校验 UID。只有原实例的终态或尚未创建原生执行的零许可状态，才能关闭本地账本，再按 D1 当前许可数提交关闭证明。运行中的请求不能释放额度；永久关闭只释放未许可轮次，未知请求继续保留。已保存的原始用量可在关闭后核对结算，不重新授权执行。人工接管无需等待模型完成，迟到转人工被原控制世代拒绝；进程中断、实例丢失和丢失调用方回执均不新增模型 HTTP。

本片以本地原生 Cloudflare Flue、真实 D1/控制器和合成 NVIDIA SSE 验证。它没有执行真实 NVIDIA/Ozon 请求，也没有部署新类。主动 abort 编排、输入变化调度、恢复/轮转、知识与订单工具、预算 UI/API、无人读取时对账和最终发送仍需后续验收；真实俄语质量保留项不变。

## 8. 发送管道与人工接管

### 8.1 发送状态

~~~mermaid
stateDiagram-v2
    [*] --> queued
    queued --> sending: 发送前检查通过
    queued --> canceled: 人工接管或任务取消
    queued --> skipped: 条件或窗口已失效
    sending --> sent: 可核对的成功结果
    sending --> failed: 明确未执行且失败
    sending --> unknown: 请求结果不明
    failed --> queued: 明确可重试且未过期
    unknown --> sent: 核对到平台消息
    unknown --> failed: 证据确认未执行
~~~

没有 unknown → queued 的无条件自动边。sent 表示平台已接受的含义需按接口确定，不等同于消费者已读。

### 8.2 发出网络请求前的必查条件

1. 当前公司和店铺仍有效，部署外发总开关及店铺开关允许。
2. 凭证版本和能力检查可用，渠道支持该消息类型及当前发送窗口。
3. 收件会话、订单/包裹和店铺归属匹配，收件人不由模型自由指定。
4. intent 的 control_epoch 与当前值一致；按下表检查发送来源所需条件。
5. 当前策略未停用；延迟任务未过期，订单状态仍满足条件。
6. 人工操作者仍有权限；中文草稿对应的确认译文版本、正文哈希与发送内容一致。
7. 公司配额与单店频率允许；必要的预算已预留。
8. 没有同一意图正在发送，也没有同一幂等键的已成功结果。
9. AI 回答引用的知识修订版仍有效且在当前授权范围内；已撤回、被替代或失去权限的依据使候选过期，重新生成或转人工。

| 发送来源 | 专属条件 |
| --- | --- |
| 人工回复 | 操作者有当前会话权限，接待方式为 human，正文已经本人确认；不要求 AI 已启用 |
| AI 自动回复 | lifecycle=open、reception=ai；source_run_id 及版本与原运行一致，生成依据的 input_revision、policy_version 与当前有效版本一致 |
| 主动通知 | 独立通知规则有效，包裹/触达窗口仍满足条件；默认在人工接管或暂停接待时跳过，避免插入正在由人工处理的对话 |

主动通知的人工接管抑制规则属于本稿建议默认值；以后如允许人工处理中仍发物流通知，需要显式策略和对应验收，不能混用 AI 自动回复开关。通知不依赖客户是否刚发送新文本，不复用 AI 回答的 input_revision 检查。

限流令牌、凭证读取等异步准备必须在最终检查之前完成；等待限流仍是 queued，可以被接管取消。随后在控制对象的短串行临界区复核 epoch、input_revision 和授权，持久记录 sending/attempt 并发起平台调用，接管不能插入到最终检查与调用发起之间。临界区不等待远端响应。平台请求不在本地数据库事务内。

公司权限、策略和知识有效性在异步准备末尾从业务主库重新读取，不能依赖页面缓存或生成时的旧结果。这些 D1 检查与平台调用没有共同事务：撤销后开始的新检查必须拒绝；已经完成检查并进入发送临界区的操作按在途处理。严格的接管顺序保证适用于同一控制对象，不扩大为跨全部资源的即时撤回承诺。

控制对象每次确认新的有效客户输入时增加 input_revision，这一提交定义本地输入顺序；尚未从平台同步到本地或仍未交给控制对象的输入不能被视为已经观察到。回复意图绑定生成依据的输入修订版；期间出现更新、更正或取消诉求，旧候选过期，合并最新输入重新计划。连续被新输入打断达到配置上限时转人工，避免无限重算。Flue 的输入合并不能替代此项业务新鲜度检查。

### 8.3 接管竞态的线性化点

~~~mermaid
sequenceDiagram
    participant U as 客服
    participant C as 会话控制 DO
    participant F as Flue
    participant P as 平台
    U->>C: takeover(commandId, expectedVersion)
    C->>C: 提交 human 与新的 control_epoch
    C->>C: 取消尚未开始的 AI 意图
    C-->>U: 接管成功及已在途消息数量
    C->>F: 请求中止运行
    F->>C: 旧 epoch 的迟到回复
    C-->>F: 拒绝提交或取消
    Note over C,P: 接管前已发起的平台请求仍核对其结果
~~~

两个关键顺序必须可测试：

- 接管先提交、发送后检查：该 AI 回复不得发出。
- 发送先标记 sending 并发起请求、接管随后提交：界面明确已有在途请求；后续新 AI 回复被阻止，已在途结果继续落账。

不能在 Ozon 不支持撤回时用“已接管”承诺撤回在途消息。abort 失败不会重新授权旧 epoch。

### 8.4 幂等与核对

| 来源 | 建议幂等键 | 注意事项 |
| --- | --- | --- |
| 平台入站 | store + channel + platform_message_id | 重复回调和轮询重叠共享键 |
| Flue 提交 | 稳定 ai_run ID 派生的 dispatch_key | 目标与载荷冻结；作为原生 idempotencyKey 传入，不随网络重试改变 |
| 人工发送 | conversation + client_command_id | 重试保留命令 ID，编辑文本创建新命令 |
| AI 回复 | conversation + logical_trigger_id + reply_slot | 不以重试次数作为新消息 ID |
| 主动通知 | store + posting + logical_rule_id + logical_transition_id | 发布新版本不自动绕过去重，不对历史状态补发 |
| 用量扣减 | metric + intent_id | 核对到成功的未知发送只记一次 |

若平台支持幂等请求键，沿用并持久化；若不支持，业务去重只能避免已知重复，不能解决“平台已成功、本地未记录”的全部歧义。

请求超时、连接在提交后断开、部分 5xx 默认归为 unknown。只有官方语义和证据确认未执行的错误才能自动重试。优先按平台 message ID/请求关联核对；仅正文相似不足以证明是同一条消息，歧义转人工核对。

### 8.5 阶段 4C1：人工纯文本发送的落地合同

本片只实现人工纯文本、单次平台请求与结果恢复。第 8.1 节的 AI、通知、取消入口、失败重试及平台回显核对属于后续完整设计；本片没有 `unknown → queued`、`failed → queued` 或按相似正文认定成功的路径。

1. 复用现有 `POST /api/companies/:companyId/conversations/:id/commands`，新增严格 `send_reply`，字段仅为 `commandId`、`expectedVersion`、`action`、`body`。正文保留原文，长度 1—1000 UTF-16 单元，拒绝纯空白、无效 Unicode 和不允许的控制字符。客户端不能设置店铺、收件线程、凭证版本或发送结果。
2. `intentId=commandId`，唯一范围仍为会话控制器。接受时在同一 DO 事务写入控制状态、不可变回执、发送意图和投影事件；version/sequence 加一，epoch、负责人和工作状态不变。原命令重放返回原回执；发送结果只更新意图自己的 revision，不能把接受回执从 queued 改写成 sent。
3. 部署 `OUTBOUND_ENABLED` 必须严格为 `true`，店铺 `outbound_enabled` 也必须开启；默认均关闭。仍需有效凭证、未过期的已确认回复能力、当前店铺权限和 open/human 会话。真实 Ozon 能力尚未通过本片核实，不能靠开启总开关绕过未知能力。
4. 入队时冻结服务器读取的线程、凭证版本、控制 epoch、原 userId/memberId 和正文哈希。派发重新检查原成员的当前权限，不要求浏览器一直登录；成员删除后重新加入产生的新 memberId 不继承旧意图。转交、解决或其他 epoch 变化会跳过尚未开始的发送；只添加内部备注不会使意图过期。
5. 沿用 StoreCoordinator 的店铺总请求间隔和平台退避。等待额度时保持 queued；限流准备、解密之后，在短串行临界区再次检查，落盘唯一 attempt 并发起调用。临界区不等待远端响应；已经发出的请求仍需记账，不能承诺解决/转交会撤回平台消息。
6. 一个 DO 只有一个 Alarm，统一调度投影重试、排队发送和在途截止时间。清空控制事件不能删掉仍有发送任务的 Alarm。D1 `send_intent`、`send_attempt` 仅为带版本的投影，现有目录修复负责重新唤醒，DO 才是权威记录。[Cloudflare Alarm 文档](https://developers.cloudflare.com/durable-objects/api/alarms/)、[短串行临界区文档](https://developers.cloudflare.com/durable-objects/api/state/)。
7. 固定 Ozon Seller API 地址，禁止重定向、隐藏重试和客户端任意 URL。仅可识别的成功响应表示平台接受；HTTP 明确拒绝为 failed，连接中断、超时、无法确认的响应或遗留在途记录为 unknown。每个意图最多一次平台尝试；没有可靠平台幂等或关联查询的证据时，宁可保留未知状态，也不自动补发。[Ozon 发送接口](https://docs.ozon.ru/api/seller/#operation/ChatAPI_ChatSendMessage)。
8. `GET /api/companies/:companyId/conversations/:id/replies/:intentId` 从已授权控制器读取结果，不新建目录。只输出原文、状态、版本、时间和受控结果码，不输出凭证、加密信封或平台线程。接受回执表示已持久保存；`sent` 表示平台接受，不代表消费者已读。错误 `OUTBOUND_DISABLED` 为 403，`CAPABILITY_UNVERIFIED`、`REPLY_UNAVAILABLE` 为 412；写入结果不确定仍为 `OPERATION_UNCONFIRMED`，客户端不得自动换 ID 重发。

本片没有启用前端发送编辑器、中文转俄语确认、自动 AI 回复或主动通知；这些仍按阶段 4 后续步骤实施。模拟平台使用独立持久请求记录验证调用次数；它不能替代真实 Ozon 的套餐、窗口、回执和端到端投递验证。实际测试证据以实施进度第 34 节为准。

### 8.6 阶段 4C2：人工编辑、提交恢复与最近发送

本片接通现有发送管道与消息中心，暂时采用原文编辑、原文预览和显式确认。不会把未生成的文字标为译文；中文草稿生成可编辑俄语及其服务端来源校验仍属于下一片。

- `send_reply` 的公开 HTTP 入口要求 `X-DingBell-Member-Id`：值为冻结成员 ID 的规范 `encodeURIComponent` 编码。客户端把它与接受回执绑定，HTTP 与 DO 都重新核对当前成员，拒绝成员删除后重新加入时把旧草稿归到新成员。正文、历史命令及不可变回执格式保持不变。其它命令不要求此头；内部既有 DO 调用可省略提示，公开回复入口不可省略。
- `GET .../replies` 一次返回当前成员、控制版本、回复条件及最多 20 条权威发送结果。未初始化的会话返回空结果与禁用状态，不创建控制目录。实际接受与派发仍分别重新授权，读取条件不构成发送承诺。
- 最近记录按接受时的 sequence 排序，DO 事务维护一个最多 20 个 ID 的派生索引。旧记录每次最多扫描 50 条；未整理完成时前端禁止新编辑提交，后端仍支持并发接受命令并维护索引。索引跟踪已观察的控制 sequence，旧 Worker 回滚期间的写入会触发重新扫描，不能永久依赖旧的完成标记。索引和原始记录矛盾时明确失败，不能静默丢弃记录或从滞后 D1 冒充恢复。
- 浏览器在 POST 前，将完整原命令写入并读回 `sessionStorage`；键包含 user、member、company、conversation 四个维度。存储失败、记录损坏或已有不同命令时停止提交，不退回只存内存后发送。普通未确认草稿不写入 URL。
- 未确认的命令不自动过期、不自动 POST、不换 ID、不更新 expectedVersion。刷新或返回同一会话后，显式核对原 intent；GET 404 不能证明从未发送，重新确认权限后只能重试相同命令。`COMMAND_CONFLICT` 保留原记录，不能作为普通拒绝清空后创建新消息。
- 原接受回执、相同 ID/正文的权威结果，或明确未接受的拒绝码可以解除本次提交记录；未知错误码和 COMMAND_CONFLICT 保留记录。清理本机记录需完整命令比较，晚到响应不能删除后续记录。显式登出或确认撤权后清理对应本机私密记录；公司/会话切换和短暂离线保持隔离记录，不能一律清空。
- UI 将 queued、sending、sent、failed、unknown、skipped 分开显示。sent 的文案为“平台已接收”，不推断已读；unknown 提供核对指引与结果刷新，不提供自动重发。最近发送与导入的平台消息分开查看，缺少可靠平台消息关联时不按相似正文去重或伪造合并。

恢复范围为同一浏览器标签页的刷新和会话切换；关闭标签页、清理浏览器数据或跨设备后，尚未到达服务端的命令不能保证恢复。已接受的发送保存在服务端。普通编辑草稿只保留在当前挂载页面；本片不承诺通用草稿同步、完整历史审计、翻译、取消或失败自动重试。

### 8.7 阶段 4C3B3：可编辑俄语预览与本机恢复

消息中心复用既有 ShadCN 确认弹层：用户显式生成俄语预览，再打开原文与可编辑译文，最后确认发送。生成、查看均不会提交消费者消息。译文为纯文本，最终确认内容原样交给既有 send_reply 命令，不在前端自动重新翻译或格式化。

- 原文每次实际编辑推进本机修订号；A→B→A 也不复用旧候选。迟到结果不能应用到新的修订号，重新预览会话时也要核对当前控制版本。
- 翻译请求在 POST 前写入并读回独立 sessionStorage 记录，键绑定 user/member/company/conversation；保存失败不提交，没有内存降级。刷新后先确认当前成员，再显式恢复原文和核对原请求；GET 不派发，只有用户明确重试原请求才 POST 同一编号、原文及版本。
- 翻译待核对或预算不可用不阻断原文发送。不可识别的错误保留原请求；已确认未接受才清理记录，旧响应不能清除不同的新请求。
- 手动改过的译文与服务端生成结果分开保存；关闭弹层、返回编辑或服务端明确拒绝后，当前挂载页面保留原文及修改稿。改变原文使其失效；页面刷新并不保存普通草稿或修改稿。
- 已确认发送仍使用四字段的冻结命令（commandId、expectedVersion、action、body），沿用既有发送 journal、权限复查和未知结果恢复。此次没有把前端状态当成可审计的服务端翻译来源。
- 原文、译文输入框限制高度；长文字内部滚动，手机尺寸下确认操作保持可达。桌面及移动尺寸验证为本地 Chromium，不代表真实移动键盘或全部辅助技术已验收。

后续应补充服务端来源关联，保留原预览、人工编辑与最终确认正文之间的关系；当前仅保证前端确认文本和已有冻结发送意图一致。本片不启用自动客服，也不改变翻译和外发的独立开关。测试范围见实施进度第 39 节。

### 8.8 阶段 4C3C1：不可变的原始译文依据

迁移 0018 新增 reply_preview_output，以原 reply_preview_run.id 为主键及限制删除的外键。仅原生回执已绑定、运行未释放的结果可写入；服务先完成原生实例/结果验证和用量处理，再保存精确正文、SHA-256、回执及首次记录时间，成功后才返回 ready。完全一致的并发写入复用原记录，不同正文或回执不会覆盖它。记录带作用域读取并复算正文哈希；该内部读函数不替代公开接口的原成员授权。

数据库阻止内容/时间更新、INSERT OR REPLACE 和已记录结果的零请求退款。后者与预算结算在同一 D1 batch 中失败回滚，不改写原费用。无法可靠持久化或出现内容冲突时，业务接口返回 OUTPUT_UNCONFIRMED 且不附译文；客户端保留原请求等待核对，读取不会派发模型。可信用量即使结果不可展示仍应结算，缺失用量继续 held。

此表是发送来源审计的基础，尚未关联发送命令，也不改变 Flue 的执行权威：原生实例不可确认时，当前公开读取仍报告待核对，不依赖该表静默恢复执行或重新生成。旧运行、预算、回执与 DO 格式不变，模型路由和默认开关保持原状。

### 8.9 阶段 4C3C2：译文确认与发送来源

翻译确认在既有 send_reply 中增加可选 previewRequestId；普通原文发送保持原合同。客户端只能提交原预览编号和人工最终正文，不能指定 run、原文/译文哈希或费用依据。服务端只读 D1 中属于当前公司、店铺、会话及原用户/成员的 run/output，复算原文和模型输出 SHA-256，并在异步读取后再次验权；缺少、未完成或越权的预览返回 PREVIEW_UNAVAILABLE，不创建发送意图。

不可变命令回执及 D1 审计投影记录服务器推导的 translation：requestId、runId、sourceRevision、sourceHash、outputHash、confirmedBodyHash。发送意图继续冻结人工最终正文及其哈希；不把人工修改写回原译文。确认路径不导入模型 SDK、不读取原生执行实例，也不重新生成译文。迁移 0018 是读取冻结依据的前提，本片不新增迁移或改变意图/DO 状态版本。

已接受命令按原回执重放；同一 commandId 改变正文、去掉或更换 previewRequestId 都返回命令冲突。权威发送查询携带原预览编号，本机 sessionStorage journal 同时保存并比较编号与正文；恢复结果不一致时保留原提交供核对，不能降级成无来源发送。客户端也校验接受回执中的来源编号和人工确认正文哈希。

此关系支持后续会话日志展示，但尚未实现完整审计浏览。只验证本地模拟传输；真实俄语质量、Ozon 投递、普通编辑草稿跨刷新、预算管理与无人读取时的核对仍未完成。

### 8.10 阶段 4C4：人工取消排队回复

取消复用现有 commands 入口，载荷为 commandId、expectedVersion、action=cancel_reply、targetIntentId；与发送一样绑定当前成员头。当前有店铺访问权限的公司成员可以取消该会话仍处于 queued 的回复，不要求取消人就是原发送人。关闭外发、会话解决或切换处理状态不会阻止取消尚未开始的消息；已被调度器跳过则保留 skipped，不改成取消。

控制 DO 在同一事务内检查 queued、写入 canceled、清除其发送调度项，并保存取消回执与审计 outbox。取消只推进会话版本/序号及目标意图修订，不推进 control_epoch，不使其他排队消息过期。取消与实际发送的先后由该对象持久事务及已有最终发送检查决定：取消先提交则旧快照不能发出请求，sending 已提交则拒绝取消。canceled 没有平台 attempt、后续 dueAt 或错误码。原正文、翻译来源、原发送回执都保留。

迁移 0019 扩展审计动作和发送状态 CHECK。重建 send_intent 前保存并移开引用它的 send_attempt，随后恢复记录、索引和 6 个保护触发器；不通过关闭外键绕过约束。额外保护阻止取消已开始的尝试、向已取消意图附加尝试或重新排队。迁移失败的整体回滚和原有记录保留均用本地 D1 验证。[D1 外键与级联行为](https://developers.cloudflare.com/d1/sql-api/foreign-keys/)

最近发送中仅 queued 显示取消入口，确认前说明适用边界。未确认响应先读取原 intent，仍排队时才提供同命令显式重试；没有自动 POST。取消确认的临时状态不另建持久草稿：页面刷新后按服务器结果显示，仍 queued 才能重新明确确认；终态不能再取消。原发送 journal 的持久恢复规则不变。旧 Worker 不理解新终态或取消审计事件，不能仅回退代码而承诺安全降级。本片没有实现失败重试、unknown 的平台核对或撤回已发消息。

### 8.11 阶段 4C5：明确未发送正文恢复为草稿

最近发送中的 failed、skipped、canceled 提供恢复入口。已有不同且非空的草稿时先选择保留或替换；恢复保留精确正文、推进本地草稿修订，清空旧预览与翻译候选。未确认的翻译 journal 继续保留，不能借恢复草稿清除尚待核对的模型请求。原发送记录和尝试不变，后续明确预览、确认产生一条新的普通人工发送意图，不宣称重试关联或平台核对已经实现。

恢复本身无 HTTP 写操作。queued、sending、sent、unknown 没有此入口；成员或控制版本未确认、待核对发送、状态更新中不能恢复。弹层保护现有草稿，恢复后焦点返回可用编辑器，否则返回最近发送按钮。这里只保留当前页面的编辑状态，没有新增跨刷新草稿存储、依赖或迁移。

## 9. Ozon 连接器合同

### 9.1 对外统一的业务能力

| 能力组 | 拟定内部操作 | 必须验证的边界 |
| --- | --- | --- |
| 连接 | validateCredentials、inspectCapabilities | 套餐、角色、区域、错误原因 |
| 私聊 | listThreads、listMessages、sendMessage | 分页、时间窗口、消息类型、回执和回显 |
| 主动联系 | canStartThread、startThread | FBO/FBS/rFBS、订单阶段、建聊窗口 |
| 公开问答 | listQuestions、answerQuestion | 是否可用，是否允许 AI 自动提交，关联商品方式 |
| 商品 | getProducts、getProduct | SKU、规格、价格、库存的字段和新鲜度 |
| 订单与物流 | listChangedPostings、getPosting | 拆包、履约方式、状态推进与撤销 |
| 核对 | lookupSendOutcome | 是否有可靠关联标识；没有时返回 unknown |
| 附件 | getAttachment、sendAttachment | 类型、大小、链接有效期、是否允许发送 |

这些是 DingBell 的内部合同，不是声称 Ozon 存在同名接口。具体路径、版本、参数与窗口在阶段 1 从官方文档和授权店铺确定，并记录证据。

### 9.2 能力状态与降级

available 表示已验证；denied 表示当前凭证/店铺不允许；unsupported 表示平台明确不提供；unknown 表示未验证或结果不明确。暂时网络失败不应永久写为 unsupported。

主动建聊不可用时，仍可保留已获授权的读取和已有会话回复；通知规则显示不可启用原因。售前公开问答不可用时，不能宣称系统覆盖该入口。

平台能力映射保存在受版本控制的连接器配置中；店铺检查结果保存在数据库。商家不能编辑能力表将不具备的权限改成可用。

### 9.3 同步和限流

- StoreCoordinator 对同一店铺同步运行使用 lease 与 fencing token，防止过期任务覆盖新游标。
- 每页数据和对应游标推进在可靠提交后完成；回填与增量游标分离。
- 限流器按官方 endpoint bucket 和店铺维度管理；人工回复优先于历史回填，避免大同步阻塞客服。
- 429 读取官方 Retry-After 或等效字段，退避带随机扰动；重试上限和最长任务年龄可配置。
- 长期凭证失效停止持续重试，转店铺“需重连”；恢复后使用保存的游标继续。
- 订单状态映射保存原始枚举及内部状态；未知新枚举进入人工检查，不擅自当作已签收。

### 9.4 已实施的会话同步边界（2026-10-09）

首批同步由自有 `StoreCoordinator` DO 与原生 alarm 执行；Flue 继续负责应用入口和后续 Agent 运行。`src/cloudflare.ts` 只提供具名 DO 与标准 `scheduled` 扩展，不覆盖框架 fetch/alarm 生命周期。每次 alarm 只读一个平台页，总请求预算 10 秒；每分钟 Cron 最多查询 50 家到期店铺，分组唤醒以补偿 D1 已启用但首次 RPC 丢失，不直接扫描全量消息。[原生 alarm](https://developers.cloudflare.com/durable-objects/api/alarms/)

初版 `store_sync` 已由 0007 迁移拆为 `store_coordinator`（共享租约/fence 与供应商等待截止）和 `store_sync_source`（各来源持续授权、epoch、凭证版本、到期与错误）；启停 HTTP 仍核验操作者当前验证邮箱、session 和管理角色。任务持续授权属于公司，后台不依赖启用者继续登录；个人导出任务仍须按申请者当前访问权校验。暂停/断开/凭证版本变化由迁移触发器在同次数据库变更中停用同步并撤销租约，保留游标。再启用必须由当前管理员明确操作，不能凭旧队列消息自行恢复。

`sync_cursor` 分开保存 discovery 和各会话 backfill/incremental 位置。`conversation`、`message`、`ingest_event` 与页游标通过一个 D1 batch 事务一起提交；首条条件更新核验租约/epoch/凭证/店铺版本，后续语句共享该事务取得的 commit token，最后推进游标。任一语句失败则整页回滚，避免多次时间检查导致半页有条件写入。每页 JSON 批量绑定不超过 100 条消息、100 个会话和 1 MiB；不靠每行多个参数绕过 D1 参数上限。

外部 int64 ID 通过原生 `JSON.parse` reviver 的源 token 无损转为字符串，Node 与真实 workerd 已测试；请求数字游标仅序列化经过十进制校验的单字段。未知消费者类型保留 unknown，卖家回显为 outbound；只接收 BUYER_SELLER，其他渠道不冒充消费者对话。消息正文和原始身份/时间不可覆盖，相同 ID 的冲突会拒绝整页。初始 backfill 记录历史来源；Forward 读取排除请求边界后得到的新证据可以单向提升唯一事件为 pending，消息首次导入来源不变。尚无事件消费器、自动回复或外发。

初始空会话保持空增量锚点，使用 Backward 且不传 from_message_id；不能假设 `0` 是合法起点。首次非空页仍属于历史快照，以最新真实 ID 建立 Forward 基线；若存在更早的页，同一事务从该页最旧真实 ID 重开 backfill。消息保存、基线推进和回填重开共用页事务，任一失败一起回滚。建立基线期间观察到的内容不自动当作实时客户请求，后续 AI 启用和消息中心待处理策略须明确覆盖这一边界。

到期 discovery 优先一次，续页间隔 10 秒、整轮完成后 60 秒再发现；历史游标按到期顺序处理，续页至少 1 秒、增量轮询间隔 30 秒。DO 持久保存同步请求许可；供应商 `Retry-After` 的权威截止保存在 D1，启停或换凭证不能清除。连续临时失败达到 5 次停止并显示异常；超过一天的供应商等待停止并等待复核，同时保留不可提前读取的截止。最近 8 个已消费页边界用于循环检测，页内按平台时间方向检查，不猜 ID 的数值顺序。商品同步已接入同一店铺协调器，见 9.5；尚未实现所有接口共享限流、任意长度分页环检测、其他履约方式订单同步或真实多页验收。FBS 包裹同步见 9.6。

### 9.5 商品持久同步与订单后续边界（2026-10-09）

商品和 FBS 只读连接器与聊天共用固定主机、有界请求层；三类来源已分别接入持久调度，FBS 详见 9.6。外部 ID 与金额保留精确字符串。商品总量、短页、详情缺项不能证明删除；FBS 按 posting_number 表示包裹，order_id 仅表达订单归属，不合并拆包。

迁移 `0007_source_sync.sql` 新建 `store_coordinator` 保存共享 fence、租约所属来源和供应商等待截止，`store_sync_source` 保存固定来源 chat、products 各自的启停、epoch、凭证版本、到期、错误和最后尝试时间。先搬迁旧授权/游标再移除旧表；既有聊天和消息保留，旧租约清除并增加 fence，原限流截止保留。后续 0008 将 FBS 加入同一来源枚举，升级与来源边界见 9.6。

聊天 HTTP 与 DTO 保持兼容；商品使用独立 `/sync/products` 路径及 `products_read` 能力。启用时事务内再次验证当前管理权限、店铺与能力有效期，种入来源及工作断点。DO 和 Cron 聚合所有已启用来源；每次租约优先选择最久未尝试的到期来源，每次 alarm 只执行一个有界请求。各来源共享店铺请求间隔和 429 截止。某来源的 403 仅停止该来源；401 或凭证解密失败停止全店。店铺暂停、断开或换凭证在同次数据库写入中使所有来源旧请求失效。

商品持久层分为 `product_sync_cursor`、`product` 当前资料和不可变的 `product_source_snapshot`。列表原子保存商品 ID、待详情任务和 last_id；不能先推进游标再排队详情。列表页与详情批次持久交替，避免大型目录挤占补详情。每次最多请求 50 项，空列表页结束观察轮次，5 分钟后从头重扫；不把空页解释为已证明获得平台全部商品。

详情缺项保留原有资料，30 秒后重试，三次仍缺失转为失败。普通重扫不会无限复活相同失败；列表事实变化或管理员重新启用会重试。新轮次刷新已有完整详情；快照只在事实变化时新增，A→B→A 保留三次变化，重复 A 不重复建版本。来源更新时间未知则保持 null，本地 observed_at 只表示本次读取时间，不伪装为平台版本。停止保留目录位置、已导入资料和积压；重新启用保留位置并更新任务世代。

店铺页将会话、商品的权限、进度和控制分开。商品展示累计发现、已有资料、待补充或更新、详情读取失败；后三者可重叠，明确提示不可相加。写请求冻结用户确认时的 epoch，并校验返回的来源、店铺、状态和下一 epoch；回执不明确时重新读取，不自动重发操作。导入来源资料不会发布知识、开启 AI 或发送消息。

FBS 查询窗口、包裹来源观察和刷新已接入，见 9.6。没有可靠源版本时，不能靠收到时间或自造状态顺序推断状态进展、触发通知。真实商品完整遍历、真实详情和订单状态合同仍待核实，见[平台能力第 8 节](07-platform-capability-review.md#8-商品与-fbs-读取合同补充2026-10-09)。本地迁移、竞态与原生调度证据见[实施进度第 23 节](06-implementation-progress.md#23-阶段-3-第三批独立来源调度与商品持久同步2026-10-09)。

### 9.6 FBS 包裹持久同步（2026-10-09）

`0008_fbs_postings.sql` 增加固定 fbs_postings 来源，独立要求 auth+orders_fbs_read。迁移用影子父子链先复制共享协调、来源和聊天游标，再从叶到根移除旧表；全程保留外键，保留既有聊天/商品事实和等待截止，增加 fence 并清除旧租约。新增 `fbs_sync_window`、`fbs_posting`、`fbs_posting_observation` 三张表，不建立通用回填框架或推测性订单聚合。

首次启用由服务端固定最近 30 天的历史查询范围，UI 在启用前后明确显示。每轮冻结 since/to/cursor；续页保持相同过滤条件，只有 has_next=false 才在观察/待详情任务同一事务推进 lastCompletedTo。下一轮从上次完成时间减去 1 小时继续，每段不超过应用的 31 天预算；落后时每轮间隔至少 1 秒，追到当前后至少 5 分钟再扫。长时间停机分段追赶，不直接跳到最新滚动窗口。准备下一窗也须在有效租约下原子保存后才请求平台。时钟回退时保存未来等待时间，不推进窗口或用 30 秒释放租约覆盖原截止。

每个 posting_number 独立保存，不按 order_id 合并拆包；列表事实与详情事实分开，列表省略字段不能清除旧详情。每个来源只在白名单事实发生变化时增加不可变观察，A→B→A 可留三次历史。SKU、订单 ID 与金额保持精确字符串，重复商品行保留。sourceUpdatedAt 始终未知，不把本地 observedAt 当源版本，也不以 SKU 单独绑定消费者。

列表与逐包裹详情持久轮换，三类来源共享租约、1 秒请求许可及 429 等待。详情成功后 15 分钟再次到期，已知包裹即使不在后续列表窗口、原始状态显示 delivered 也仍刷新。该间隔不是全量按时完成的 SLA，数据量和限流会产生积压。详情网络错误、5xx、超时或非法响应最多三次，间隔至少 30 秒；失败只标记该包裹并保留旧事实，不伪造来源最后成功时间或挡住其他包裹。401/解密失败全店停止，403 仅停 FBS，429 仍走共享等待。

停止保留断点和资料。重新启用保留原窗口，重试 pending/error，并将 complete 任务一并迁入新 epoch、保留后续刷新截止，避免较早包裹永远丢失刷新。最终提交同时核验来源 epoch、租约/fence、凭证/店铺版本及任务 generation/revision；旧页不能覆盖新状态。

HTTP 使用固定 `/sync/fbs-postings`，不接受客户端自选来源；能力、管理角色、session 和店铺授权在入口及事务中复核。界面展示发现包裹、已有详情、待补充或刷新、详情失败、首次起点、当前窗口和完成截止。已有资料与待刷新/失败可重叠；完成截止只表示该查询分页结束，不能冒充可靠状态水位。平台时间过滤基准、边界、排序、游标期限、可靠状态版本、其他履约方式及聊天与订单归属仍待真实验证，不据此触发通知。验收证据见[实施进度第 24 节](06-implementation-progress.md#24-阶段-3-第四批fbs-包裹持久同步2026-10-09)。

## 10. 知识库与回复策略

### 10.1 知识发布管道

Vectorize 基线路径：原文件/结构化资料 → 文本规范化 → 内容哈希 → 修订版 → 分块 → 嵌入 → 索引可见性检查 → 测试 → 原子切换 active_revision。若 ADR-08 选择 AI Search，中间的分块、嵌入与索引由托管管道承担，业务修订版与发布检查保留。

Vectorize 的写入和删除是异步的，因此“写入请求成功”不等于新知识已经可以检索。发布需等待可见性确认；每次命中仍以 D1 有效版本过滤，撤回内容即使暂留索引也不能进入回答。[Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/)

采用 Vectorize 基线时，建议初始分块目标约 500 tokens、重叠 80 tokens，按实际嵌入模型 tokenizer 和俄语/中文数据评估后确定。分块边界优先保留标题、步骤、规格表及商品型号，不把同一商品的变体混在一起。采用 AI Search 时使用经过验证的托管处理与引用标识，不重复运行自建分块/嵌入管道。

只把可稳定陈述的事实与政策放入知识。实时订单、物流、可变库存通过工具查询，返回时间戳；无法查询时明确不确定并转人工。

### 10.2 检索隔离

1. 查询范围由服务器生成：公司 namespace，加已授权店铺/公司通用、产品及语言条件。
2. 先取范围内候选，再检查 document/revision 当前有效性。
3. 原文取自 D1/R2 的已确认修订版，不能只信向量 metadata 中的全文副本。
4. 回答记录引用的文档 ID、版本和片段 ID，不暴露其他租户资源 URL。
5. 缺少可靠候选时使用澄清问题或转人工；不会因为必须输出文本而编造价格、时效或退款政策。

Vectorize 支持 namespace 与元数据索引；索引数量和字段长度有平台限制，索引字段保持精简。[元数据过滤](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)

### 10.2A 阶段 5B-1 的知识基础

资料入口目前为严格 JSON，接受文本、Markdown 或结构化商品事实。请求上限 16 KiB，规范化后的 source JSON 上限 8192 UTF-8 字节；不接收文件 URL，不下载内容，也不把 CSV/PDF 宣称为已支持。原文与分块先存 D1，不依赖尚未恢复的云端 R2。较大资料、附件及真正的文件导入另行接入。

knowledge_document 保存固定的公司、店铺/公司通用、商品引用、语言及类型，保存草稿只递增 draft_revision 与 CAS version；active_revision 独立。knowledge_revision 保存不可变标题、来源、哈希及历史恢复来源；knowledge_chunk 保存不可变正文、哈希和稳定 ID。迁移 0024 的普通更新、删除与 INSERT OR REPLACE 防护必须保留。一次 D1 batch 原子提交文档指针、修订和分块；发布还需 SQL 门禁验证 ready、tested_at、index_profile 与 mutation_id，后续索引器只能在查询确认后写入这些证据。5B-1 时尚未接入索引器；5B-2 的新增执行范围见 10.2B，索引完成仍不能伪造“已发布”。

内容文本做 NFC/换行规范化；店铺和商品引用作为不透明标识保留原样，不把不同 Unicode 形式的 SKU 合并。初始嵌入 profile 固定为 bge-m3-1024-bytes2400-v1：每块含标题/商品引用，最多 2400 UTF-8 字节，正文按换行优先切分并保留最多 200 字节重叠，不拆开 Unicode 码点。它是保守的字节上限，不声称等于前述 500/80 tokens 建议，实际中俄召回评估仍待执行。分块与嵌入 profile 更改必须重新索引并复测，不静默改写历史版本。

唯一检索适配器沿用 Cloudflare 原生 AI / Vectorize 类型（当前异步接口类型为 Vectorize，旧 VectorizeIndex 属于 beta）。BGE-M3 一次独立的合成中/俄/英调用返回 3×1024 维；适配器限制每批 16 段、校验数量/维度/有限非零值，关闭截断。namespace、店铺与商品过滤值由服务端哈希生成；元数据只存范围、修订、引用与摘要，不存全文。需要预先建立 scope、product、language、revision、eligible 五个元数据索引。索引回执不等于可见：queryById 在准确范围内读回完整分块集合，核对唯一 ID、版本及正文摘要后才可视为通过索引可见性检查。

POST /knowledge/citations 在已授权店铺中复核最多 10 个引用的公司、店铺/通用范围、商品、语言、active_revision、分块与正文摘要。正文从 D1 读取；异步哈希后再检查一次发布与权限，任何引用失效则整体拒绝。普通客服仅能验证获授权店铺的已发布引用；管理、历史与草稿接口仍限所有者/管理员。该接口是引用有效性检查，不是自动召回入口，尚未接入 AI 生成和最终发送。

草稿与发布副本使用不同的向量 ID，分别以 profile、阶段和同一个 D1 chunk ID 派生，metadata 保留准确的 chunkId。迟到的草稿 upsert 不能把已经发布的副本改回未发布；引用正文标识保持不变。候选读取同时核对向量 ID 与正文标识的对应关系。两类副本的存储及清理需计入后续用量评估；不能只计算一份向量的成本。

本批没有把向量适配器直接暴露为无预算的公开模型调用。下一批须接入持久索引任务、可见性等待/重试与用量边界、测试记录、候选晋升与 active_revision 切换、失效候选过滤和异步清理。发布门禁所用的就绪证据必须来自发布副本的查询确认，不能复用草稿索引回执。主动撤回先停止 D1 使用，不等待远端删除；检索候选与最终引用验证需要分开，不能让暂存候选占满 topK 后错误宣称旧版本仍可召回。所有端到端发布和恢复验收在这条链路接通后再签署。

### 10.2B 阶段 5B-2：持久索引到可测试

Flue 2.2 已移除旧 Workflow API，其安装版 migration 指南建议把独立的持久多步骤任务放在 Cloudflare Workflows。这里新增 KnowledgeIndexWorkflow，沿用原生 D1、Workers AI、Vectorize 和现有每分钟 scheduled 入口；没有再实现通用任务队列，也没有替换 Flue 对话/翻译 Agent。

1. 管理员调用 POST /api/companies/:companyId/knowledge/:id/index，提供 jobId UUID 与 expectedVersion。D1 batch 原子更新文档 CAS 版本、建立 knowledge_index_job、预留 knowledge_index_usage，并把该修订标为 indexing。同一公司、文档、原期望版本和发起人重试原 jobId，读取原任务；不重复预留。任务状态由 GET /:id/index-jobs/:jobId 读取，不返回嵌入缓存或正文。提交后先进入 queued，定时调度负责启动。
2. 任务冻结公司、修订、内容摘要、分块 profile、发起用户和原成员 ID。每个外部步骤与最终写入重新检查当前修订、CAS 版本、原成员的管理员权限及已验证邮箱。浏览器退出登录不取消已接受的后台工作；成员被移除后重新加入不能继承旧任务。编辑、恢复或撤回递增文档版本，使旧任务失效。
3. 模型调用前先持久写入唯一尝试记录；工作流的嵌入步骤不自动重试。若结果已保存而确认响应丢失，复用 D1 缓存；已记录尝试却没有结果则终结为 unknown。45 秒调用等待上限不意味着上游已停止收费，因此未知调用仍占用预留。显式重试须使用新 jobId 和最新版本，并再次预留。
4. 缓存的向量只 upsert 到不可变的草稿副本。丢失 upsert 回执允许按同一组 ID 重试，不再次嵌入。可见性最多检查 30 次，相邻检查用 Workflow sleep 等待 10 秒；每次验证完整分块集合与范围元数据。写入被接受并不算索引就绪。就绪时原子标记任务 succeeded、修订 ready，清除临时向量缓存，tested_at 始终保持 NULL。
5. 调度器每次公平推进最多 50 个到期目录、每批 5 个；先后移 wake_after，再调用 Workflows。Workflow ID 由公司和 jobId 的摘要生成。创建回执丢失时按同一个 ID 核对；不会重启 complete/errored/terminated 的实例。任务有 15 分钟绝对期限，超期记录失败或未知；失败和取消均不切换 active_revision。定时启动、恢复检查均无公开的任意派发接口。

启用需要 KNOWLEDGE_INDEXING_ENABLED=true、KNOWLEDGE_DAILY_INPUT_BYTES 正整数字符串（上限 10^9）、KNOWLEDGE_WORKFLOW、KNOWLEDGE_AI、KNOWLEDGE_INDEX。后两者在默认配置中没有绑定；不能通过新接口触发未配置的模型。索引必须为 1024 维 cosine，并预建 10.2A 的五个元数据索引。部署前应用迁移 0025；已有 0024 触发器保留不变。

预留按整个部署的 UTC 日累计实际分块 UTF-8 字节，覆盖标题、商品引用及重叠内容，每公司每日另限 100 次任务。删除来源、取消、失败、未知均不退回当日预留，防止删除重建绕过计量；usage 表独立于来源级联删除。它只是保守的输入与调用次数边界，不是金额预算、token 统计或免费额度保证。模型价格、向量存储、查询、Workflow 和 D1 的实际费用尚未完成统一结算。

当前 ready 仅表示草稿向量可查询。后续必须接入检索测试记录、发布副本的单独可见性证据，再原子切换 active_revision；不能只把 tested_at 写成非空就开启现有发布接口。原已发布内容不会因新索引任务失败而撤下。知识库 UI、文件导入、真实语义评估、失效候选召回补偿及异步清理仍待实现。

验证边界：原生 workerd/D1 测试通过完整索引流程及模型失败。固定版本 Miniflare 4.20260730 的 TimePriorityQueue.handleNextAlarm 实现为空，整个模拟器重启后不能据此证明自动闹钟唤醒；本地测试明确发送测试事件唤醒，再验证已完成模型调用与 upsert 未重复。该事件入口只存在测试夹具，生产包禁止包含。不能将本地显式唤醒写成云端验证通过。5B-3 后续已在独立云端 Worker/Workflow/D1 上验证定时等待和显式实例重启：重启后的五段 10 秒等待正常完成，合成模型与 upsert 未重复；四块较大资料也到达可测试状态。该实验仍使用合成 AI/索引替身，不能证明实际 ANN 延迟、真实 1024 维语义质量、强制隔离进程故障或业务发布链路。详见实施进度第 53 节。

D1 远端迁移还存在触发器表达式解析兼容限制：当前账号最小复现中，CREATE TRIGGER 内的 SELECT CASE … END; 经 /query 返回 incomplete input，改成 SELECT (CASE … END); 后能够创建，合法写入通过、非法写入仍被触发器拒绝。迁移集已为 9 个文件的 31 个表达式补括号；不改条件、异常类别、表结构或历史迁移编号。新安装应使用当前文件，已有成功迁移的数据库不应为了此兼容修复手工删除/重建触发器。该黑盒结果与 [Cloudflare workers-sdk #4727](https://github.com/cloudflare/workers-sdk/issues/4727) 报告的问题一致；未声称检查过 Cloudflare 服务端源码。

### 10.2C 阶段 5B-4：发布副本的独立门禁

迁移 0026 在修订上增加 published_profile、published_mutation_id、published_at，并替换 knowledge_publish_guard。发布必须同时满足已测试、ready、草稿索引回执存在、发布 profile 与当前索引 profile 一致、发布回执非空，以及发布确认时间不早于测试。应用 SQL 与数据库触发器都检查；读取时只向前端暴露 publicationReady，不暴露回执。旧数据库的现有 active_revision 保留，不为其补造历史证明；后续发布需满足新门禁。

copyKnowledgeToPublished 读取草稿副本的向量，核对全部 ID、命名空间、公司/店铺/商品/语言/修订/内容哈希/profile 元数据与数值形状，按原分块顺序写入独立发布 ID；没有第二次嵌入调用。缺失、重复或不匹配全部拒绝，不进行部分发布。复制返回的仍是接受回执，调用方必须继续用 isKnowledgeVisible(..., true) 查询发布副本，再在当前版本与权限的条件下记录证明。写入与查询可见性分离的依据见 [Vectorize 写入机制](https://developers.cloudflare.com/vectorize/best-practices/insert-vectors/) 与 [客户端 API](https://developers.cloudflare.com/vectorize/reference/client-api/)。

本批只补数据库门禁和复制适配器，没有启用测试结果写入、发布证明写入或持久晋升工作流；因此不能把人工注入合成证明的测试当成完整业务发布。下一步持久测试必须冻结修订、profile、用例与成员身份，重测/重建索引须清除失效证明；晋升等待中保持旧 active_revision，最终再做权限与版本检查。真实检索质量、候选过滤、旧版本召回和过时副本清理仍待接入。

### 10.2D 阶段 5B-5：持久检索测试与发布

knowledge_review_job 同时保存 test/publish 两种已知操作：冻结修订、hash、profile、发起成员身份、文档版本、测试问题或所依赖的测试 ID。利用新增 KnowledgeReviewWorkflow 执行，现有定时入口修复 outbox；实例 ID 稳定、确认丢失时按同一 ID 核对，不自动重启终态实例。没有新增自建队列或替换 Flue 的 Agent 执行器。

测试接口为 POST /knowledge/:id/tests，携带 jobId、expectedVersion、cases。每组 1–5 个不同问题；单题最多 2,400 个 UTF-8 字节，每题显式给出 expectedChunkId 和 0–1 的 minimumScore。预期片段必须属于当前修订。GET /knowledge/:id/test-inputs 返回当前版本的片段供选择；GET /knowledge/:id/reviews/:jobId 读取结果，GET /knowledge/:id/reviews?after=… 按 ID 游标分页读取历史。只有管理员可访问，客户端不能提交通过标记或向量。

提交通过 D1 batch 原子推进版本、冻结任务和预留额度。问题与来源分块共享既有每日输入额度；每公司每天最多 100 次 review 提交。失败、取消、未知和删除来源不释放输入预留。模型调用前记录尝试，超时/确认不明不自动再调用；已保存嵌入可继续使用。检索仅查询这份草稿修订的前三个候选，核对全部元数据并保存实际片段与分数。所有用例命中预期片段且达到所设阈值，才写 tested_at；失败结果保留，且不发布。这是单份资料的检索检查，不是整个知识库的召回评估，也不是 AI 回答正确率；相似度阈值仍需实际语料校准。

POST /knowledge/:id/publish 携带 jobId、expectedVersion 时提交异步发布，引用当前有效的通过记录；既有不带 jobId 的入口只允许已具备独立证明的条件切换。提交清除旧发布证明，复制向量后最多 30 次查询检查、29 次 10 秒等待，任务绝对期限 15 分钟。可见后在同一 D1 batch 内确认任务、保存独立发布证明、切换 active_revision 并记录结果审计。新提交与最终切换分别递增版本，接近版本上限时提前拒绝。等待、失败、编辑、权限撤销均不能提前替换旧指针。

失败的发布可用新 jobId 显式重试，沿用仍匹配修订/hash/profile 的通过测试，不再调用模型。新测试覆盖、资料编辑、撤回及其他版本变化会使旧运行失效。发布复制可按稳定 ID 重试；已接受的后台任务不会因浏览器退出登录而取消，但成员移除后重加也不能继承旧任务权限。原生验证使用合成绑定及显式本地唤醒，真实云端 review 运行和语义质量仍未验收。查询副本可能在 D1 切换前已可见，因此生产检索必须继续使用 D1 生效指针过滤；旧版本不被无效候选挤出 topK 的保障和索引清理仍待实现，不能把指针保留当成完整召回保证。Vectorize 的异步写入及查询 API 依据见 [官方接口说明](https://developers.cloudflare.com/vectorize/reference/client-api/)。

### 10.2E 阶段 5B-6：按生效修订检索与最终复核

retrieveKnowledge 是内部的客服会话权限检索服务，接收服务器取得的公司/用户/session、店铺/商品/语言范围和既有嵌入向量。本批没有开放新 HTTP 模型入口，也没有给无人值守 AI 借用所有者身份；问题嵌入、预算预留与自主 AI 授权需在后续调用层接入。相似度原样返回，不冒充置信度，也不擅自设置回答正确率阈值。

先从 D1 主绑定读取当前店铺访问权、原成员 ID 及匹配文档的 active_revision、内容 hash 和版本。公司通用、当前店铺通用、当前商品知识合并，语言必须相同；未指定商品时不查任何商品专属资料。当前 profile 不受支持则明确失败。使用普通 D1 binding，不使用可能滞后的 read-replica session，依据见 [D1 读取副本说明](https://developers.cloudflare.com/d1/best-practices/read-replication/)。

将 D1 生效修订派生出的 revision hash 作为 Vectorize 的 `$in` 过滤条件，并继续限定公司 namespace、店铺、商品、语言及发布副本。过滤发生在 topK 之前，所以待发布和撤回后未清理的副本不能占用候选名额。每批最多 20 份生效修订，过滤 JSON 严格小于 2,048 字节，每批取 10 个候选；合并时按分数排序，分数相同以 chunk ID 确定顺序，最终最多 10 个片段。提供方返回的命名空间、修订 hash、文档/片段 ID、profile、内容 hash 等均需核对；正文只从 D1 读取。限制与过滤时序依据见 [Vectorize 元数据过滤](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/) 和 [查询限制](https://developers.cloudflare.com/vectorize/platform/limits/)。

单次范围最多匹配 160 份生效文档，读取第 161 份用来检测超限，不能悄悄截断。这是单个公司/店铺/商品/语言组合的检索工作量上限，不是整个商品目录数量限制。超过时返回 KNOWLEDGE_RETRIEVAL_LIMIT，由后续调用层展示受限状态或转人工。最多 8 个索引请求/轮；发布版本变化允许完整重查一次，两轮仍变化返回 KNOWLEDGE_CHANGED，不交付部分结果。该上限约束向量调用次数，不代表 D1 扫描成本或整体查询时长已完成性能验收；大目录范围查询仍需基于实际数据量验证。

引用解析保持已有正文哈希和权限二次验证；最后再读一次当前生效集合，检查成员 ID、角色、店铺授权和全部文档版本。失去权限直接拒绝，移除后重新加入也不能继承在途查询。版本变化时重查整个集合，从剩余有效内容补足候选；索引返回错误、伪造引用、超限与无访问权都不能伪装成“没有知识”。如果某一批有生效文档、索引却返回零候选，并且 D1 生效集合没有变化，则返回 KNOWLEDGE_INDEX_NOT_VISIBLE；不能把暂不可见当成没有知识，也不能略过该批返回部分成功。授权且稳定的空范围才返回空列表。最后一次数据库读取之后发生的变化无法由这次快照预知，生成/发送前仍必须重新核对引用，不能把本批内部检索当成完整 AI 发送闭环。

本地用例与原生 Worker/D1 已验证上述行为，索引提供方仍为合成替身，没有宣称 ANN 必定精确召回或真实 1024 维语义质量通过。没有新增依赖、数据迁移或外部资源。

### 10.2F 阶段 5B-7：知识库管理界面与任务恢复

知识库入口为 `/workspace/knowledge`，沿用 React、ShadCN Base Nova、TanStack Query、Valibot 和现有公司权限边界。列表支持类型、店铺/公司通用、语言、已发布/未发布四组服务端筛选，先筛选再进行 20 条 ID 游标分页；不将当前页数量显示成总数。选中文档进入草稿、检索测试和版本记录三页签，生效版本独立展示。原商品同步数据仍不自动成为已发布知识。

新建可编辑纯文本、Markdown 或结构化商品属性；商品资料须绑定店铺和商品标识，属性名称不可重复。来源总大小继续服从后端的 8,192 字节约束。切换商品/正文格式须明确确认清空内容；保存后公司/店铺/商品/语言/类型范围固定。Markdown 按文本显示，不执行 HTML。每次保存创建新修订，恢复历史内容同样产生草稿，不跳过索引、测试与发布。

列表同时返回部署的 indexing/review 能力，未配置时显示原因并禁用相应操作，不伪造成功任务。详情新增当前 `operation` 引用，依据同一公司、文档、mutation_id 与版本恢复索引、测试或发布任务；成功发布的最终版本增量也保留引用，后续编辑或撤回则使引用失效。浏览器使用完整公司/文档/任务键查询状态，任务存活时轮询只读 GET，终态后重新读取正文、生效版本和记录。切换公司或失去权限仍走既有缓存/组件清理流程。

测试问题、预期片段和分值随后台任务保存；页面从当前修订片段选择预期结果，最多五题，历史问题可显式复用并重新核对片段。相似度不显示为准确率，单份资料检查不冒充全库质量测试。发布采用有 jobId 的异步入口，须确认；测试通过本身不会发布。未知 POST 结果保留提示，读取服务器状态后由用户核对，不自动重新发送。版本冲突保留本地表单，明确读取最新版本后才能基于新版本继续编辑。

未保存正文和测试问题接入工作区离开确认，涵盖侧栏、页内切换、浏览器后退、公司切换及退出。使用 React Router 的数据路由与官方 [useBlocker](https://reactrouter.com/api/hooks/useBlocker) 执行 SPA 导航阻断，关闭/刷新由 beforeunload 提示；不伪造浏览器历史。数据路由只承载既有 App，未迁移既有 API 或查询缓存。此批只由知识库注册未保存状态，其他编辑页保持原行为。

知识库的后台身份核验使用 React [Activity](https://react.dev/reference/react/Activity) 隐藏编辑器及弹窗，同时保留内存中的表单状态。恢复边界包含用户、session、公司与角色；账号、会话或权限变化不会沿用旧编辑器。核验期间到达但未能应用的写入回执进入“结果待确认”，恢复后须读取最新版本，不自动重写。此机制不提供离线、核验失败、硬刷新或关闭标签后的草稿持久化；明确撤权、断网或登录状态重置继续清除工作区。配置读取失败提供单独的重读入口，不迫使用户丢弃编辑内容。

浏览器隔离环境复用真实 Hono/D1/Workflows，嵌入与向量存储使用测试替身，并由受令牌保护的测试入口显式调度。生产构建排除这些入口。没有新增包、数据库迁移、真实模型调用或云端资源；最新 Figma 读取额度受限，本批依据已有设计规范和组件完成页面，不宣称最新画板逐项一致。文件上传、CSV/MIME、真实语义评估和生成/发送前的引用复核仍在后续范围。

### 10.2G 同步商品导入知识草稿（阶段 5B-8）

知识库的“从商品导入”读取现有 D1 商品来源，不调用平台或模型。管理员按店铺浏览商品，服务端先限定公司/店铺再按商品 ID 分页，每页 20 项；待同步、详情失败和归档状态分别展示。预览成功后才能确认导入，已有草稿则同时展示当前内容与待导入内容。

自动导入的商品范围使用 Ozon `product.id`。以公司、店铺、平台商品 ID 和语言生成稳定 UUIDv8 文档 ID，不将相同 `offerId` 或 FBO/FBS SKU 视为同一个商品。语言决定检索范围和属性名称，不自动翻译原文。旧手工知识的 opaque `productRef` 保持原值，不隐式重映射；后续 AI 调用应在会话商品唯一匹配时取规范平台商品 ID，匹配不明时不能借用某个变体的资料。

当前同步合同只有基础资料，因此导入名称、商家货号、平台商品 ID 三项；价格、币种、库存和归档状态不进入静态知识，也不生成尚未采集的尺寸、颜色或使用说明。超过标题长度时以平台编号命名，但完整名称仍需符合属性值上限；不静默截断来源内容。未就绪、归档、缺失或不支持的来源返回明确失败。

预览返回来源快照、当前文档版本和当前草稿。提交只接受店铺、商品、语言、快照 ID 与预期版本，正文从服务端来源重建。D1 写事务再次检查成员权限、文档版本、当前商品详情状态，以及当前商品/所选快照与预览时冻结的原始事实是否一致；头记录、修订、分块与来源关系一并提交或回滚。新修订仍是草稿，不改变 active_revision，不启动索引或发送。

迁移 `0028_knowledge_product_sources.sql` 为修订增加来源表及索引。复合外键限定同公司、店铺与商品，触发器保护文档范围、导入关系和已引用快照。不可变保护同时覆盖主键和重复快照唯一键，避免 SQLite `INSERT OR REPLACE` 把旧来源移到另一修订版。数据库中的原始快照保留完整证据，知识正文只包含允许的稳定字段。

同一来源重复或并发导入复用原修订，不覆盖后来的人工修改。仅价格等非知识字段变化时，归一化内容哈希相同则不增加修订；新的知识内容需要明确确认当前草稿版本。审计回执丢失后可读取来源对应的导入记录，浏览器不会自动重提 POST。成功提示同时绑定文档和快照，后台同步更新来源后不能继承旧快照的成功状态。

此批复用已有 Valibot、D1、审计、知识写入和 ShadCN 组件，无新增依赖。原生和浏览器验证使用合成商品来源；并未执行真实店铺同步、模型调用、云端迁移或部署。文件/CSV 导入、真实语义质量、知识缺口及自主 AI 生成/发送前复核仍待后续验收。

### 10.2H 有界文件导入（阶段 5B-9）

新增知识库“从文件导入”，接受 UTF-8 的 `.txt`、`.md`、`.markdown` 和 `.csv`。文件最多 64 KiB，包含表单字段的请求最多 80 KiB；CSV 使用严格的 `title,content` 表头，最多 20 条记录。引号、逗号、BOM、字段内换行由固定版本 `csv-parse@7.0.3` 处理，采用其 [Browser ESM 同步入口](https://csv.js.org/parse/distributions/browser_esm/)，已在本地真实 workerd 中验证。解析器设置[记录长度上限](https://csv.js.org/parse/options/max_record_size/)并在超出行数时停止，不使用自写 CSV 分割器。CSV 格式化导出仍属于阶段 7 的独立范围。

预览和确认都是同源、已登录的 multipart POST，分别为 `knowledge/file-preview` 和 `knowledge/file-import`；前者没有写入副作用。服务端检查扩展名、声明 MIME、UTF-8 解码、控制字符和常见二进制标识，不把 MIME 当作可信证据。浏览器未提供类型而转成 `application/octet-stream` 时，继续做上述内容校验。PDF、扫描件、无效编码、损坏/列数不一致的 CSV、重复表头、重复知识和超限记录明确拒绝；不跳过坏行、不截断内容、不将失败显示为成功。单条规范化 source JSON 继续限制为 8192 UTF-8 字节，标题最多 160 字符。CSV 内容错误返回有限记录编号；不返回文件正文片段或解析器原始错误。

一次文件应用同一公司、可选店铺、知识类型和语言；类型为政策、使用说明或常见问题，不从文件中的字符串推断商品身份。结构化商品继续使用已有的专门入口。文本/Markdown 的标题可编辑，CSV 标题来自每条记录。所有记录通过原有知识合同规范化后，服务端按公司、范围、格式、标题及正文派生稳定文档 ID。CSV 调整行序、Unicode 规范化或文件重命名且标题不变，不产生重复记录；不同语言/店铺/格式保持隔离。预览清单摘要额外绑定原文件 SHA-256、名称、大小和目标列表；文件或范围变化须重新预览。语言仅限定检索范围，不自动翻译。

先校验整份文件，再逐条通过既有 D1 草稿事务和审计保存。每条记录的头、修订、分块仍然原子；整个多行导入不是一个跨行事务。故障可能留下部分已保存记录，回执不明时先重新预览核对，再由用户明确提交剩余记录，系统不自动重发。首版不可变内容哈希用于确认已有导入；重试只复用相同首版，不会覆盖后来的人工修订或改变生效指针。若相同派生 ID 对应另一原始内容则拒绝。权限在读取与每次写事务重新验证，跨公司、无店铺归属或撤权请求不能借用该入口。

导入只创建草稿，不按文件名更新旧知识，不触发索引、测试、发布或外发；要更新原知识须在原草稿中编辑。规范化正文与历史版本保存到 D1；原始字节、文件名/原文件摘要和预览清单不作为持久上传附件保存，也不提供原文件下载。关闭页面后需重新选择文件核对，不宣称已有持久导入任务。较大资料的原文件留存与清理、R2 和异步导入另行实施。

界面复用 ShadCN 的表单、卡片、提示和确认弹窗，提供 CSV 示例、完整文字预览、待导入/已存在计数及已保存草稿入口；Markdown 以文字展示，不执行 HTML、不下载其中的链接。改变文件、标题或范围清空旧预览，未完成选择沿用工作区离开提醒。本批没有新增数据库迁移、云端部署或真实模型/平台调用。

### 10.2I 从检索测试派生知识缺口（阶段 5B-10）

知识库的“知识缺口”读取现有 `knowledge_review_job`，以公司、任务 ID 和用例序号标识原始失败记录，不新建重复的任务表。只纳入已完成且错误码为 `RETRIEVAL_TEST_FAILED` 的失败用例；模型、索引及其他服务异常不当作资料缺失。每条记录保留不可变问题、原知识修订/标题、适用范围、原分值要求、实际预期片段得分（未命中为 null）与测试时间。它是待人工核对的检索问题，不是消费者投诉，也不证明资料内容必然有错。

`GET /api/companies/:companyId/knowledge/gaps` 仅供所有者和管理员，读取前后均重新验权，SQL 同时限定公司及成员。状态、店铺（含公司通用）、语言、知识类型先筛选再分页，每页最多 20 条；不接受重复参数或额外筛选字段。游标由原任务 UUID 与用例序号组成，保留 UUID 原始大小写，使用稳定键顺序，不承诺按最近时间排序。读取不会派发模型或写入记录。

状态实时派生为“待核对”“草稿复测通过”“对应版本已发布”。复测必须晚于失败任务的文档版本序号，不能用秒级时间戳判断先后；同一秒内旧通过结果不能清除后续失败。证明还要求同一文档/问题、当前草稿或生效修订、不可变内容与索引配置匹配，保存结果确实命中重新选择的预期片段，且测试阈值和得分均不少于原要求。发布状态额外核对该版本的发布证明和生效指针；撤回后不保留“已发布”标签。无效或过时证明回到待核对，不提供手动标记已解决来绕过测试。

界面复用现有 ShadCN 与知识编辑器。选择“用此问题复测”带入原问题和最低分值，但清空预期片段，要求用户选择当前版本片段；编辑、索引、测试和发布仍沿用原来的独立操作、版本冲突和离开保护。每条对应一次原测试，不将多次相同问题合成消费者数量；空列表不表示所有问题都能回答。查询大量历史记录的性能、真实语义阈值和真实消费者问题采集另行验收，本批无新增依赖、数据库迁移或外部调用。

### 10.2J 固定语义评估与分数边界（阶段 5B-11）

`probes/knowledge` 是独立诊断程序，复用实际分块、内容哈希和 BGE-M3 嵌入适配器，不属于生产路由。固定资料/标签、精确输入、模型/profile、阈值和排序配置共同进入数据集摘要；向量按输入键匹配，不能靠文件行序猜对应关系。缺失、重复、不同摘要/profile、非有限值、全零向量或错误维数不能产生质量报告。准备清单和离线评分不读取凭证、不加载远端绑定；只有显式启用的 collect 才连接官方 Wrangler AI 绑定。

收集入口要求新目录，逐批先保存尝试、再调用模型、保存结果后才继续下一批；不覆盖已有记录，不自动补发失败/回执未知的请求。固定批次最多 16 条、计划最多 64 条/32,000 输入字节，单条沿用 2400 字节；输入字节不是 token 或货币预算。实际调用前另核对账号额度与授权。超时/结果记录失败保留原始文件并停止，不将部分向量凑成完整报告。离线结果文件最多 2 MiB。

此批对 12 份中俄合成资料、36 个问题运行真实嵌入，排序使用本地精确余弦计算，候选集按预声明的资料语言选取。它不复制或验证生产授权，也不代替 Vectorize 近似查询和发布工作流验收。固定校准/保留各 18 题，分别记录 hit@1、hit@3、MRR@3、原预期得分与无依据问题的高分候选；不报告生成答案准确率。

28 个有依据问题的预期资料均排第一，但 13 个低于诊断阈值 0.7；有依据得分约 0.536–0.774，无依据问题的最高候选约 0.496–0.627，区间重叠。结论只支持：该小样本中排序可用，单一分数不能可靠判定资料是否足以作答。保留原生产 profile 和发布合同，不为了报告通过而降阈值。后续 Agent 仍须判断请求事实是否存在于有效引用/订单工具结果中，无依据时澄清或转人工；该执行与质量门禁尚未实现。

### 10.3 策略数据结构

| 字段组 | 内容 |
| --- | --- |
| 身份与范围 | logical_rule_id、kind、organization、stores、channels、business_stage |
| 版本 | revision、draft_base_revision、published_by、published_at、schema_version |
| 自动回复 | 接待方式、语言、语气、知识范围、转人工条件、模型档位、预算 |
| 主动通知 | trigger、conditions、delay、quiet_hours、expiry、frequency_cap、content、variables |
| 控制 | enabled、priority、effective_from、rollback_of |

自动回复在一组重叠范围内只有一个有效策略，或必须有明确优先级；发布时检测同优先级冲突。主动通知可以有多个规则，但每条有稳定 logical_rule_id 和去重语义。

首版使用类型明确的有限条件集合，不提供任意脚本。需要嵌套 AND/OR 时可用 JsonLogic 计算受限、无副作用的条件；字段和操作符使用白名单，发送动作不属于可编辑表达式。

### 10.4 发布与延迟任务

- 发布版本不可变；回滚是重新发布一个引用旧内容的新版本，审计记录操作者及原因。
- 新版本默认仅影响发布后触发的新任务；已有任务保存当时的策略和正文版本。
- 关闭规则或关闭自动化是立即有效的抑制条件，所有尚未开始的发送在执行前重新检查。
- 若要将待执行任务迁移到新版本，提供显式重算操作及影响预览，不能悄悄替换内容。
- 已发生的历史状态不因重连、回填、策略编辑再次触发通知。
- 静默时段使用公司 IANA 时区；推迟后超过通知有效期则 skipped，不补发过时消息。
- 已取消、退回或状态已经超过该提醒目的的包裹，应跳过原待取件等通知。

## 11. API 与前端交互合同

### 11.1 API 约定

- 所有业务路径在 /api 下。Better Auth 的标准路由沿用官方处理器。
- 公司范围通过服务器验证；路径含 organization ID 也不代表获得授权。
- 写请求有 request_id；有副作用的命令增加 idempotency key 和 expectedVersion。
- 列表使用游标分页，排序字段加 ID 保证稳定，不用大 OFFSET 扫描无限历史。
- 错误返回稳定 code、可理解 message、requestId、必要 fieldErrors 和可重试信息，不回传堆栈或凭证。
- 典型错误：UNAUTHENTICATED、FORBIDDEN、VERSION_CONFLICT、CAPABILITY_UNAVAILABLE、REPLY_WINDOW_CLOSED、SEND_OUTCOME_UNKNOWN、POLICY_NOT_PUBLISHED、BUDGET_EXCEEDED。

### 11.2 核心端点草案

| 端点 | 用途 | 核心校验 |
| --- | --- | --- |
| GET /api/bootstrap/status | 初始化状态 | 不泄露令牌/已有管理员个人信息 |
| POST /api/bootstrap/claim | 创建初始所有者 | 安装令牌、原子认领唯一任务；身份与组织按 4.3 节分步恢复 |
| GET/POST /api/stores | 列表/创建连接 | 公司角色、加密凭证、幂等 |
| POST /api/stores/:id/check | 能力检查 | 店铺归属、限流 |
| POST /api/stores/:id/pause | 停止同步或自动化 | 明确暂停范围和在途任务 |
| GET /api/conversations | 列表、筛选、搜索 | 公司、可见店铺、游标 |
| GET /api/companies/:companyId/conversations/:id/messages | 原文历史分页 | 当前会话访问、成员绑定、固定导入上界与 DTO 白名单 |
| GET /api/companies/:companyId/conversations/:id/message-updates | 追加消息补读 | 当前会话访问、成员绑定、固定本批上界、有界顺序续读 |
| POST /api/conversations/:id/commands | 接管/转交/解决/恢复 | commandId、expectedVersion、动作权限 |
| POST /api/companies/:companyId/conversations/:id/reply-previews | 提交或恢复翻译预览 | 原成员、原文及草稿版本、服务端配置与预算；同一请求编号不换载荷 |
| GET /api/companies/:companyId/conversations/:id/reply-previews/:requestId | 读取翻译预览 | 仅原用户/成员；有界读取、核对 uid、迟到用量结算；不派发模型 |
| POST /api/conversations/:id/replies | 确认回复 | 预览哈希、版本、收件人及发送检查 |
| GET /api/companies/:companyId/conversations/:id/notes | 内部备注分页 | 当前权限、范围绑定游标、有界 DO 读取 |
| POST /api/companies/:companyId/conversations/:id/commands（add_note） | 添加内部备注 | commandId、expectedVersion、正文；不进入外发处理器 |
| GET/POST /api/knowledge | 知识列表/草稿 | 公司、店铺、类型、文件限制 |
| POST /api/knowledge/:id/publish | 发布修订版 | 发布权限、索引就绪、预期版本 |
| GET/POST /api/policies | 策略查询/编辑 | 自动回复和通知分别版本化 |
| POST /api/policies/:id/test | 模拟测试 | 默认无真实发送、限制成本 |
| POST /api/policies/:id/publish | 发布 | 影响范围、重叠检查、版本冲突 |
| GET /api/audit/conversations | 日志与统计 | 过滤白名单、权限与时间边界 |
| POST /api/exports | 创建 CSV 任务 | 范围、字段、权限、数量上限 |
| GET /api/exports/:id/download | 下载文件 | 当前权限、任务归属、到期检查 |
| GET /api/usage | 用量 | 公司范围，敏感成本按角色显示 |
| POST /api/billing/checkout | 可选订阅 | 所有者、服务端价格 ID、组织归属 |

HTTP 路径在阶段 2 固化为共享合同；本表不声称 Better Auth 自带全部业务端点。

店铺首批已实现的接口以 `/api/companies/:companyId/stores` 为前缀，取代上方店铺端点草案：列表/创建、`/:storeId` 详情、`/:storeId/credentials` 更新凭证、`/:storeId/state` 暂停/恢复/断开、`/:storeId/check` 只读检查，以及 `/:storeId/grants` 列表和 `/:storeId/grants/:memberId` 授权变更。小规模店铺和成员管理列表暂用每页 100 条的 offset；客户会话、审计历史等大列表仍按游标合同实施。创建固定客户端生成的 ID，重放或同公司重复平台账号返回冲突，不借创建接口覆盖凭证。其他店铺变更校验 `expectedRevision`，授权变更校验 `expectedGranted`。

### 11.3 前端状态与刷新

TanStack Query 的缓存键必须包含公司、店铺范围、会话或筛选版本；切换公司清空敏感缓存及未发送草稿上下文。表单草稿保存在当前用户和当前会话范围，不跨公司复用。

4D3 的消息正文使用可见标签页增量轮询，平时每 5 秒、跟随积压批次时每 1 秒；隐藏页停止周期读取，恢复后按保存的追加边界补齐。会话列表、详情与控制状态仍各自复核。4D2 定义追加序号与读取合同（11.3D），4D3 的窗口、双向定位和恢复边界见 11.3E。提交命令后的返回值用于立即更新当前视图，再从服务器核对。

AI 测试台如需逐字输出，使用受权限保护、字段过滤后的流；断线仅影响观察，不决定任务是否存在。暂不引入独立实时 SaaS 或团队级 WebSocket 广播服务。

消息输入、预览和确认是三份不同状态：draftVersion、previewSourceHash、confirmedBodyHash。发送时校验三者关系；内部备注与客户回复用不同 API，减少切换标签误发风险。

### 11.3A 已实现：只读消息中心（阶段 4A）

固定路径为 `GET /api/companies/:companyId/conversations`、`/:id` 和 `/:id/messages`，取代上表相应草案；没有读取时的外部平台调用或隐式标记已读。列表可选 storeId，searchField=thread/order 与 search 必须成对，未知或重复查询参数拒绝。精确订单查找仅匹配消息携带的 order_number，不代表确认消费者或订单归属。

每个最终查询 JOIN store，并在同一 SQL 复核已验证用户、有效 session、公司角色和成员店铺授权；companyFor 的预检不替代最终范围判断。owner/admin 可见公司店铺，member 需明确 grant。暂停和断开不删除历史，继续按当前访问授权读取。DTO 白名单不返回凭证、本地未读假状态或未实现的负责人字段。

列表按 `(last_message_at DESC, id DESC)`，空消息时间排最后；消息按 `(event_at DESC, id DESC)` 取页、按升序展示。默认 50 条、上限 100。游标包含版本、公司及查询/会话范围，并严格校验格式和范围；游标不是授权凭证。摘要仅首个片段最多 280 个 Unicode 字符，并标明是否截断。正文查询先在 D1 选择至多 limit+1 个候选，再按 JSON UTF-8 字节累计约 900 KiB 的页预算；首条完整消息始终返回，不截断正文，实际最旧记录决定下一游标。这是正文预算，不是包含元数据的 HTTP 响应硬上限。

0009 仅增三个索引：公司/最近消息时间/ID；公司/平台会话 ID/最近消息时间/ID；公司/订单号/会话 ID。订单查找先由同 SQL 的非相关子查询定位候选会话，再由外层重新鉴权。真实 D1 EXPLAIN 验证全店列表不额外排序，精确会话和订单使用相应索引；原消息不可变和店铺生命周期触发器保持。

前端复用官方 ShadCN Message、Bubble、Marker、MessageScroller；唯一新增依赖 `@shadcn/react@0.3.1`。消息只渲染纯文本，不解释 HTML、不请求图片原始 URL。1440 宽显示三栏，1366 宽将上下文收进 Sheet，手机在列表与正文之间切换；列表与消息独立滚动。详情关闭、移动返回支持焦点恢复。

阶段 4A 的可见页原按 10 秒重读；4D3 已用下述增量窗口替换消息正文读取，列表等查询继续原周期。查询键包含公司/会话/过滤/游标，停用页面缓存立即回收；401/404/403 清筛选与选中会话，再重建身份/缓存边界。公司切换、断网重连沿用全局身份重验。阶段 4A 时，历史补拉可能在已翻过的时间段插入记录；4D2 已让历史游标固定导入上界，并另提供追加读取接口（11.3D）。4D3 已接入单会话增量补齐；会话列表排序仍可能变化，旧成员重加的列表间歇失败尚未定因，因此 AC-025 仍不整项放行。本页原文记录不是冻结的审计日志。

参考：[官方消息组件](https://ui.shadcn.com/docs/components/base/message)、[消息滚动组件](https://ui.shadcn.com/docs/components/base/message-scroller)。本轮 Figma get_design_context 因 Starter 额度失败；沿用已保存 V4 基线，不能声称完成当前云端画板逐像素复核。


### 11.3B 阶段 4B6：队列筛选与同快照计数

会话列表增加 queue=all/mine/unassigned 和 state=all/needs_reply/waiting_customer/waiting_internal/resolved，默认全部，保留现有店铺和精确搜索。界面将 mine 称为“我负责”，因为它在全部状态下也包含已解决会话。列表独立附带 workflow 投影（version、lifecycle、workStatus、assignedMemberId、assigneeName），不修改详情或 DO 控制 DTO。姓名按同公司精确 memberId 关联，不表示当前接手资格；负责人移除或失权仍是已分配，不能改归未分配。

顶层 viewerMemberId、counts.all/mine/unassigned 与当前页来自同一 SQL 快照。计数受当前授权、店铺、搜索和 state 限制，忽略 queue/游标/页长；mine 按当次登录的真实成员 ID 比较，不按 userId、姓名或邮箱判断。无有效 viewer 返回 404，授权空页仍返回零计数和身份。没有目录只读映射 v0/open/needs_reply/未分配；旧 v1 仅按既有合同归一化，不写目录或升级 DO，未知格式不作为默认状态。

列表游标升级为 v2，绑定原范围、queue/state 和 viewerMemberId；旧游标或跨条件复用明确返回 400，由界面回到第一页。列表与计数属于 D1 投影，控制命令仍使用 DO 权威。成功操作后刷新列表，投影延迟期间保留已打开会话的最新权威状态；不能用旧列表回写详情、手工加减总数或突然关闭不再匹配的已打开会话。首次范围切换不得带上一范围的游标。当前 BrowserRouter 下，连续筛选基于同步更新的浏览器 URL，仅补丁本次改变的字段，避免导航尚未重新渲染时由旧闭包恢复已清除的条件；打开会话同样保留最新筛选。[React Router 说明](https://reactrouter.com/api/hooks/useSearchParams)明确 setSearchParams 的函数回调不提供 React setState 的排队语义。此切片不实现入站消息的自动状态变化、完整历史快照、翻译或真实发送。

### 11.3C 阶段 4D1：普通原文草稿恢复

普通原文草稿单独保存到 sessionStorage，范围为 userId/memberId/companyId/conversationId，键和值都核对范围与版本。每次编辑同步写入并回读确认，不等待 debounce 或卸载事件；最多 1000 个 UTF-16 代码单元，保留未完成输入及空白，是否能发送继续使用原发送校验。清空输入删除对应记录。读取失败或损坏时不展示存储正文；写入失败保留当前内存输入并提示，不宣称保存成功。

只有会话控制与回复读取确认了当前成员后，才展示对应草稿。切换会话、刷新和断网重验后恢复本范围；替换成员有不同命名空间。明确退出登录按当前用户清理，确认撤权按当前公司/会话范围清理；存储本身不可用时无法承诺物理清理成功，但页面仍受重新授权和范围校验约束。不读取其他用户或成员的旧草稿，也不改发送/翻译 journal。

未确认发送始终优先于普通编辑；已接受提交或查到原意图时，先移除普通草稿，再清发送 journal。第一步失败保留原命令及核对入口，不能让旧正文在刷新后变成可再次提交的新草稿。明确未接受的请求保留原文。正常恢复不加载旧翻译候选、不产生新请求；待核对翻译可按原编号读取，仍须明确绑定原文及人工确认。

本片只持久化原文，不保存俄语预览编辑稿或跨设备草稿，也不实现消息追加补齐。[sessionStorage 文档](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)说明其刷新保留、标签页边界与访问异常；带 opener 的窗口可能复制初始内容，不代表后续草稿同步，更不代表可以自动发送。

### 11.3D 阶段 4D2：固定历史导入上界与追加读取

迁移 0020 为 conversation 增加持久 `message_sequence`，并新增仅保存关联和序号的 message_append 表，不复制正文。按每会话 `received_at/event_at/id` 为已有消息确定初始顺序；这是迁移时的确定顺序，不追认真实平台发送顺序。此后消息插入触发器在原事务内推进计数并写关联。重复平台消息的 `ON CONFLICT DO NOTHING` 不推进序号，批次失败整体回滚，删除末条消息不回退计数。数字限于 JavaScript 安全整数，溢出使插入整体失败；禁止修改既有追加关联及单独删除仍有原消息的关联，允许父记录删除级联。

不使用默认 ROWID 作持久补读边界，因为删除最高行后可能重用；也不向客户端暴露跨公司共享的全局连续计数。每会话计数是本项目针对隔离范围的选择。[SQLite ROWID 规则](https://www.sqlite.org/autoinc.html)及 [D1 batch 事务说明](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)为约束依据，实际行为另由本地 D1 用例验证。

| 读取 | 请求与返回 | 顺序及边界 |
| --- | --- | --- |
| GET `/:id/messages` | 可选 cursor、limit；返回 messages、viewerMemberId、pageCursor、nextCursor、updatesCursor | 初次从同一 SQL 取得导入上界；只读 sequence 不超过该上界的消息，保留 event_at/id 排序。pageCursor 重读当前页；nextCursor 翻更早页。 |
| GET `/:id/message-updates` | 必须 cursor、可选 limit；返回 messages、viewerMemberId、nextCursor、hasMore | 按追加序号升序；初次轮询固定当前上界，后续页沿用本批上界，完成后下一轮再采集新上界。 |

两条路径都属于 `/api/companies/:companyId/conversations`。消息 DTO 增加 sequence。历史 v2 游标包括公司、会话、memberId、snapshot 和 before；追加 v1 游标包括相同身份范围、after 和可空 through。解析严格有界，不允许未知字段、负数、小数、不安全整数或未来上界。游标仍不是权限凭证：查询时复核验证邮箱、有效 session、公司角色和店铺 grant，再比对当前 memberId；撤权返回不可访问，重新加入成员不能继承旧游标。旧历史 v1 游标明确拒绝，不能静默重新解释。

默认 50、最大 100 条，正文沿用 900 KiB JSON UTF-8 预算，第一条完整保留。候选条数先限为 limit+1；EXPLAIN 检查历史使用原时间索引，追加使用 conversation_id/sequence 索引。授权空页仍有有效边界，无权限不返回边界。删除造成的序号空隙可推进；本批未完按最后实际返回记录推进，已完推进到本批上界，因此不会因连续新导入无限追赶同一批次。接口均为只读，不调用平台、模型、发送管道或标记已读。

客户端沿用 Valibot 和原 HTTP 工具，核对公司/会话、成员字段、页长、序号范围、ID/序号去重、追加严格递增和续页前进；取消信号仍通过原请求超时组合传播，网络失败不在 API 函数中隐式重试。原有列表与详情响应不增加计数器。

这里固定的是**插入上界**，不是保留完整历史的审计快照：物理删除会移除记录，辅助字段仍按当前存储读取，也没有删除事件或消费者已读语义。新迁移必须先于新版 Worker；客户端与服务端按同一版本发布，旧游标需要重新进入第一页。这是 4D2 的服务端基线；4D3 在下一节接入有界窗口、积压补齐、断线恢复与阅读位置，并替换历史游标格式。后端用例本身不能放行完整 AC-025 或云端验收。

### 11.3E 阶段 4D3：有界消息窗口、双向历史与阅读恢复

本节取代 11.3D 的历史 v2 格式，追加游标仍为 v1、会话列表游标不变。历史 v3 绑定公司、会话、当前 memberId、snapshot 和可空 edge `{at,id,direction:older/newer,inclusive}`。默认最新页倒序取样后正序展示；较新方向升序取样。`nextCursor` 仍表示更早页，新增 `newerCursor` 表示更晚页，`pageCursor` 精确重读该页。请求可增加成对的 anchorId + direction（older/newer/from），且必须同时提供历史 cursor；from 包含锚点。服务端先在授权范围和 snapshot 内读取锚点，最终页 SQL 再核验当前权限，不把第一次授权作为后续读取凭证。

相反方向是否还有记录通过当前范围的索引 EXISTS 判断；候选条数、900 KiB JSON 正文字节预算与首条完整保留规则不变。不存在、其他范围或超出 snapshot 的锚点返回 404；无效组合和旧 v1/v2 游标返回 400。追加响应增加 `historyCursor`，其 snapshot 是本次实际交付的 after：未完取最后返回序号，已完取 through。客户端不用拼装服务端游标；在裁剪窗口后仍能从最早保留消息向前继续，不依赖无界历史页栈。

初次窗口 50 条；已应用的追加记录按 eventAt/id 排序合入，最多 100 条、累计正文约 1800 KiB，至少保留一条完整消息。裁剪只从最早端进行，旧记录仍可分页读取。事件时间早于窗口起点的回填保留最早定位和“查看较早更新”入口，打开其上下文并双向翻页；不把不连续片段混进最新窗口。该提示不是未读、待办或未处理数量。当前翻阅历史或离开末尾时，仅保留一页待显示响应，并继续从未推进的边界检查；点击“显示新消息”或回到末尾后应用。页面固定一个增量查询键，每个响应携带发起时的 cursor，只有当前范围、成员和游标匹配才应用，迟到响应不写入别的会话。每批最多 50 条，后台标签停止周期查询，没有不受控的连续请求循环。

阅读元数据使用独立 `dingbell:conversation-position:v1:` sessionStorage，key 和 value 同时绑定 userId/memberId/companyId/conversationId。只保存 live historyCursor、可空历史页 cursor、可见消息锚点与较早更新定位，不保存消费者正文。恢复先读取服务端确认当前成员，再读该成员元数据；从保存的历史边界重新取得 updatesCursor，不单独持久化两个可能不一致的水位。历史页和锚点再经授权读取，普通草稿仍由独立机制处理。旧/失效游标须再次发起授权读取，不能回退到之前缓存的正文。当前成员替换导致游标失效时允许一次自动重新确认；持续无效保留错误，避免重置请求循环。

位置变化及交付应用后同步保存并回读。损坏、拒绝存储和配额失败显示恢复限制，当前内存仍可继续查看；读取失败保留边界并隐藏不可确认正文，成功后续读。明确退出或确认撤权按范围清理位置，不混用原文草稿、翻译或发送 journal。存储写入/清理被浏览器拒绝时，不能保证物理恢复或删除；服务器授权和成员隔离仍是边界。

滚动继续用官方 [MessageScroller](https://ui.shadcn.com/docs/components/base/message-scroller) 的自动跟随、可见消息与 scrollToMessage hooks，无自建滚动容器或 ResizeObserver。恢复保证定位到保存的消息，不承诺长消息内部精确像素、跨设备、关闭标签页后恢复或同步不同标签页。普通“刷新消息”在已交付上界重读规范窗口，再续读，不直接跳过积压。物理删除不是追加事件，显式重读才移除缓存中已删除项；这仍不是审计快照。新导入消息尚不自动改变会话处理状态，也不触发 AI 或平台发送。

### 11.3F 阶段 4D4：身份重验与消息中心操作可达性

列表成员变更有两条恢复路径。周期读取仍携带旧成员游标时，400 响应提供“返回第一页会话”；页面重新成为可见而先触发全局身份重验时，工作区卸载后重新挂载，直接从新成员的第一页读取。两条路径都必须显示当前授权店铺及对应队列计数，新成员不能继承旧负责人身份。验收检查最终授权范围，同时分别验证这些确定的请求顺序，不强制所有路径都显示中间错误按钮。

处理栏对长姓名使用有宽度边界的按钮，通过官方 ShadCN Popover 展示完整姓名，支持点击、键盘打开及关闭后返回原按钮；内部备注和进度操作共用可换行的一行，保留消息正文空间。[Base UI 的提示使用说明](https://base-ui.com/react/components/tooltip#alternatives-to-tooltips)区分了辅助视觉标签和以打开内容为目的的弹层，姓名详情采用后者。工作区由 SidebarInset 提供唯一 main 地标。发送预览关闭时优先返回仍连接且可用的原触发按钮；后台读取暂时禁用该按钮时，返回可编辑的原文输入框，输入框不可用则返回最近发送入口。

### 11.3G 阶段 4D5：公司时区与设置确认

`GET /api/companies/:companyId/settings` 对当前已验证的公司成员开放，返回 `companyId/timeZone/version/updatedAt/canManage`。没有配置行时明确返回 UTC、版本 0、空更新时间；读取不创建行，不依据设备、店铺国家或账号所在地猜测时区。`POST` 仅接受 `timeZone/expectedVersion`，只有当前所有者、管理员能写。首次保存为版本 1，后续按版本比较更新；过期版本返回 `SETTINGS_CHANGED/409`，安全整数上限不允许再递增。最终 SQL 重新核验公司、角色、会话有效期和邮箱验证，首次插入和更新都不依赖先前的授权检查。

迁移 `0021_company_timezone.sql` 新增公司设置及独立设置审计表，不改已有消息。审计沿用 started → succeeded/rejected/unknown 合同，记录操作者、请求编号、前后版本和请求时区；意图写入失败不执行变更。结果审计失败、确认读取失败或写后撤权返回 `OPERATION_UNCONFIRMED/503`，不自动重放。写入成功但读取已无权时不能记成 rejected。设置行随公司删除，审计保留历史标识；正式留存清理仍在后续阶段。

使用运行时的 [ECMA-402 IANA 时区支持](https://tc39.es/ecma402/) 校验并规范化命名时区，拒绝 `+08:00`、`UTC+8` 和未知名称；不维护手写偏移表，不增加日期依赖。原始时刻继续使用 UTC 存储，显示用 `Intl.DateTimeFormat` 的明确时区与 `shortOffset`，让夏令时回拨时的两个相同本地时刻仍可区分。此片实现时间展示，不实现静默时段、统计跨日边界或定时任务，不能据此放行这些后续验收项。

公司工作区共享按账号和公司隔离的设置查询，每 60 秒及前台重验时读取。消息列表、正文、会话上下文、内部备注、最近发送、店铺检查/同步与团队邀请时间使用同一格式化入口；消息元素的 `datetime` 仍保留原始时刻。初次读取中明确显示 UTC 临时口径，读取失败显示失败状态与当前展示时区；有已确认缓存时保留该时区，无缓存时临时使用 UTC。设置页能显式重读，未经确认不开放保存；授权失效触发既有身份重验。

表单保留未保存选择及起始版本，冲突或结果不确定时阻止再次保存。用户先读取最新值，再明确选择“基于最新版本继续编辑”；如果已保存值等于当前选择，不再产生一次相同写入。保存成功后先取消保存期间启动的后台读取，再更新缓存，避免旧读取响应覆盖已确认的新版本。其他在线页面在下一次成功读取后应用新设置，不承诺跨标签页即时推送。设置页面沿用本地 ShadCN 组件；本片 Figma context 与截图请求均因工具额度限制失败，没有完成该页与 Figma 的逐项视觉比对。

解决、转交及内部备注弹窗关闭时，优先返回仍连接且未禁用的入口；入口被后台读取禁用时交由 Base UI 返回处理栏的可聚焦目标，并显示焦点样式。Base UI 会优先选择返回容器内第一个可 Tab 的元素，测试验证焦点位于处理栏且可见，不强制落在外层容器本身。

### 11.3H 阶段 4D6：消息来源约束下的商品与订单上下文

`GET /api/companies/:companyId/conversations/:id/messages/:messageId/context` 只接受可选 `afterPosting`。订单号、SKU 必须从当前有权读取的持久化消息元数据取得，不接受查询参数替换，不解析正文、买家姓名、发送者名称或订单号前缀。每个关联读均约束同一公司与店铺；首尾查询复核当前邮箱验证、未过期会话、成员角色和店铺授权，成员被替换、消息被删除或权限消失时丢弃中间读到的数据。响应绑定公司、会话、店铺、当前成员与来源消息，客户端按同样范围验证及隔离缓存。

商品按准确 SKU 匹配列表、详情主 SKU 及详情 sources 别名。迁移 `0022_message_context.sql` 新增 `product_sku` 投影及订单号索引，既有快照先回填，后续插入/修改由触发器与商品写入原子维护，产品删除级联清理。索引按公司、店铺、SKU 定位，不逐次扫描店铺商品 JSON。相同 SKU 对应多个商品时返回 ambiguous，不任取第一条。列表与详情采集时间分别保留；价格是字符串，展示为采集价格，未变成现价承诺或已发布知识。

FBS 订单号必须完整相等，不把 posting 编号截取后猜成订单号。一个订单号映射多个 orderId 时整组返回 ambiguous。唯一 orderId 下的拆包按 posting 编号分页，每页最多 10 条，读取第 11 条决定下一页；afterPosting 只能收窄当前来源订单，不改变关联范围。歧义判断与包裹页在同一个 D1 batch 事务中读取。分页是当前导入数据的实时视图，不声称固定历史快照；刷新、删除或同步后可能发生页变化。

包裹列表和详情采用采集时间较新的完整记录（相同时选详情），不把旧详情状态混到新列表里。返回平台原始状态、运单号、商品记录数及来源/采集时间；没有物流实时请求、订单操作或状态阶段推断。没有数据时区分消息未携带字段、尚未导入匹配记录、来源冲突。非 FBS 没有被误报为已覆盖，查不到记录也不表述为消费者没有订单。接口仅返回白名单字段，不暴露订单原始 JSON、地址、电话或密钥。

消息页沿用 ShadCN 侧栏/抽屉与原生选择组件。当前已显示消息按订单号和 SKU 去重，用户选择按这两个字段保留；新消息替换来源 ID 不把选择跳到另一笔订单。旧响应只进入它原有的查询范围，来源或页码切换不保留上一条详情；读取失败隐藏旧内容并提供重读，撤权接入既有工作区清理。用户发起的包裹翻页完成后，仅在焦点因加载态丢失时恢复到可用分页按钮（失败时为重读入口），不抢走已经移到别处的焦点。宽度至少 1440 时显示侧栏，窄屏仅打开抽屉才读取上下文。时间使用公司设置。本页只读，不触发同步、模型、发送、退款或知识发布。

这是平台消息元数据到已导入商家数据的可追溯引用，并不是消费者身份或订单所有权的独立证明。当前使用合成数据验证映射、权限和界面；Ozon 官方文档页本轮未能读取，未据第三方文档提升能力结论。真实店铺聊天 context 字段与订单的实际含义、多个履约方式、完整的消费者档案和售后操作仍受能力验收约束，不据此放行 AC-024 整项或阶段 4。

### 11.3I 阶段 5A：回复策略配置与不可变发布版本

`/api/companies/:companyId/reply-policies` 提供按 `automatic` / `notification` 分类的列表及新建草稿；`/:id` 返回当前草稿、生效快照和最近 10 个版本；`/:id/versions?before=` 读取较早版本。列表按 ID 续页，每页最多 20 条。写入口为 `draft`、`test`、`publish`、`pause`、`restore`，均要求当前 `expectedVersion`。本片默认只有所有者和管理员可读写配置；普通成员没有配置权限，尚未提供可选的草稿编辑授权。每个接口和最终写入均检查当前公司成员、角色、邮箱验证及未过期会话。

迁移 `0023_reply_policies.sql` 新增 `reply_policy`、`policy_version` 与独立审计表。`version` 是所有修改共享的 CAS 版本，`draft_revision` 只在保存或恢复草稿时递增，`tested_revision` 绑定已检查的草稿。草稿保存不改变 `enabled` 或已发布版本。发布通过单条 UPDATE 与触发器原子写入不可变快照；快照插入失败会回滚本次发布。UPDATE、DELETE 和 INSERT OR REPLACE 均不能覆盖仍属于有效策略的历史快照。不要在重建迁移时丢弃这些触发器。

自动回复包含显式店铺集合、售前/售中/售后范围、优先级、建议/自动模式、语言、语气和补充说明。主动通知独立保存事件、延迟、有效期、每日次数、免打扰窗口与正文，不新增话术模板模块。字段使用严格的有限 schema，正文变量只允许 `store_name`、`order_number`、`tracking_number`，不接受脚本或未知配置字段。补充说明不改变工具授权、退款权限或知识事实。

规则检查仅检查字段、店铺归属和已生效自动回复策略的同优先级范围重叠，不调用模型或消息接口。检查记录同时冻结公司 IANA 时区；发布时再次检查草稿、时区、店铺和重叠约束。检查后的时区变化要求重新检查，避免免打扰语义悄悄改变。不同优先级允许共存；实际选择最高优先级、执行时能力校验和消息抑制仍需阶段 6 接线验证。

已发布版本记录配置、schema 版本、发布人、时间、时区、原请求与恢复来源。暂停只关闭该逻辑策略，保留历史内容。恢复历史版本会形成待检查的新草稿，再发布才产生新发布版本，不改写旧版本。每次写操作沿用 started / succeeded / rejected / unknown 审计协议；审计前置失败不写业务数据，结果审计或网络回执丢失要求只读核对，客户端不自动重试。

页面使用现有 ShadCN Nova / Base UI 风格及官方 Tabs、Checkbox。两个页签保持独立，显示草稿与生效内容、发布确认、恢复来源和版本分页；并发或未确认结果保留本地修改并要求读取最新配置后显式继续。无效本地草稿不能阻止暂停已生效策略。公司切换或权限丢失会清理编辑器与公司缓存。配置页明确显示“自动执行尚未启用”。

本片没有接入知识发布、Vectorize、AI 回答质量评估、自动回复生成、订单触发、延迟调度或最终发送校验。发布只确立配置版本，不能据此宣称 AC-039、AC-049–053 或阶段 5/6 整项完成。迁移必须先于新增入口部署；旧 Worker 可忽略新增表，但回退 Worker 不应删除版本和审计数据。

## 12. 会话日志、分析和导出

### 12.1 过滤与统计

常用筛选：日期范围、公司内店铺、会话状态、负责人、接待方式、售前/售中/售后、客户/订单关键词。

更多筛选：渠道类型、客户语言、创建/最近活动/发送时间维度、是否转人工及原因、AI 运行结果、发送结果、策略 ID/版本、知识缺口、标签、超时等待、人工操作人。

消息明细与会话汇总的筛选字段分开展示，避免将消息发送时间误称为会话创建时间。多条件 AND，单字段多选 OR；包含/排除、空值以及时间端点在 API Schema 定义。

| 指标 | 首版定义 |
| --- | --- |
| 今日新增会话 | 公司时区当天创建的独立会话 |
| 今日已解决 | 当天发生解决事件的去重会话，同时可查看解决事件次数 |
| 当前待回复 | 当前 work_state=needs_reply 且未归档的可见会话 |
| 首次响应 | 首条客户入站至首条真实确认外发；内部备注、AI 草稿不算 |
| 转人工比例 | 选定 AI 接待会话中发生转人工的去重比例，分母为 0 显示无数据 |
| AI 解决代理指标 | 由 AI 接待并被标记解决且观察窗口内未重开的比例 | 
| 发送失败率 | 明确 failed / 已有明确结果的发送；unknown 单列 |

“AI 解决代理指标”不宣称等同于消费者满意度。没有真实评价/满意度采集时不展示伪造的满意度数字。

### 12.2 全文搜索

使用派生 SEARCH_DB 保存消息 ID、公司、店铺、原文/译文文本与 FTS5 索引；查到候选后在主库重新校验权限、有效性和当前范围。

采用原文/译文匹配并显示命中类型；外部 ID 和订单号走精确/前缀索引。三字符及以上正文子串优先验证 trigram 索引；两字符中文关键词使用限定店铺和短时间窗口查询，性能及 UI 提示在阶段 4 验证。首版不承诺语义搜索整个客户历史。

主库不放 FTS 虚拟表。官方 D1 导出对虚拟表存在限制；独立搜索库可直接重建，不需为了备份删除生产主库索引。[D1 导入导出限制](https://developers.cloudflare.com/d1/best-practices/import-export-data/)

### 12.3 CSV 数据一致性

1. 创建任务时冻结筛选条件、排序、导出字段、范围模式及当前已选 ID；服务器解析并记录授权店铺范围。
2. 执行任务前重新校验权限；若已失去部分原范围，任务失败并说明原因，不悄悄导出另一份范围。
3. 任务开始生成时，在主库内原子创建临时 export_row 快照，记录 snapshot_at。对“全部结果”按该时刻筛选；消息明细包含当时确认的状态。
4. 建议首版单任务上限 100,000 行。快照数量超过上限则明确失败并要求缩小范围，不静默截断；插入快照语句需通过 D1 单查询限制的实测。
5. 后续分批读取不变快照生成 CSV 并写 R2；这避免分页期间状态变化造成漏行、重复和筛选漂移。
6. 若大快照性能达不到验收，先降低公开上限或重新设计版本快照，不用普通分页冒充一致导出。
7. 生成完成、取消、失败和过期后清理临时快照；每公司默认同时 1 个导出，总并发按部署配置限制。

建议会话汇总字段：公司/店铺、会话 ID、渠道、消费者平台引用、阶段、负责人、状态、创建/解决时间、AI/人工回复数、转人工原因、未知发送数。

建议消息明细字段：会话 ID、消息 ID、方向、发送者类型、原文、语言、译文、发生/接收/发送时间、发送状态、策略版本、引用文档版本。内部备注默认不导出，需有独立权限和显式选择。

UTF-8、可选 BOM、规范引号/换行转义、明确时区；用户文本以等号、加号、减号、@ 或危险控制字符开头时按文本安全格式输出。记录导出人、过滤条件哈希、行数、文件哈希和过期时间。

下载默认经过应用鉴权，不公开 R2 bucket；失去权限的用户不能用旧链接继续下载。文件下载与业务审计不是同一张“发送记录”。

## 13. 异步作业与调度

队列事件仅含 schemaVersion、jobId、kind、scope、payloadRef、traceId，正文/密钥不放进队列。先写 job，再发送唤醒消息；处理端确认 job 的权威状态。

| 作业 | 分片方式 | 恢复依据 | 取消条件 |
| --- | --- | --- | --- |
| 平台同步 | 店铺、接口桶、页游标 | 游标和已提交事件键 | 凭证撤销、店铺暂停 |
| 知识导入 | 文档修订版、批次 | 分块哈希及嵌入版本 | 草稿删除、版本废弃 |
| AI 提交 | 会话、触发计划 | 冻结载荷、原生 idempotencyKey 与 receipt | 接管、策略关闭、预算不足 |
| 主动通知 | 包裹、规则、状态事件 | 固定策略版本和到期时间 | 状态变化、规则停用、过期 |
| CSV | export_job、快照行游标 | 不变导出快照 | 权限失效、用户取消、过期 |
| 投影/核对 | 会话与 sequence | 控制对象领域日志 | 完成核对后确认 |
| 清理与备份 | 资源类型和分页游标 | 处理清单、检查点 | 运维暂停 |

Cron 只扫描 due_at 和过期租约并提交任务，不在一个 Cron 调用内遍历所有历史数据。Queue 自带重试不保证顺序，也可能重复；同会话有序性由控制对象保证。[队列投递语义](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)

队列中的 AI 作业只负责可靠提交与业务核对，不承担模型运行循环。Flue 的执行、恢复和中止由原生协调器完成；仅涉及单 Agent 的延时输入可使用公开扩展的 SDK 调度能力。

超过队列延迟上限的等待放在 D1 due_at 中，由 Cron 唤醒；不将队列当永久定时数据库。死信任务可查看原因与重试，但未知外发结果仍必须先核对。

长作业主动拆批并检查截止时间。Cloudflare 对队列、Cron、DO alarm 等有执行限制；Flue 原生耐久性也不能替代应用的运行预算。[平台限制](https://developers.cloudflare.com/queues/platform/limits/)

## 14. 凭证、文件与模型数据边界

当前检查使用 20 秒数据库租约、30 秒店铺检查冷却、8 秒供应商总超时、每响应最多 64 KiB；仅允许固定 Ozon 主机及四个只读路径，无重定向和自动重试。先验证 `/v1/roles`，再分别读取 `/v3/product/list`、`/v3/chat/list`、`/v4/posting/fbs/list` 的小样本。网络错误、429、5xx 或格式异常保持 unknown，不推断为永久不支持；回复/主动建聊保持 unknown。结果有效期 24 小时。最终写入再次校验公司、店铺、当前操作者角色/验证邮箱/有效 session、店铺与凭证版本、检查 token 和未过期租约；迟到结果不能覆盖暂停、凭证替换或撤权后的状态。这不是同步租约、全店 API 调度器或发送任务的实现。

凭证保存已使用 AES-256-GCM、随机 12 字节 nonce 和认证关联数据，绑定公司、店铺、平台账号、平台凭证版本及加密密钥版本。部署配置 `STORE_CREDENTIAL_KEYS` 是版本到 32 字节 Base64 主密钥的 JSON 映射；`STORE_CREDENTIAL_ACTIVE_KEY` 指定新写入版本。两者不依赖身份密钥。客户端 DTO 只含“是否有凭证”和凭证修订号，不含密文信封、nonce 或主密钥版本。旧版本解密与新写入使用当前版本已在本地验证；下述渐进重加密、云端密钥轮换和备份恢复仍待实施，不能直接删除旧密钥。

- 平台和模型密钥只在服务端使用。每店铺凭证用 Web Crypto 的认证加密，nonce 不复用，关联数据包含公司/店铺，保存 key_version；主密钥在 Workers Secrets。
- 轮换采用新写入用新密钥、旧数据渐进重加密、核对后移除旧密钥。备份恢复必须同时具备合法密钥，不能只备份密文数据库。
- 平台错误体、任务负载、监控事件都做秘密字段和个人信息过滤；日志默认不记录完整消息正文。
- 上传限制扩展名、真实 MIME、大小及压缩比；知识文件按允许类型解析；附件未通过验证不能进入可下载状态。
- 平台附件 URL 只允许受支持来源；抓取有超时、重定向、尺寸和网络地址限制，防止 SSRF。
- Markdown/富文本渲染使用安全白名单；不执行来自消费者、知识文件或模型的 HTML/脚本。
- 模型只接收完成当前任务所需的信息；支付、凭证和无关客户资料不进入上下文。
- 平台运营读取客户内容需专门的授权流程和审计，不因其拥有商家后台账号而自动获得所有租户数据。

## 15. 开源模式、计费与用量

deployment_mode 是部署级设置：self_hosted 或 hosted。它控制注册策略、计费入口和运营配置，不改变业务数据的公司隔离。

自部署可配置自己的模型和邮件服务，默认关闭向 DingBell 运营方发送的遥测。不依赖商业账号、远程许可证检查或未公开的核心服务。

技术台账记录模型调用、tokens、嵌入、翻译、重试和估算成本；业务台账按最终确认外发的 AI intent 计量。主动通知单列，人工消息不算 AI 回复；模型调用失败但已消耗的成本仍保留在技术台账。

运行时 observe 是实时观测，不能作为唯一持久账本；漏收或重放时从持久运行结果及业务意图核对。useResponseFinish 可同步附加聚合用量元数据，异步写账由业务流程完成。技术用量只选叶子 turn 或一个汇总层累计，共享 response 去重；未知模型价格不按零成本放行预算，无法核定的费用明确保留待核对。[Observability](https://flueframework.com/docs/guide/observability/)、[Events](https://flueframework.com/docs/reference/events/)

配额需要在开始运行前预留，结算后释放多余预留；超时预留由核对作业处理，不能既放回额度又允许同一旧运行继续新增成本。供应商不能提前精确计价时按单次上限预留并记录差额。

同公司并发预留使用 D1 原子条件更新及唯一 run_id，余额不足则不启动新调用；预算计数与预留记录在同一本地事务内更新。预留成功但 Flue 启动结果不明时保留预留并核对，不立即返还。预算告警以估算成本为依据，最终费用与供应商账单核对，不能把本地估算宣传为供应商硬性停费保证。

阶段 4C3A 先落地翻译专用的预算桶和预览运行记录，尚不接公共接口或真实模型。预算桶默认关闭；每个运行冻结公司/店铺/会话、原用户与成员、原文及版本、模型/提示词/价格版本和原预算桶。原请求重放使用已有快照，不套用新部署的默认配置。运行只保存预算的 held、settled、released 状态及原生 Flue 回执关联，不复制框架的执行队列或尝试状态。

同公司预算窗口不能重叠，包括未启用的窗口；相邻窗口允许。窗口、上限及归属创建后不变，启停使用版本比较。预算与运行使用 RESTRICT 外键，不能通过删除会话、店铺或公司级联丢失财务记录；未来删除功能须先明确归档和保留流程。只有后台内部函数可绑定回执与结算；它们没有直接暴露为 HTTP 接口。

费用使用整数微美元；输入、输出、缓存读取、缓存写入四类单价必须显式提供，缺失不等于免费。预留以输入三类叶 token 的总预算乘最高单价，加输出预算；实际结算按四类真实用量计算，不因超过预留而裁剪。BigInt 中间运算后统一向上取整，超出安全整数范围时拒绝写入。输入预算是估算包络，不是 Flue 或 Provider 的 maxInputTokens 参数；实际模型上下文与持久请求许可仍需在 4C3B 接入时验证。

预算和运行写入复用 [D1 batch 的事务语义](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)，授权、余额条件、运行唯一约束与计数更新在同一个事务完成。超时或缺少回执不能释放预留。内部释放接口只接受“执行已关闭且无供应商请求”的证据结构；如何从真实 Provider 持久记录取得这份证据，属于下一片的接线验证。当前存储接口的类型检查不能代替真实运行证明。

阶段 4C3B1 接入独立 ReplyPreview Agent，固定 agentName 与 `reply-preview:<runId>` 实例名，追加 DO v3 迁移；公司、店铺、会话及冻结运行必须与实际 DO 身份一致。业务 HTTP 和翻译编辑界面尚未接线，原生 Agent Router 保持关闭，部署未显式启用翻译时不得调用模型。本片原生验收使用固定原文、initialData 与幂等键；后续业务接线须只保存回执的 submissionId、uid、acceptedAt 三个字段，读取前核对当前实例 uid。

本地 DO 账本分别限制生成与 HTTP 许可；实际 HTTP 还必须赢得 0017 新增的 D1 单次领取。最终 SQL 重新检查原成员、店铺权限、预算启用和余额，不依赖旧浏览器会话。已预留运行不重复扣款，旧预算窗口过期后仍归原桶；其他运行超额结算使桶超限时，尚未领取的请求停止。领取标记不能清空；响应丢失、对象删除或重新创建都不能凭标记重新取得许可。这里保证每个运行最多一次供应商 HTTP，不保证对象被物理删除后 SDK 入口绝不再次进入。请求开始前关闭 DO 账本且 D1 尚未领取，才可原子释放；不确定是否已经联网时保留预留。

官方 NVIDIA Provider 负责模型协议，薄包装固定端点、模型及输出上限，使用公开 payload/fetch 钩子。锁定的 Flue 2.2.2 即使没有声明业务工具，也会加入 task 工具；翻译请求只移除这一已知声明，其他工具拒绝。供应商返回工具调用时，先保留原始证据，再拒绝把流交给 SDK，避免框架执行工具。SSE 使用现有 eventsource-parser，响应最多 1 MiB、调用限时 45 秒、重定向不跟随；持久许可保证 SDK 和框架内部重试不能再次联网。

`useResponseFinish` 只同步提供元数据；四类用量及总量须与实际 SSE 报告一致。输出有效性另查完整流、stop 终止、无工具和回复正文限制。缺失用量或 SDK 默认零值不能按免费结算；有可信用量但译文为空、过长或截断，仍保留费用。工具流在 SDK 前拒绝时没有成功结果元数据，原始用量保留在账本，暂待业务核对。固定模型配置使用完整模型上下文作为保守输入预算包络、输出最多 512 tokens；这不是每次实际消耗，也不是供应商价格或免费额度承诺。面向用户的授权提交、结果核对、结算和确认版本仍属于 4C3B2 及后续 UI 工作。

阶段 4C3B2 增加公开业务编排，原生 Agent HTTP 路由继续关闭。POST 严格接收 requestId、source、sourceRevision；POST/GET 都要求规范 URI 编码的 X-DingBell-Member-Id。店铺从当前授权会话推导，配置读取 TRANSLATION_CONFIG_JSON，预算从当前公司唯一启用且有效的窗口选择，客户端不可指定。TRANSLATION_ENABLED 默认关闭；新请求还需要生成的 Flue binding、模型密钥和显式四类价格。现有请求先按原用户/成员和精确原文/版本恢复，不重新套用当前配置或预算。

原生派发固定 uid:null、原文、initialData.runId 和原 runId 幂等键；只存 submissionId、uid、acceptedAt 三项回执。已有回执读取前后都核对当前实例 uid，read 另核对结果 submissionId，并用 500 ms 超时返回 pending。GET 不 reserve、prepare、dispatch 或 close，但可以根据可信用量幂等结算。无回执时 GET 只报告待核对；显式重复原 POST 才尝试恢复原始提交。已领取 D1 许可但原生实例丢失时不得新建执行。

正文返回前重新执行 SQL 授权并匹配原成员，移除后重新加入不能读取旧预览。费用按原冻结价格和预算记账，原预算关闭或窗口过期不撤销已发生的成本。仅确认原生执行失败且实际绑定账本零 HTTP 时，POST 才可关闭执行并释放预留；超时和临时读取错误保持 held。部署缺少定价或预算时拒绝新请求，不隐式使用免费价格。此处尚无预算管理界面或无人读取时的核对任务；前端译文确认及发送命令的预览来源关联仍是独立后续工作。

商业订阅关联 organization，不关联某个客服个人。支付回调验签、按事件 ID 去重；遇到乱序事件向支付平台读取当前对象，避免旧事件恢复已取消的订阅。价格 ID 来自服务端套餐配置。

支付平台是候选集成，不把付款成功回跳页面当作订阅生效证据。正式收费、税务与币种要求由实际经营条件决定；开源版可先独立交付。

## 16. 部署、升级与恢复

### 16.1 一键部署流程

1. 用户点击部署入口，克隆仓库到自己账号并授权 Cloudflare 构建。
2. 提示云资源和必需 Secret：安装令牌、身份 Secret、凭证加密密钥；模型/邮件可在初始化向导补齐。
3. 构建 Flue 与 Vite 产物，使用生成的配置部署应用，创建应用资源与 DO 迁移。
4. 执行已提交的 D1/搜索库迁移和索引配置，不在生产临时生成迁移。
5. 初始化健康检查确认 schema、绑定、存储和队列；错误有资源级诊断。
6. 部署者认领所有者，创建公司，配置模型/邮件，连接店铺并完成能力检查。
7. 默认外发自动化关闭，按试点档位启用。

部署脚本必须使用绑定名定位数据库，不复制作者账号 ID。提交手写 Wrangler/Vite 配置、应用资源和迁移历史；构建产物不当作源配置编辑。新建 Agent 追加 DO 迁移并固定 agentName；当前源码要求 compatibility_date 不早于 2026-04-01，依赖版本同时锁定。[固定版本配置实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/vite/src/cloudflare-worker-config.ts)

预览部署使用独立 D1/DO/Queues/R2，默认假连接器和关闭外发。业务数据库迁移与部署顺序在已有数据升级场景验证，不能只测试空库创建。

### 16.2 版本兼容与回滚

- 迁移优先 expand/contract：先加兼容字段，部署可兼容旧数据的代码，再迁移数据，最后在独立版本移除旧字段。
- 策略与队列负载带 schema_version；未知版本进入可见失败，不按默认值误执行。
- Flue Agent 的稳定身份需要固定；重命名按官方 DO 迁移处理，不能通过改函数名悄悄创建空会话。
- 应用回滚不自动回滚 D1/DO 数据；只有兼容旧 schema 的版本可直接回滚。
- Flue 运行时单独验证存储格式：当前为 format_version 1；SQL 实现允许同构 schema_version 8 重标记，其他不兼容版本会拒绝打开。禁止自动清库升级；没有安全迁移时先备份并评审新的运行世代重建方案。[格式实现](https://github.com/withastro/flue/blob/658325942b0f4eecd888f9698ab0bebb3b749163/packages/runtime/src/format-version.ts)
- 出现外发错误先启用独立于业务数据库恢复的部署总暂停开关，再排障。恢复发送需完成未知结果核对。

### 16.3 备份与恢复合同

| 数据 | 备份/重建方式 | 必须验证 |
| --- | --- | --- |
| D1 主库 | Time Travel 加定期加密逻辑导出 | 恢复点、导出影响及完整性校验 |
| 控制 DO | 公共业务方法导出状态、领域事件与发送账本 | 版本化格式；核对 D1 的对象目录与检查点 |
| Flue DO | 优先官方支持的导出/恢复能力；阶段 1 确认 | 不靠私有表恢复；无法恢复运行时则用业务历史重建新的运行世代 |
| R2 原文件 | 清单、哈希、保留与独立备份策略 | 原文件与数据库引用一致 |
| Vectorize/搜索库 | 从有效知识版本和业务消息重建 | 维度、模型和版本匹配，权限过滤不丢失 |
| 密钥与部署配置 | 受控离线备份/组织密钥管理 | 密钥可恢复、能轮换，访问记录可审计 |

D1 Time Travel 不是整个系统的共同恢复点。恢复时先停所有对外发送，恢复数据和对象检查点，再对账平台实际消息、重建投影和索引，最后恢复任务。外部副作用不能通过回滚数据库撤销。[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)

若 Flue 运行时不能原样恢复，新 Agent 运行世代只使用确认的业务历史，旧工具调用和未知发送不得自动重放。此能力必须在阶段 1 和阶段 9 有演练结果，不能以“框架有持久化”替代恢复验收。

### 16.4 留存与删除建议

初始建议：消息/订单业务副本 90 天、审计 180 天、脱敏原始回调 7 天、AI 原始执行轨迹 7 天、导出文件 24 小时。实际期限及备份保留在 D-06 确认；长期去重记录可保留无正文的最小标识，且不越过已确定的隐私边界。

删除任务按 D1、控制 DO、Flue DO、R2、向量、搜索、导出和备份生命周期逐项记录。先停用访问及外发，再清理可重入资源，最后产生不含客户正文的完成凭据。Flue 清理接口属于首阶段必验项，未验证不得承诺完整删除。

## 17. 监控、容量和 Vercel 后续适配

关键监控：同步延迟、游标停滞、队列最老任务、重复输入比例、发送 unknown、发送失败、AI 转人工、模型成本、D1 rows_read、DO 存储、R2 失败、导出耗时、成员授权失败及部署版本。

优先复用原生 Cloudflare tracing，并明确 content: false；AI Gateway 日志和工具自己的日志另做关闭内容或脱敏配置。原生及外部追踪的默认采集不同，不能只看是否安装 Sentry 判断内容是否外流。生产观测保留错误类型、耗时、用量和关联 ID；原始客户内容不作为默认标签。[内容边界](https://flueframework.com/docs/guide/observability/#protect-sensitive-content)

建议告警：凭证失效立即提示店铺管理员；unknown 立即进入人工核对队列；同步超过 2 个配置周期提示；队列持续积压/死信增长告警；D1 存储达到部署阈值提前处理。告警去重并保留恢复通知，避免每个重试产生一条提醒。

健康接口区分进程可响应与依赖已准备好；模型或 Ozon 暂不可用不必导致登录和人工查看历史都不可用。

Vercel 后续适配需要单独验证：Flue Node 的单会话唯一运行实例、函数生命周期、持久调度、任务恢复和流式观察。共享 PostgreSQL 并不自动满足 Flue 的运行归属条件。[Flue Node](https://flueframework.com/docs/guide/node-target/)

生态中的 Vercel Sandbox 是 Agent 调用的远程执行环境，不是整套 Flue 的 Vercel 部署目标，不能作为已有原生部署支持的依据。[Vercel Sandbox](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)

可以复用前端、业务合同、策略、连接器和评估集；数据库方言、任务实现、对象控制器与运行时归属需要实测适配。Vercel Workflows 是候选基础设施，不是已经完成的 Flue 插件。[Vercel Workflows](https://vercel.com/docs/workflows)


### 7.16 阶段 6B-5：持久取消与会话后台核对

人工命令先在会话 DO 提交控制状态和原回执，HTTP 层随后通过 `waitUntil` 唤醒核对。唤醒失败不撤销人工操作，也不改变其确认响应。未收到唤醒、HTTP 响应丢失、直接内部控制命令以及截止时间失效，均由既有控制器定时修复补偿；继续沿用 `repair_due_at`、每批 50 个、并发 5 个和每个控制器 3 秒观察上限，没有另建队列或 D1 调度表。修复地址来自原控制器保存的运行编号，作用域仍校验；这个地址不是重新执行授权。

核对只读取原执行计划。仍有效的运行只观察；未派发且已经失效的预留，在原目标建立永久取消栅栏后关闭，不启动模型。已有原生实例只允许原 creating 载荷与原幂等键恢复回执；身份或本地账本丢失则保持未确认，不重建已经取得许可的执行。当前使用一个会话的既有运行槽位；运行轮转以及历史未知费用的独立调度要在下一步明确交接，不能清空这个槽位而遗失修复责任。

Support DO 新增独立的取消标记表，兼容已有本地账本；取消标记和关闭证明分别保存。确认原运行授权已经失效后，先落盘取消，再请求原生 abort。模型认证、逐轮许可、HTTP 许可及响应交付都受永久取消标记约束；取消后的有效原始用量仍可入账，不能再交付迟到工具或启动下一轮。后续开关恢复不会清除已经提交的取消标记。

Flue 2.2.2 的 `init().abort()` 是实例级中止，源码没有把 handle 的 UID 条件传给中止请求。实现校验原账本/回执/UID，并坚持每个业务运行使用不可复用的 `ai-support:<runId>`，后续运行必须换目标；不能声称原生接口提供了原子 UID 条件中止。参考 [Flue Agent API](https://flueframework.com/docs/reference/agent-api/) 及锁定版本 `dist/index.mjs` 的 `init`/`cloudflareSettlementTransport`。销毁后复用相同目标不是支持的恢复方式。

取消时保持 Agent 声明可以重建，让 Flue 重启后能处理持久中止；不在声明函数入口仅因取消就抛错。真正的模型调用仍由 Provider 和持久许可拒绝。abort 的返回只是中止请求被接受，只有原回执读到原生终态，才生成财务关闭证明；供应商请求未知时继续保留该轮预留。未授予的轮次可释放，已发生用量幂等结算。已关闭且结清的运行直接使用原财务终态，不再唤醒原生实例；未结清记录继续在公平修复队列核对。

本步不恢复 AI 接待、不替换消费者输入、不自动生成后续运行，也不新增知识/订单工具或客户发送。入站新消息导致旧输入版本失效，已能在修复时取消旧执行；收到消息后立即调度新运行仍待实现。


### 7.17 阶段 6B-6：独立历史修复与服务端显式恢复

执行记录通过 `repair_due_at` 和 `repair_token` 独立于会话当前运行调度。新记录及迁移前的旧记录默认进入待修复；一次 D1 UPDATE 原子领取最多 50 条，按到期时间和运行编号排序，先把到期时间移到 60 秒后。每批并发 5 条、单条观察上限 3 秒；失败或进程退出不清除修复责任。完成时使用原作用域与领取标记比较更新，过期工作者不能覆盖后续领取。已经关闭但用量未知的记录五分钟后复查，关闭且全部结清才停止调度。调度列不进入财务载荷、摘要或 Support 本地冻结计划。

既有 Cron 增加独立 AI 修复分支，不再通过会话当前槽位遍历历史运行。人工作业提交后的即时唤醒仍读取当前目标。两条路径共享按原执行编号核对的内部服务；重叠修复不重复结算，不创建新的模型任务。旧运行即使不再是当前运行，原预留、原回执、原实例和核对入口也都保留。

新增内部 `resumeAi` RPC。调用须带当前实际成员身份，权限在读取前及提交前重新检查；仅处理仍打开、目前由人工或暂停接待的会话。请求绑定期望控制版本、原运行编号及一个新的运行编号，商品问题与已发布策略重新从服务端验证。存在原财务记录时必须已经取得可信关闭证明，费用未知可以继续保留；没有原财务记录时，旧控制权限也必须已经撤销。模型调用仍要复核原运行授权，旧运行不会因恢复操作重新得到授权；随后迟到的旧财务记录仍会进入独立修复。繁忙 AI 运行和已解决会话不能通过恢复请求被直接替换或重新打开。

新运行、截止时间、控制版本/epoch、成员恢复回执与待投影事件在同一个 DO 事务中提交。恢复将负责人清空并进入 AI 待回复状态；并发恢复只接受一个版本。回执使用独立 `ai-resume:<runId>` 键和 `ai_resume` 审计动作，记录 `origin=human` 与实际操作成员。重放仍检查当前权限，返回原回执与当前控制状态，不恢复已停用的开关或旧执行。模型工具不能指定恢复动作或成员身份；公开人工作业接口仍不接受这些内部运行字段。

`0034_ai_execution_repair.sql` 仅新增两列和修复索引。`0035_ai_resume.sql` 扩展审计动作约束，仅替换事件表并逐列复制原数据；原插入冲突与不可更新触发器重新建立，其他控制与发送表不替换。通过真实 D1 事务测试验证表替换中途失败会回滚，原审计记录和保护触发器保留。新恢复记录要求非空成员身份，不放宽系统 AI 记录的空身份约束。

本步尚无公开恢复 API/按钮，没有自动选择新入站问题、派发预算或启动生产接待。恢复后的运行仍需单独取得生产预算和原生执行许可。Native 测试使用同一会话的两个真实 Flue 实例，验证迟到旧 abort 不影响新实例，以及原未知费用在当前槽位切换后仍被 Cron 处理。真正的客户发送、知识/订单工具与语义质量验收继续按后续阶段推进。


### 7.18 阶段 6B-7：生产接待预算管理

`GET/POST /api/companies/:companyId/ai-budgets` 管理既有 `ai_budget` 与 `ai_budget_audit`，不创建 AI 执行或取得模型许可。接口使用实际认证会话、当前公司所有者/管理员权限、写入时的规范成员头和同源检查；浏览器不能指定模型价格、已用金额或操作成员。新预算默认暂停，时间窗、限额和次数创建后不可修改。启停沿用版本比较、原命令幂等与审计事务；重复旧启用返回原回执和当前预算，不覆盖后来暂停。

读取在一个 D1 批次内取得当前窗口、最多 20 个历史/计划窗口及最近 10 条管理操作，读后再次检查当前成员。历史按开始时间和编号倒序分页；当前预算始终单独读取，不因翻页丢失。已用费用、未知请求预留和可用余额沿用生产账本，超过估算的真实已知费用不会被截断。次数按业务接待运行计算，不按内部生成轮数重复增加。测试预算有独立表和 API，相同时间窗甚至相同命令编号都不会串账。

生产响应含 `purpose=production`，客户端同时检查用途、公司、成员、原命令、预算不可变字段、余额与分页顺序。写入响应丢失只显示待核对，不自动重发；读取当前预算与审计后再决定下一步。共用表单、精确微美元换算、版本冲突和原编号处理；没有另建一套测试预算逻辑。

公司设置中按「AI 接待」「策略测试」展示两个 ShadCN 标签页。管理员可查看四项金额、获准次数、预算启停及管理记录；普通成员不显示预算或用量。预算日期按 UTC 日界设置，显示时间沿用公司时区并注明结束时刻不包含。手机布局把金额收为两列。自动接待未开放的提示与预算开关分开，启用额度不会自动接管会话或发送客户消息。

本步复用 0033 的表和事务，无新数据库迁移、依赖、价格默认值或真实模型请求。生产模型配置选择、公开恢复/入站调度及最终发送仍需后续接线；不能把预算页面就绪视为生产自动接待验收。


### 7.19 阶段 6B-8：生产模型配置校验与预算准备信息

新增部署变量 `AI_RECEPTION_CONFIG_JSON`，与策略测试/翻译配置分开，默认留空。结构为 `{model: TranslationConfig, maxGenerations: number}`；`model` 使用既有严格价格合同，包含 `provider`、`model`、模型/提示版本、输入/输出上限和四项微美元价格。`maxGenerations` 为 1–8；缺少价格、未知字段、非整数、负数或整次预留溢出均拒绝，不能推断免费价格。已确认免费时各项价格明确填 0，运行次数限制仍保留。

生产配置与实际 Support Provider 共用同一模型约束：已锁定 SDK 的 NVIDIA `nvidia/nemotron-3-super-120b-a12b`、`support-v1` 模型和提示版本；输入预留至少覆盖 SDK 公布的上下文窗口，输出范围 1–2048。当前 SDK 上下文为 262144；运行时仍从已安装 SDK 的目录核对，不通过浏览器传入模型或 URL。费用计算复用执行账本的规范化和向上取整：单轮覆盖输入/输出及缓存最高输入费率，整次预留为单轮乘以轮数。已有执行继续使用其冻结配置，不读取新部署配置来改写旧费用。

预算 GET 的管理员响应增加配置摘要：接待总开关、模型密钥/绑定是否配置、模型与价格合同是否有效，以及有效时的模型名、轮数、单轮/整次预留额。模型配置字符串限制 32768 字符；无效配置返回明确未配置和空金额，非 0 金额。响应不包含密钥、原始价格对象或配置正文；读取不访问供应商、不创建执行或取得额度。前端复核整次金额与轮数的精确关系，区分总开关、部署准备状态与公司预算。

公司设置的接待预算页显示这些准备信息与整次预留估算。明确这是配置检查，尚未调用模型，也不会因预算启用而自动接管会话。原策略测试配置单独渲染，避免把生产摘要解释为测试检索费用。

公开恢复仍需遵守 AC-028 和第 6 节：默认只接待此后新输入，补处理当前问题须明确选择。现有内部 `resumeAi` 绑定当前输入，不能直接作为默认恢复按钮。下一步需要把等待新输入的接待意图与一次模型运行区分，并接通服务端策略/预算准入及持久命令恢复。此处未宣称公开恢复或自动执行已实现。


### 7.20 阶段 6B-9：默认恢复等待后续输入

`resumeAiForNewMessages` 是内部成员操作，复用当前身份、会话控制版本、原运行关闭证明和事务回执。参数仅为 UUID 命令、预期版本与原运行 ID；消息边界、时间、公司/店铺范围均由服务端确定。当前店铺和买卖家会话必须可用，且至少有适用于店铺的已发布自动回复策略。等待条件不替代实际输入的策略匹配或财务准入。

恢复创建 `aiListening`，保存 `conversation.message_sequence`、恢复时间和新的控制 epoch，同时记录 `ai_listen` 成员审计。该意图不创建 `AiRun`、不调用模型、不预留费用，也没有模型执行截止闹钟。控制层仍是 `reception=ai`；内部 `readAiListening` 区分等待状态与执行中运行，后续公开界面须据此显示“等待新消息”，不可显示“正在回复”。本步未接公开界面。

后续内部 `startAi` 只有在意图与当前 epoch 一致、输入在 `message_append` 的序号严格超过恢复位置、为增量入站消息且平台时间不早于恢复时间时才能消费意图。原有最新文本、策略发布版本和渠道准入仍执行。平台时间判断采取保守行为：迟到旧消息或时间精度导致早于恢复边界的输入交人工查看，不自动补答。不能用新到的出站或历史消息抬高会话总序号，再指定恢复前的旧问题运行。意图删除、新运行、版本和审计在同一个 DO 事务完成。

人工接管、解决或其他改变控制 epoch 的操作删除等待意图。首次自动启动还要求控制 epoch 为零，避免尚未真正运行过 AI 的等待会话在重新打开后绕过明确恢复。原命令重放返回历史回执和当前状态，不重新授权；成员撤权后拒绝重放。已关闭旧运行的未知费用继续保留、独立修复，等待和当前槽位切换均不免除其费用。

`0036_ai_listening.sql` 只扩展审计动作约束，保留成员身份要求和原始行，重建冲突及不可修改触发器，不关闭外键。当前内部方法尚不提供公开恢复、预算选择或新消息调度；这些接线仍须在公开操作前完成，且需在实际执行时再次核对配置、策略与预算。

旧运行的超时清理在删除截止时间前，于同一事务核对当前运行是否仍是原快照。通过暂停旧清理、启动新运行、再释放旧清理的真实 DO 并发用例，确认旧修复不会移除新运行的超时保护。


### 7.21 阶段 6B-10：已发布策略选择与服务端预算准入

`selectReplyPolicy` 只查询当前公司、店铺、会话渠道和指定业务阶段的已发布策略，按优先级倒序取前两条。排序涵盖建议与自动两种模式；最高优先级若为建议模式，不得跳过它去执行较低优先级自动策略。最高两条优先级相同则拒绝选择，不能依赖 ID 排序决定业务策略。未发布草稿不参与运行。

首次 `startAi` 和明确补处理当前问题的 `resumeAi` 在新事务回执之前核对所选策略及发布版本。原命令重放仍返回原回执；已准入运行继续按原冻结策略核对，不因为新发布的更高优先级策略而重写其上下文。原策略停用或版本变化仍按既有规则撤销后续执行许可。等待恢复检查各业务阶段的获选策略，至少有一个阶段允许自动接待才可建立等待意图。

业务阶段目前仍是可信内部调用参数，未从消费者文本、商品或订单存在与否推断；本步不是阶段分类器，也不向浏览器开放该参数。真实入站调度必须先建立阶段来源或明确的不确定性处理，再调用此准入，不能把任意客户端或模型自报当作既有事实。

`executeAiRun` 优先读取既有执行账本；已有记录沿用原模型、价格、轮数和预算，无需重新选择当前配置。仅在没有账本时，检查运营开关、模型密钥与运行绑定，读取有界且经过校验的服务端配置，以整次费用选择当前店铺所属公司的有效生产预算。预算还须有可用次数，显式零价不绕过次数限制。未配置、停用、过期、不足或无法确定唯一可用预算时，不访问原生运行时。

预算选择只是只读预检，真正预留仍复用 `reserveAiExecution` 的 D1 原子授权和费用检查，重查当前会话/输入/策略、预算余额和次数；并发争用只能预留一次。只读结果查询及修复入口不调用新准入，不因读取而启动模型。新输入调度及失败转人工接线仍待完成，不能以执行端已能选预算宣称自动接待已上线。

### 7.22 阶段 6B-11：公开恢复接待与原命令核对

已认证的当前店铺成员可以通过 `POST /api/companies/:companyId/conversations/:id/ai-resumptions` 明确恢复等待新消息。请求只接受 UUID `commandId` 和 `expectedVersion`；规范编码的 `X-DingBell-Member-Id` 绑定成员身份，同源检查继续生效。原运行、消息边界、控制 epoch、模型与预算均由服务端确定，浏览器不能指定旧问题或执行配置。

新命令先检查部署开关、模型与价格、运行绑定、当前生产预算的整次费用和次数，再由会话控制器检查原运行关闭、已发布策略和渠道。预算在这里仅预检，不预留；等待不产生执行账本、模型请求或客户发送。真正的新输入执行必须重新通过原子准入，不能把等待视为额度保证。

`GET .../ai-reception` 读取当前状态与有效等待边界；没有控制目录时返回初始暂停视图且不创建记录。`GET .../ai-resumptions/:commandId` 返回原命令回执和当前状态：原回执只属于原用户与原成员，人工接管或后续恢复不改变它。原命令重放必须保持原版本，不受后来配置停用影响，也不再次恢复。返回值通过共享严格 schema 校验，设置 no-store，不暴露内部运行编号、策略快照或密钥。

变更响应丢失时返回 `OPERATION_UNCONFIRMED`，调用方应保留原编号读取结果；暂时没有回执并不能证明原操作从未发生。接口在异步读取后重验权限，初始化期间撤权不能用初始空状态掩盖失败。公开 UI 和持久客户端恢复尚待接入；可信业务阶段、入站调度与最终 AI 回复仍未实现。

### 7.23 阶段 6B-12：消息中心恢复操作与浏览器结果核对

消息中心使用现有 ShadCN 按钮、确认弹窗和状态标签。确认内容明确默认只接待新消息、不会补答当前问题，并清空当前负责人。服务端版本不一致或无法读取当前状态时不发起新的恢复。人工接管、解决与原有回复流程继续使用原控制入口。

提交前，将原 `commandId/expectedVersion` 写入当前标签页的 sessionStorage，键同时绑定用户、原成员、公司和会话。写后必须能够读回，已存在的不同命令不能被覆盖。刷新或返回会话先读原回执，不自动 POST；未查到结果时保留原记录，仅由用户明确选择同一操作重试。读取结果严格核对作用域、原编号与版本。响应丢失、响应格式不正确和重试被拒绝，都不能冒充原操作未发生。

若原回执仍未找到，但权威当前会话版本已经大于原请求版本，旧请求无法再改变控制状态，可以结束核对。确认回执或明确拒绝首次提交后按原命令比较并清除记录，不能清除另一条操作；损坏或不可用存储阻止新恢复。退出登录和确认撤权按相应作用域清理记录。晚到响应不能更新已离开的会话。

等待状态来自 `/ai-reception` 的当前边界，与人工控制视图版本一致时才展示“等待新消息”或“AI 处理中”。手工接管撤销等待后不再保留旧成功提示。原回执若早于当前操作，界面明确提示以后续状态为准。当前按钮建立等待意图，不构成入站自动派发、知识/订单查询或最终 AI 回复已完成的证明。

### 7.24 阶段 6B-13：实时入站消费与持久 AI 输入

复用同步事务已保存的 `ingest_event`，新增投递租约、完成时间和处理结果；原始 pending/historical/observed 状态和消息事实不变。现有每分钟定时任务每轮最多领取 50 条事件，每组最多 5 条并行，租约 60 秒，单条投递及及时撤销旧执行的等待上限 3 秒。这是有界批处理，不表示已达到全租户负载或秒级延迟验收。未完成事件可在租约到期后重新领取；完成操作核对事件、公司、店铺、会话和租约编号，过期执行者不能确认新租约。同步分支失败不阻断该消费分支。

后台只能从已提交且作用域一致的事件建立控制目录，不冒充成员。`receiveInbound` 自行读取消息、追加序号和实时证据，不接受调用者提供的内容、阶段或接待权限。仅处理实时增量入站消息，沿用 AI 准入按消息时间/内部编号判断最新消息的规则；历史、非实时、卖家消息及已被更新消息取代的事件不触发接待。本步未改动同一时间戳的既有排序策略，也未将缺少平台顺序证明的事件解释为严格业务顺序。

`inbound:<eventId>` 是系统保留的回执空间，人工命令不能预占。接受回执、控制状态、已接收追加序号和投影 outbox 在同一 DO 事务提交。已接受事件重投只返回原回执和当前状态，不重新打开后来已解决的会话，也不恢复人工已撤销的 AI。当前 AI 运行已包含的输入不会因迟到投递再启动一轮；此类输入和恢复前输入被忽略时，仍持久推进已检查序号，防止人工解决或重启后的重投重新生效。新消息置为 open/needs_reply，保留人工负责人和接待方式；打开中的人工会话不旋转 control epoch，避免仅因新输入误撤销已授权的人工回复。

AI 等待只接受显式恢复边界之后的输入；接收时删除等待/旧超时记录，旋转 control epoch，并保存绑定事件和 epoch 的 `aiPendingInput`。旧模型输出随即失去权限，重启不丢失新目标。新轮次仍须通过当前消息、已发布优先策略及后续预算门槛；旧执行存在时须核对其不可变运行快照和已确认财务关闭记录。人工接管、解决等操作撤销待处理目标，历史回执不具备重新入场权限。

迁移 0037 扩展空人工身份的 `customer_message` 审计动作，重建后保留冲突/不可修改触发器；0038 仅追加投递字段和索引。两者均通过实际 D1 保留与事务回滚验证，不关闭外键。`delivery_outcome=accepted` 仅表示控制器已持久接收，绝不代表模型已回答或向消费者发送。阶段/语言判定、自动派发、知识与订单工具和最终回复仍待实施。


### 7.25 阶段 6B-14：先分类、后选择答复策略

分类是独立的一次运行，复用现有 Support Agent、Cloudflare DO、原生 Flue 回执与生产费用账本。旧答复快照仍为 schemaVersion 1；新分类快照为 schemaVersion 2 / kind=intake，不改写旧记录或其哈希。两个阶段分别使用服务端 UUID 和独立的 `ai-support:<runId>` 实例。分类由现有有效部署配置派生 `intake-v1` 提示版本，最多一次生成；一次分类和一次答复分别占用一个预算运行次数，而不是合并算作一次消息。

分类只读取当前已提交、实时增量的消费者消息，冻结该输入及各业务阶段的最高优先已发布候选策略。未匹配或存在歧义的阶段没有候选；建议模式仍保留为候选，不能退回低优先级的自动策略。没有任何自动候选时不进入分类。输入不含商家指令、订单编号、内部作用域、策略编号或接待权限。消息中没有订单不能推断为售前，存在订单也不能据此判断为售中或售后。

模型唯一可用工具为 `submit_classification`，只接收 `stage`（presale/order/aftersale/unknown）、`language`（ru/zh-CN/en/unknown）和 `customerRequestedHuman`。Flue 的其他默认工具不传给模型，禁止并行工具调用。工具使用 durable step 提交，严格核对原运行与原分类的持久回执后报告 committed；未确认与冲突不冒充成功，所有工具结果均结束当前运行且不可发送客户消息。分类只提供路由信息，不能放大订单查询或店铺访问权限。

控制器决定实际路径：明确要求人工、无法识别阶段、缺少自动候选，或跟随消费者语言但无法识别语言时，进入待人工队列；固定语言策略可以为答复提供已配置语言。成功分类保存下一答复运行编号、策略版本、阶段和语言，旋转 control epoch 撤销分类运行权限。重启或重复工具回执不重新生成目标。答复开始前必须确认分类费用记录已关闭，且冻结策略版本仍然有效。新输入和人工操作可撤销旧目标；历史分类编号不能被显式恢复复用为新答复实例。超时由系统分类回执转人工，沿用现有 outbox 与后台投影修复。

迁移 0039 保留旧财务行、审计回执及不可修改约束，扩展两种系统审计动作，并仅允许符合单次生成和 intake-v1 提示约束的分类快照进入同一执行账本。不关闭外键。合成原生测试用于验证阶段衔接、工具边界、费用与重启恢复，不代表真实模型阶段/语言判断质量。本步提供分类与答复执行的受控衔接；从待处理输入自动领取、派发与异常降级的调度器，以及知识/订单/最终回复工具，仍待接通。


### 7.26 阶段 6B-15：自动派发与受控失败降级

沿用每分钟 scheduled Worker，在入站消费之后执行派发；同步、控制修复、知识任务和独立费用修复仍各自隔离失败。`ai_dispatch` 每个控制器保存一个最新输入目标，包含原事件、追加序号、固定分类运行编号、创建时间、到期时间及租约。消费者在同一 D1 batch 内确认入站并入队，写入失败不丢失待投递事件。较旧或重复的输入不能覆盖已有目标；处理完成保留该行并将到期时间置空，避免迟到确认重新激活旧任务。迁移不回填已处理输入。

总开关开启且具备运行绑定时，初始未接管会话可以入队；否则只为已经处于 AI 接待的会话建立清理待办。关闭开关后的新输入不会让原等待会话永久停在 AI 处理中，也不会为初始人工队列启动模型。人工所有者、已解决会话和恢复边界之前的输入仍由现有控制器保护。

派发每轮最多领取 50 条，每组 5 条，租约 60 秒，每条工作等待上限 3 秒。固定分类编号随租约重试、重启继续使用；原分类回执提供已保存的答复编号，答复跨调度时不会重做分类。每个阶段仍经过当前输入、策略、全局配置、预算和原生运行许可检查。租约仅用于调度，不代替任何执行权限；过期工作者无法清除新的租约或输入目标。

分类及答复复用既有执行/核对入口。未知原生结果继续核对，不创建新编号；配置或预算拒绝、终止却未提交可用动作等情况由系统回执进入人工队列。整体待办通常以五分钟为降级界限；如果有更新的实时消费者事件尚待消费，优先让新事件进入控制器并取代旧目标。较新的平台卖家回复会让旧准备任务失效并进入人工处理，不留悬空的分类结果。

`ai_dispatch_stop` 同时绑定原事件、分类根运行以及失败阶段的目标运行。停止分类的迟到结果不能停止已经开始的答复，旧待办也不能停止人工明确恢复的另一运行。全局关闭/整体超时可以停止同一待办的当前阶段。控制状态、停止回执和投影 outbox 原子保存；历史回执重放不覆盖当前状态。财务核对继续独立保留未知用量，不因转人工而清零。

迁移 0040 增加派发目录及系统停止审计，保留既有审计冲突/不可修改触发器、财务约束和外键。当前原生验证使用合成模型，已连接自动入站到分类、独立答复运行及真实控制器转人工；当前 Support 的答复能力仍只有转人工工具。知识/订单工具、最终 AI 外发、真实语义质量、实时延迟、多租户吞吐和云端部署均不因此视为验收通过。

### 7.27 阶段 6B-16：运行绑定的知识检索工具

显式选择 `support-knowledge-v1` 提示版本时，Support 增加 `search_knowledge`；旧 `support-v1` 和分类运行保留原工具集合及冻结载荷。工具输入为空对象，问题只能来自原 AI 运行，不能由模型另选公司、店铺、商品或问题。原生传输每轮仍只接收一个已声明工具，禁止 task、未知工具和并行批次。知识正文是引用材料，不是系统指令；相似度不构成事实支持的证明。

服务端读取原执行账本，并通过会话控制器核对运行、epoch、消息版本、有效策略和截止时间。商品范围只从原平台消息的 SKU 与同店铺商品别名推导；没有唯一映射时只检索通用知识。员工身份不进入自动检索授权。员工检索和 AI 检索复用同一批次、排序和发布重查算法，各自保留权限检查：最多 160 份匹配的当前发布文档，每批 20 份，合并前十条；发布中变化允许一次重查，索引不可见或范围超限返回不可用，不能冒充没有知识。

`ai_knowledge_query` 与原生产执行一对一，只允许原问题的一次嵌入许可。领取许可和正式 AI 预算预留在同一 D1 事务内完成，随后在请求前再核对预算、总开关及当前运行。并发输家、响应丢失、进程重启都不能获得第二次调用；向量和完整检索依据只写入一次，更新和删除保护防止重新领取。人工接管后的迟到结果可以保存作核对，但不能交给已失效运行。迁移 0041 不改写旧财务、会话、知识数据，也不回填历史查询。

嵌入沿用 `bge-m3-1024-bytes2400-v1`，原问题最多 2400 UTF-8 字节，不截断。独立 `AI_KNOWLEDGE_QUERY_CONFIG_JSON` 配置 profile、priceVersion、maxInputTokens 和 inputMicrosPerMillion；缺失价格、非法配置和余额不足均不调用模型，明确的零价也只允许一次调用。以配置的输入上限向上取整到微美元，最低上限沿用公开模型的 60,000 tokens；不硬编码当前价格，也不把字符数当作 token 数。[Cloudflare 模型文档](https://developers.cloudflare.com/workers-ai/models/bge-m3/)

现有嵌入适配器没有提供可核实的逐次 token 用量，因此这笔额度是保守预留，不是实际已结算费用；成功、失败和未知结果均不凭空退款或记为免费。即使聊天生成已经结清，检索预留仍保留在原预算窗口，实际账单核对和释放尚未实现。本步不复用人工测试预算，也不增加额外的运行次数：一次答复执行最多对应一次查询，仍受该预算的运行次数上限约束。

完整依据含运行、范围、哈希、文档版本和片段正文，仅保存在服务端。模型只能看到状态、不可发送标识、引用编号、标题和正文，不会收到内部运行编号、店铺范围、内部哈希或相似度。持久工具结果重放时再次检查发布与授权；最终回复提交仍须调用服务端依据复核，不能只相信历史工具输出。当前可生成内部草稿、检索或转人工，尚无最终回复提交、客户发送和订单查询工具。原生测试使用合成模型与嵌入绑定，不证明真实问答质量或实际云端索引可用性。

### 7.28 阶段 6B-17：带引用的回复草稿提交

新增显式提示版本 `support-answer-v1`，在知识检索和转人工之外提供 `submit_answer`。旧提示版本及分类运行的工具集合保持原样。模型只能提交 1–1000 字符的正文和 1–10 个不重复的已检索片段编号，不能提供公司、店铺、消费者、订单或运行编号。引用存在只证明来源有效，不证明生成正文与来源一致或满足客户问题。因此这一版本始终要求人工复核，不能创建客户发送意图。

草稿绑定原生产执行及不可修改的检索记录。提交前核对控制器的当前运行、消息版本、接待状态、策略、截止时间和部署开关，再检查已发布知识的范围、版本、正文哈希和商品关联。D1 插入语句同时检查运行投影与当前发布的片段正文，阻止检查与写入之间的撤回或新消息变化；提交后再次复核。控制器与 D1 不是跨系统事务，任何已保存但复核失效的内容仅为历史草稿，不代表可用回复或发送授权。

迁移 0042 增加 `ai_answer`，一条执行最多保留一份正文、引用编号、完整检索依据和创建时间。更新及删除保护避免重试覆盖原稿；相同运行和相同内容重复提交可返回原结果，不同内容返回冲突。写入后的响应丢失返回未确认，不能解释为没有写入。迁移不回填历史回复，不改写旧会话、知识或财务数据。

持久工具分别保存草稿提交结果和转人工回执，随后终止本轮，不再触发下一次生成。保存成功时请求人工确认待审草稿；保存失败或未确认时请求人工处理异常。只有真实控制器回执能确认转人工，返回值分别展示草稿状态与转人工状态，始终为 `canSend:false`、`sent:false`、`reviewRequired:true`。重放回执是历史证据，不是当前权限。`reviewAiAnswer` 提供仍在有效运行内的再次复核；未来发送流程还必须有独立的授权、语义质量、并发控制和发送许可，不能直接把该函数结果当作发送命令。

本步不新增人工草稿查看/采纳界面，也不把后台保存成功解释为整个人工复核体验已交付。下一步需接入当前员工权限下的草稿展示、来源核对和明确采纳操作，然后继续最终回复与发送链路验收。原有人工回复流程保持不变。

订单工具另有前置缺口：现有 `message.order_number` 来自 Ozon 消息上下文，员工侧只作为导入快照的关联线索。尚无已验收的消费者订单归属证据，不能凭相同订单号向模型披露私有订单事实。2026-10-10 尝试读取官方 Seller API 文档未成功，第三方转载不作为权限依据。待真实关联及归属验证后接入只读订单工具；当前相关问题转人工，不用合成验证替代平台验收。

### 7.29 阶段 6B-18：员工查看与明确采纳 AI 草稿

消息中心的人工回复区增加「AI 草稿」入口，沿用 ShadCN Sheet 展示最新已保存草稿的原问题、语言、保存时间、正文及所引用资料的标题、版本和原文。只读取生产 `ai_answer`，不调用模型，也不因打开抽屉而恢复 AI 接待。尚无草稿、读取失败和权限失效分别展示对应状态；手机使用全宽抽屉，正文单独滚动，操作保持在底部。

`GET /api/companies/:companyId/conversations/:id/ai-draft` 根据当前已验证会话、公司成员和店铺授权读取，要求绑定当前成员编号，异步读取后再次检查授权。返回严格校验的最小视图和 `Cache-Control: no-store`，不暴露运行控制字段、内部哈希或费用数据。历史草稿读取不依赖仍在活动中的 AI 执行；原运行已转人工不等于员工失去查看其草稿的权限。

历史可见性与可采纳状态分开。服务沿用原执行快照与当前知识解析器，核对原消息序号/正文、策略发布版本、平台会话和店铺状态、商品关联及已发布知识原文；变化时保留历史正文和原引用，但返回过期原因。知识撤回不能把历史原文伪装成当前有效依据。读取期间出现新草稿或上下文变化同样不能放行。`canSend` 始终为 `false`；草稿显示为当前有效，仅说明本次读取通过这些核对，不构成发送授权或语义质量证明。

客服先认领或接管会话并满足原人工回复条件，才能选择「采纳到回复框」。已有不同输入必须明确确认替换；采纳前重新读取服务端草稿，核对原运行编号与当前状态，再比较编辑器原文及本地修订号。关闭抽屉、卸载页面或核对期间编辑器变化不能被迟到响应覆盖。成功只调用现有人工草稿编辑路径，保留刷新恢复和原预览失效规则，并将焦点交回回复框。

采纳不创建发送意图、不发起翻译、不自动预览或发送。客服可以继续修改正文，必须经过原人工预览和明确发送确认；最终权限及并发控制仍由现有人工发送链路负责。采纳后的正文属于可编辑人工草稿，本步没有新增「草稿引用—最终人工消息」的审计关联，也不承诺在知识后来变化时自动改写人工输入。自动发送、私有订单工具、真实模型质量与云端能力仍需后续独立验收。

### 7.30 阶段 6B-19：不可变 AI 回复意图与活动资格复核

新增内部 `prepareAiReply` 与 `reviewAiReply`，仅接收原运行编号、受控作用域和严格的正文/引用输入。模型不能提供成员、店铺、渠道、凭据版本或发送权限。独立 `ai_reply_intent` 以原 `run_id` 为主键，使用确定性编号 `ai-reply:<runId>`，保存执行快照哈希、正文及哈希、引用和完整原知识证据、平台账号、会话线程、凭据版本与创建时间。不可变触发器拒绝更新和删除；原执行外键保留原 epoch、输入版本、发布策略及期限，避免重新绑定当前运行。迁移 `0043_ai_reply_intent.sql` 只增加此表、唯一索引和触发器，不改写历史表或发送记录。

只接受内部 `support-reply-v1`，既有 `support-answer-v1` 继续是人工审核草稿。新版本尚未加入生产模型校验、提示词、工具集或自动派发配置，也没有新增公开 HTTP 入口。准备结果与审阅快照始终 `canSend:false`；`origin` 明确为 AI，成员/用户编号为空，不能借用客服身份进入原人工 `send_reply`。

资格同时要求部署 `AI_RECEPTION_ENABLED`、`AI_OUTBOUND_ENABLED` 和 `OUTBOUND_ENABLED` 为准确的 `true`，店铺外发开启、状态可用、Ozon 买卖双方会话仍开放，auth/reply 能力未过期且凭据信封完整。通过真实控制对象重新读取并完整比较原 run；D1 同时复核 epoch、最新输入、未分配人工、工作状态、原策略发布版本和原 deadline。知识证据绑定原问题哈希及公司/店铺/语言/唯一 SKU 商品关联，全部检索来源仍须保持原发布版本、原文、标题、内容哈希和索引档案；引用有效不等于回答语义正确。

预算只复核原运行预算的公司、启用状态、当前窗口及金额未超限，不再次预留费用或占用运行名额。已预留且刚好占满余额/名额的运行仍能准备。本文不承诺全局预留总额与所有执行占用已经完成交叉审计；凭据信封存在和版本一致也不代替最终解密验证。

单条 `INSERT SELECT` 与资格读取共用 D1 谓词，在写入时核对原执行哈希、原检索证据、已发布知识、预算及原渠道/凭据版本。写前和写后均经 DO 复核；同正文/引用重放返回原记录，异输入冲突，任何重放都不能更新原渠道绑定。提交响应丢失返回 `unconfirmed`，后续只核对同一编号，不产生第二条意图。写入前撤权不保存，写入后接管或来源撤回可能保留历史意图，但结果及再次审阅不能放行。

本步仅定义活动运行的准备资格：关闭或到期执行拒绝，不延长期限。后续 sender 必须另行定义成功 `runtime_closed/completed`、用量结算和排队资格，失败/中止/不确定结果不能恢复授权；不能直接把本步 live-only 规则套到正常关闭后的队列。最终发送仍须在现有会话 DO 内与接管判定先后，解密后再查渠道和权限，再沿用共享店铺限流及单次尝试。DO 可以将接管与开始网络调用线性化，但 D1 撤权和外部网络没有跨系统原子事务；一次当前审阅绝非永久发送许可。

后续接线已有三项具体约束：本表正文哈希沿用 `knowledgeHash` 的 JSON 字符串哈希，现有发送队列使用原始 UTF-8 正文哈希，入队必须在精确正文一致后计算队列哈希，不能直接复制；当前派发器对已完成运行也会调用失败兜底，成功分支必须先确认原意图、完成/结清及队列回执才能保留 epoch；现有分钟 Cron 不保证在原 60 秒期限内观察完成并入队，必须沿现有持久调度能力验证及时且可恢复的唤醒，不能靠延长期限解决。


### 7.31 阶段 6B-20：AI 来源接入共享发送管道

`support-reply-v1` 是独立的冻结版本，工具集为 `request_handoff`、`search_knowledge` 和 `prepare_reply`。模型只能提交严格的正文与原检索 chunk 编号，不能指定公司、成员、渠道、凭据或期限。准备成功持久化原意图并终止生成，随后唤醒原运行观察任务；不转人工、不确认已发送。唤醒失败保留原意图和未确认状态，重放可幂等重试。原 `support-answer-v1` 继续提交人工审核草稿，不获得自动外发资格。

新增只读 `reviewCompletedAiReply`，与原 live-only 准备资格明确分开。要求原运行 `runtime_closed/completed`、原 native receipt 完全一致、至少一次生成、每次 usage/charge/settledAt 已确认、状态 settled 且无剩余生成预留；失败、中止、未启动、未知用量都拒绝。复用原 epoch、输入、发布策略、知识原文/档案、SKU 关联、渠道/凭据、原 deadline 和预算窗口检查，不重新占用费用或名额。检索嵌入的保守预留仍在预算中，不能误称实际费用已经全部核销；此处结清针对聊天生成。

控制对象内部 `enqueueAiReply(scope,runId)` 不接收模型选择的发送字段、不借用员工会话。它读取不可变意图，按精确原文重新计算共享发送器使用的 UTF-8 哈希，在短事务中确认本对象当前 run/epoch/reception/期限，原子写入 schema 2 队列、`ai_send_reply` 回执和审计 outbox。AI 用户/成员编号为空，`origin:ai` 和原 runId 明确；人工 schema 1 原字段、公共写命令及 UUID 约束保持不变。确定性 `ai-reply:<runId>` 只创建一次。已有回执重放可以返回历史确认，即使以后被接管或到期，也不更新、重新排队或恢复发送权限。

`wakeAiReply` 仅在原意图有效时保存原 runId、dueAt 和原 deadline。现有 Durable Object 闹钟每秒有界观察原 Flue receipt；等待/未确认继续观察，完成后再次经过独立资格核验再入队，过期或接管终止观察。观察发生在存储事务和短并发屏障之外，native read 单次有界，不用分钟 Cron 作为成功的唯一条件，不延长原授权。自动派发器在 completed 后先核对原队列回执再停止调度，避免把正常完成当作失败兜底并轮换 epoch。

AI 与人工复用原解密、店铺级请求预算、排队、单次 attempt、Ozon 请求/响应解析、结算与投影。AI 的渠道读取不连接 member/user，完整事实复核放在最后渠道读取之后。尚未到 due 的 AI 队列也先查当前资格，限流 defer 不跨过原 deadline。异步准备之后再次读取当前资格，短 `blockConcurrencyWhile` 与本对象接管/epoch 变化确定先后，在提交 sending/唯一 attempt 后开始网络调用；网络结果在屏障外等待。D1 来源/预算撤回与外部平台网络之间仍不存在跨系统原子事务，最后一次读取不是永久许可。

已开始网络调用时，接管只改变会话控制状态，原发送仍按原 attempt 核对成功、失败或 unknown，不重发、不改回 AI。成功仅在相同当前 run/epoch 时清理原 deadline/observer；修复流程也识别本运行已 sent，防止重启后旧期限误转人工。 原派发队列确认丢失、超过五分钟才恢复或开关关闭，也不得撤销该运行已送达的结果；中央停止逻辑确认相同当前运行/epoch 和严格的 sent 回执后忽略旧停止请求，再沿用现有派发收尾清理原队列。failed/unknown 保留原兜底，迟到成功只结算原发送，不逆转已发生的人工/暂停状态。后续消费者新消息沿现有 inbound 流程形成新 epoch 与新运行，不复用旧答案授权。

迁移 `0044_ai_reply_delivery.sql` 在外键保持开启的情况下保存 send_attempt、重建 parent/child 与控制事件表，完整复制旧回执和人工数据、恢复六个相关触发器。新增 ai_run_id 外键及插入 guard 核对原公司/店铺/会话/controller、正文、线程、凭据版本和 epoch；不可变与单次 attempt 保护继续有效。失败事务必须恢复全部历史表、外键与触发器，不能使用禁用外键后丢失尝试记录的迁移。

公共读接口和前端解码只额外接受受控 `ai-reply:UUID`，任意其他前缀仍拒绝。消息中心展示 AI 发送正文和状态，人工取消命令仍是原 UUID 契约，因此不向 AI 队列展示该按钮；人工接管及部署/店铺暂停可阻止尚未发起的 AI 请求。不新增公开 AI 发送入口、员工冒充字段或自动确认动作。

部署必须显式同时开启 `AI_RECEPTION_ENABLED`、`AI_OUTBOUND_ENABLED`、`OUTBOUND_ENABLED` 和店铺权限，并满足已验证未过期 auth/reply 能力。示例配置保持关闭；新提示词虽可被配置选中，也不能绕过入口、每次生成、知识工具、意图准备及最终发送的开关复核。本地 native 验证中，原生 Flue、D1/DO、检索授权与共享发送器实际运行；模型/Ozon HTTP、嵌入与索引绑定采用合成适配；这不证明真实模型答案语义、Ozon 权限/窗口、云端容量或平台重试可行。真实外发、私有订单归属、跨账本预留审计、嵌入费用核对和 Cloud R2/部署仍待独立验收。

### 7.32 R12-1：跨账本预留与支出的只读核对

`readCompanyBudgetAudit` 独立比较公司三套预算及其原始账本，不调用模型、Flue 或发送器。AI 预留等于未关闭运行尚未领取的生成名额，加每个已领取但用量未知的生成预留，再加 `ai_knowledge_query` 的保守嵌入预留；关闭运行只去掉未领取名额，不能清除未知生成或嵌入预留。生成支出使用 `ai_generation.charged_micros`，运行次数按执行记录计数。翻译和问答测试分别累加仍 `held` 的原预留、已记录支出，已释放记录不再占款；测试运行次数包括已结清及已释放的已准入记录，翻译不额外定义运行次数配额。

测试检索额度属于部署级 `reply_test_query_usage`，不是公司 `reply_test_budget` 的余额组成。`readQueryAllowanceAudit` 按指定 UTC 日期比较所有公司逐笔检索与部署额度；仅是内部部署管理函数，不开放公司路由，不能用公司局部合计与全局配额直接比较。向量/引用就绪、日期过期或生成结清均不证明嵌入实际费用，因此当前检索预留仍完整保留。

预算汇总和逐笔合计在同一 SQL 语句中读取，避免并发结算时读取两个不同状态造成假差异。整数 `SUM` 后转十进制字符串再返回，差额使用 `BigInt`，保留超过 JS 安全整数范围的精确结果；SQLite 64 位整数溢出直接报告不可读取，不使用浮点近似或零值兜底。检测生成计数/序号缺口及遗留预算事务标记；报告 `balanced` 仅说明这些账面合计相等，不证明执行快照、供应商账单或正文事实有效。`canRelease` 与 `supplierCostsVerified` 始终为 false。

新增 `GET /api/companies/:companyId/budget-audits/:kind/:budgetId`，kind 只允许 `ai`、`translation`、`reply-test`。仅当前已验证的公司所有者/管理员可读，要求规范编码的 `X-DingBell-Member-Id`，首次读取、财务语句及返回前都绑定当前会话与成员；撤权后的迟到读取不返回旧数据。无参数注入、写入或退款入口，不返回对话、输入、配置、价格或供应商密钥，不公开部署级检索汇总。差异不会自动改余额、暂停预算、改变新运行准入或授予旧执行新的权限。

本批不增加依赖、迁移、UI 或云资源。待实施范围仍包括核对展示/告警、持久审计结果、供应商逐请求用量证据与不可变结算/释放、无人读取的翻译/测试运行修复，以及生产规模下的查询性能。依据：[D1 绑定/事务文档](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[SQLite 聚合整数与溢出合同](https://www.sqlite.org/lang_aggfunc.html)。当前[官方 BGE-M3 页面](https://developers.cloudflare.com/workers-ai/models/bge-m3/)未给本项目逐请求实际费用的关联证据；不因取得向量或标价就推定原请求实际费用。

后续研究发现[官方批处理 REST 示例](https://developers.cloudflare.com/workers-ai/features/batch-api/rest-api/)提供外部关联号及批次 token 用量，可作为后续证据路径候选；该接口与当前同步绑定的传输、输入和回执合同不同，示例的批次用量不能直接套用到现有逐次预留，不据此释放历史请求或新增第二次调用。

2026-10-11 继续核对的另一个候选是 [AI Gateway Workers 绑定](https://developers.cloudflare.com/ai-gateway/usage/worker-binding-methods/)与[单条日志 API](https://developers.cloudflare.com/api/resources/ai_gateway/subresources/logs/methods/get/)：可按日志编号读取模型、供应商、用量和可选成本。`aiGatewayLogId` 的文档合同是最近一次请求的编号；并发下不能仅凭该可变属性认定它属于某个旧运行，必须另核原请求关联信息。当前已锁定 Workers 类型中 token/cost 字段可缺失，缺失不能按零值结算；自定义成本、缓存命中或示例数值也不能替代原请求真实用量。当前 BGE-M3 同步输出类型只有向量/shape 等字段，没有本项目可直接使用的逐次用量证据。

若后续采用 Gateway，需验证请求关联、BGE-M3 的实际用量字段、失败/丢回执/迟到日志与保留期限；不为核对重发原嵌入。[日志文档](https://developers.cloudflare.com/ai-gateway/observability/logging/)区分关闭整个日志与仅关闭 payload：后者保留用量元数据而不保留原文/响应，但当前项目尚未验证该设置在原生绑定路径的实际效果。本次只有文档和锁定类型研究，未创建网关、开启日志、修改同步嵌入路径或释放历史费用。

### 7.33 R12-2：分类完成与并发回执读取

分类回执初读和当前 intake 的 live-read 不是一次原子读取。其他请求可能在二者之间提交分类并推进 control epoch，使 live-read 不再返回旧运行。此时只补读同一 `ai-classification:runId` 的已保存回执，再沿用原提交事务比较 origin、原运行与完整分类输入；一致请求返回同一原回执和当前状态，不一致仍拒绝。回执重放不恢复旧 epoch、不重新生成 nextRunId、不启动新运行或发送，也不替代后续回答的独立准入。

固定顺序的真实 D1/DO 检查覆盖上述窗口及冲突分类，保存 RED 与修复证据。控制夹具迁移优化和提前清理只属于测试环境；不会向生产应用加入任意 SQL 执行入口。原业务测试期限与四路并发合同不变。

### 7.34 R12-3：AI Gateway 嵌入用量关联与保守结算

生产知识查询配置可选 `gatewayId`；未配置时保持原同步 Workers AI 路径和完整保守预留。配置后，每次嵌入关闭 Gateway 缓存，并写入 `dingbellPurpose=ai-knowledge`、原 `runId` 和 event ID。向量响应通过原维度/数量校验后，才把绑定提供的 `aiGatewayLogId` 写入查询。该可变绑定属性本身不作为费用证明；并发误关联会在后续运行元数据核对中失败并继续持有预留，不会把另一运行的费用记入本运行。

迁移 `0045_ai_knowledge_gateway_log.sql` 只为既有查询增加可空日志编号、不可变 Gateway 用量、实际微美元和结算时间；历史行全部保持 null，不重写向量、依据、权限或原预留。日志编号及结算事实一旦写入不可替换，结算三字段必须同时存在，实际金额不得超过原预留。失败迁移回滚原表和触发器，原 no-delete 保护继续有效。

`reconcileAiKnowledgeUsage` 只读取原查询和 `gateway.getLog()`，不重发嵌入。日志必须同时匹配不可变日志编号、`workers-ai`、固定 BGE-M3 模型、2xx 成功、未命中缓存、非自定义成本、原运行元数据、正整数输入 tokens、零输出 tokens 及冻结上限；`cost` 必须是有限非负 USD，并与原 token 数和冻结单价一致。字段缺失、日志尚未可见、价格不符、失败/缓存/自定义费用或任一关联冲突都返回未确认，完整预留保持不变。

通过校验后，实际微美元仍按冻结单价与 tokens 向上取整。一个 D1 批次把原嵌入预留从预算 `reserved_micros` 移到 `spent_micros`，保存规范用量证据并清除事务标记；并发核对最多一个写入者，重放返回已结算而不重复扣费。差于保守上限的部分随本次可信结算释放，但 `supplierCostsVerified` 与 `canRelease` 仍为 false：Gateway 日志是逐请求提供商证据，不是最终发票/账单对账，也不授权释放其他未知费用。

预算审计相应把未结算查询计为 embedding reserved，把已结算金额计入支出，并检查结算字段是否成组。现有 AI 修复游标在运行关闭后仍会为有日志编号但未结算的查询每五分钟保留核对机会；scheduled Worker 同时观察原生成与 Gateway 用量，因此不依赖管理员打开审计页面。无日志编号的旧查询和未配置 Gateway 的查询不会被猜测释放。

本地验证只使用合成 Gateway 日志与真实 D1，不证明 Cloudflare 日志可见延迟、保留期、BGE-M3 真实 token/cost 形状、生产 Gateway 的 payload 关闭配置或最终供应商发票。生产启用前仍须用无客户正文的受控请求逐项验收；日志和账单不一致时保持待核对。翻译/问答测试的无人读取修复由下一节接续；发票级对账、展示/告警和生产查询性能仍属于 R12 后续范围。

### 7.35 R12-4：翻译与问答测试的持久费用修复

迁移 `0046_usage_repair.sql` 只为 `reply_preview_run` 和 `reply_test_run` 增加可空修复时间、租约 token 及索引；已有财务行、原回执、结算字段、外键和不可变触发器不重建。旧 held 运行默认立即进入待核对集合，已结算/已释放行不领取。正常的前台结算或可信零请求释放会同时清除修复游标，不留下无效后台工作。

每分钟 scheduled Worker 分别最多领取 25 条翻译和 25 条问答测试记录，租约 60 秒，每组最多 5 条并行、单条观察上限 3 秒。未结清项移到五分钟后再查，使较新的 held 记录不会被最早的永久未知费用饿死；结清项停止排期。租约只负责公平调度，不授予模型调用、结果读取权限或退款权。

后台修复不调用 prepare/dispatch，也不恢复丢失回执。只有 D1 原回执、原 native uid 和匹配的不可变 DO 账本同时存在，才观察原执行；完整且明确报告的四类用量按原冻结价格进入既有幂等结算。员工 session、成员或店铺查看权限后来失效不抹掉已经发生的供应商成本，后台也不会因此展示原文、译文、问题或回答。receipt 缺失、实例/账本不匹配、调用异常、pending、用量缺失或不合法均继续 held。

自动释放采用更严格分支：原回执读取必须明确返回失败，同一账本必须匹配且 HTTP 计数为零，再由原 Durable Object 的 close 方法生成永久关闭证明并调用既有释放事务。临时读取错误、仅仅找不到实例、无回执或已有一次 HTTP 都不是零请求证据。并发 Cron/前台读取通过领取租约和原结算条件最多记账或释放一次；失败修复只延后，不重发供应商请求。

本地测试使用合成 Flue runtime 与真实 D1，覆盖无人读取、原 session 删除、pending 重排、并发修复、可信零请求释放、未知请求保留及 0046 失败回滚/历史保护。它不替代真实 NVIDIA 用量、供应商账单、云端 Cron 延迟或大规模积压验收。

### 7.36 R12-5：持久账本核对状态与受限告警

迁移 `0047_budget_reconciliation.sql` 新增不含业务正文的 `budget_reconciliation_state`。迁移为已有三类公司预算建立待核对状态，并通过三个预算插入触发器把新预算加入队列；状态不能删除。每条状态只保存公司、预算类型/编号、下一次检查、租约、规范化总额快照、连续差异/失败次数与通用错误码，不保存翻译原文、问题、回答、消息、用户或供应商 payload。

scheduled Worker 每轮按 `next_due_at/公司/类型/预算` 稳定排序领取最多 25 条，租约 60 秒并以五路并发执行纯 D1 算术核对。正常结果每十五分钟复核，差异每五分钟复核；旧到期项始终排在已后移的条目前，避免单一异常预算饿死队列。异常只保存 `AUDIT_UNAVAILABLE` 和时间，不持久化数据库异常文本；上一份可信快照继续保留。连续差异计数在恢复一致后清零，首次差异与持续差异可以在界面中区分。

该任务调用无成员身份的内部算术边界，但它只读原预算和逐笔账本，并只能更新监控状态；不能 prepare、dispatch、settle、close、退款或释放预留。管理 API 仍在读取前后核对当前已验证 session、公司成员和 owner/admin 角色，并把实时同语句快照与后台状态一起返回；普通成员、跨公司和已替换成员不可读取。公司设置页只为当前预算展示账本/明细总额、精确差额、嵌入关联额、后台时间及持续异常/后台失败告警。

“账本一致”只表示本地明细算术与本地预算投影一致。界面和 API 继续固定 `supplierCostsVerified=false`、`canRelease=false`，不把状态快照当供应商发票，也不据此自动修钱。当前告警是受限页面内的持续状态，不包含邮件、Webhook 或跨租户汇总；真实 Gateway/供应商发票、通知去重/恢复通知以及生产规模 Cron 与查询性能仍需后续验收。

### 7.37 R12-6：公司核对汇总、退避与积压边界

管理员可通过 `GET /api/companies/:companyId/budget-audits` 读取本公司的持久核对汇总。接口要求规范编码的当前成员头，并在批量读取前、SQL 内及返回前复核已验证 session 与 owner/admin 角色；普通成员、跨公司和被替换成员仍得到不可枚举的 404。响应只给 tracked/pending/balanced/mismatch/unavailable/alerting 数量和最多 50 条待首次核对、差异或后台失败状态，不返回财务 payload、客户内容或跨公司统计。列表超过 50 条明确 `truncated=true`，不能把截断列表当作全部异常。

公司设置的 AI 接待预算页增加三类预算汇总卡，因此尚无独立管理页面的翻译预算异常也可被公司管理员看到。卡片区分待首次核对、首次差异、持续差异和后台不可用，显示下一次计划时间，并继续说明本地一致不是供应商发票。单预算实时核对仍独立展示精确金额；汇总状态不能授权改账或释放。

连续差异和连续后台失败采用 5 分钟起、按次数翻倍、最多 1 小时的退避；成功但仍有差异使用差异计数，读取失败使用独立失败计数，恢复成功后失败计数清零，恢复平衡后差异计数清零。领取仍按到期时间和稳定作用域排序，每轮最多 25 条；本地 1,000 条合成积压检查确认相邻批次不重复、汇总列表有界，并确认到期索引和公司主键索引被查询计划采用。这是本地查询形状证据，不是多租户生产负载或 Cloudflare Cron 延迟验收。

### 7.38 R09-1：转人工跟进要求的受限展示

现有 `request_handoff` 回执已经不可变保存模型提出的原因、摘要和最多八项 `neededInformation`。本增量不再创建第二份客户资料表，而是从 D1 投影读取最新原回执，规范解析后形成固定用途 `human_follow_up`、固定状态 `requirements_only` 的跟进简报。该状态明确表示“建议后续确认哪些信息”，不表示消费者已经提供值，也不表示退款、改址、取消、补发或任何平台动作已经完成。

`GET /api/companies/:companyId/conversations/:id/handoff-brief` 是纯读取入口；不要求或接受正文、字段值、运行编号或业务动作参数，不调用模型、控制器或平台。读取前后重新核对当前验证 session、公司成员和店铺访问权，并绑定同一控制目录；撤权、跨公司、目录变化或损坏投影均不返回历史摘要。公开 DTO 只包含原运行编号、固定用途/收集状态、受限原因、摘要、建议确认项、投影序号、时间和 `open/resolved/superseded` 状态。

消息中心在当前处理区展示该简报，清楚标注仅收集本次咨询必要信息。刷新只 GET 原投影；人工命令成功后使简报查询失效并重读，不重放 AI 工具。当前没有新增让客服录入结构化客户值的表单，也没有定义手机号、地址、证件或支付资料字段，更没有自动把消费者消息解析为已收集值。R09 后续必须先确认字段、目的、保留期和可见角色，再实现值级持久化、修订/撤回和处理闭环；本节只交付安全的人工跟进要求入口。

### 7.39 R09-2：人工核对回执

迁移 `0048_handoff_follow_up_review.sql` 新增最小化、不可更新的 `handoff_follow_up_review`。每个控制器/AI 运行最多一条回执，只保存源 handoff 序号、幂等命令号、执行核对的用户/成员、显示名和时间；不保存消费者字段值、消息正文、订单号、联系方式或平台动作结果。会话按既有删除策略清除时回执随控制目录级联删除，不能单独修改既有记录。

`POST …/handoff-reviews` 只接受 UUID 命令号、固定动作 `acknowledge_requirements`、原运行号和预期投影序号。成员编号只能来自规范请求头。写入语句再次核对当前 session、邮箱验证、公司成员、店铺授权、源回执、最新 AI 边界和会话未解决状态；迁移级插入守卫独立复核源事件、当前成员资格及没有更晚 AI 边界。撤权、成员替换、运行/序号变化和已被后续 AI 取代均不能写入。

相同成员使用同一命令号重放时得到同一回执；并发重复最多写一行。响应丢失后，页面保留命令号重试，或通过只读简报恢复已持久化结果。其他命令号不能把已有核对据为己有。公开回执固定返回 `customerDataCollected=false` 与 `businessActionCompleted=false`；“已核对”只说明员工看过跟进要求，不说明消费者提供资料，也不完成会话或任何 Ozon 操作。按钮只在当前开放、未取代且未核对的简报出现。

这仍不是值级资料收集。允许字段、用途、保留期、修订/撤回和人工业务完成证据尚未定义，因此 R09 不整项关闭。

### 7.40 R09-3：不复制正文的跟进项证据与修订

迁移 `0049_handoff_follow_up_items.sql` 新增仅追加的 `handoff_follow_up_item_event`。每个 handoff 要求按原数组下标维护独立 revision，状态仅可为 `pending/evidence_linked/not_required/unavailable`。`evidence_linked` 只保存同会话消费者后续入站消息的内部编号；正文、附件、联系方式、订单号和模型解析值均不复制。证据消息删除时关联事件按既有消息删除边界级联，整段会话删除时全部跟随控制目录清除。

`POST …/handoff-items` 只接受固定动作、幂等命令号、原运行/序号、要求下标、预期 revision、受限状态及可选消息编号。数据库守卫和最终写语句同时要求：源事件是当前 handoff、下标确实存在、会话开放且未进入新 AI 边界、操作者仍有当前 session/成员/店铺权限；证据必须是同一会话中、原 AI 输入 revision 之后追加的 `Customer/inbound` 消息。旧消息、出站消息、其他会话、任意值字段和伪造 revision 不能写入。

事件不可更新；改为无需收集、暂未提供或撤回标记都会追加新 revision，不覆盖历史。相同命令并发/重放返回同一事件，其他载荷复用命令号冲突。页面只从当前已显示消息中选择证据，服务端不信任该列表并独立复核。公开响应固定 `customerDataCopied=false`、`businessActionCompleted=false`；消息关联只证明员工选择了某条后续消费者消息，不验证正文事实、订单归属、身份或业务动作。

该设计完成了人工侧最小化证据链接、修订/撤回和刷新恢复，但 AI 的 `neededInformation` 目前仍是受长度限制的自由文本。允许需求类型、敏感要求拒绝规则和产品留存值尚未确认，因此不能把 R09 标为整包完成，也不能向模型开放订单、地址、电话、证件或支付资料的结构化收集。

### 7.41 R09-4：允许类型、留存和人工处理闭环

新启动的 Flue `request_handoff` 工具不再接受自由文本摘要或字段名；摘要由应用按受限原因生成。模型只能从 `product_model`、`issue_description`、`desired_resolution`、`usage_context`、`photo_or_video` 五种非身份、非支付类型中选择，最多五项且不得重复；工具在持久回执中写入 `schemaVersion=2`。订单编号、地址、电话、邮箱、身份文件、凭据、支付信息和任意自定义字段均不在 schema 中；工具说明同时明确禁止，但最终安全边界是 schema 拒绝而不是依赖模型服从。既有冻结 `promptVersion` 文本不在本增量中静默改写。

部署前已经存在的自由文本 handoff 回执继续按原 `AiReceipt` 合同读取，公开为 `legacy_read_only/legacy_unspecified`；它们不能新增逐项证据或处置事件。这样保留历史审计和升级兼容，又不会让旧自由文本成为绕过新白名单的写入口。系统超时、回答审核和回复准备失败产生的新 handoff 也统一写 v2；无消费者资料需要时使用空要求列表。

R09 的资料处理采用“引用而不复制”作为最终首版字段策略：五种类型没有独立 value 列，员工只能关联原输入 revision 之后的消费者入站消息编号，或记录无需收集/暂未提供。用途固定为 `human_follow_up`，可见角色固定为当前已验证、且仍有该店铺访问权的公司成员。留存不设第二套期限：核对和逐项事件跟随源会话/消息生命周期；证据消息或会话按后续统一删除流程移除时关联记录级联清除。R20 仍负责全产品正式时间期限与删除作业，但 R09 不再阻塞于一个独立且可能漂移的保留值。

人工流程状态由持久事实派生：尚未核对或仍有 pending 项为 `pending`；员工核对且每项均有处置后为 `ready_for_human_decision`；后续 AI 边界为 `superseded`；人工使用既有会话 `resolve` 命令后为 `closed`。就绪不自动解决会话、不发送消息、不调用 Ozon，也不把 resolve 解释为退款、改址、取消或其他业务动作完成；公开 DTO 始终固定 `businessActionCompleted=false` 和 `customerDataCopied=false`。

至此 R09 在本地首版范围完成：受控工具、用途、允许类型、持久证据、刷新/丢回执/并发重放、修订/撤回、成员替换/撤权、人工就绪与关闭语义、敏感最小化和删除绑定均有确定合同。真实模型是否在俄语场景正确选择类型仍属于 R11，真实平台业务动作本来不在本工具权限内，正式全产品留存期限与删除执行属于 R20；这些边界不重新打开 R09。

### 7.42 R14-1：内容最小化的会话操作日志

新增 `GET /api/companies/:companyId/conversations/:id/activity`，从不可变 `conversation_control_event` 投影读取控制历史。首批覆盖认领、接管、解决/重开、工作状态、转交、内部备注存在、人工/AI 回复提交、取消、AI 启动/恢复/等待/分类/派发停止、转人工和消费者输入事件。事件按控制 sequence 倒序分页，首读冻结当前 sequence；cursor 绑定公司、会话、控制器、当前成员和快照，后续新事件不能插入旧分页，成员替换不能继承旧 cursor。

接口在查询前、SQL 内和返回前核对当前验证 session、公司成员和店铺访问权，并校验每份持久 receipt 与事件 action、command、sequence 一致。公开 DTO 只返回事件类别、动作、时间、操作者当前存在/已移除状态、操作后的控制状态和可选发送投影；不返回消息正文、内部备注、回复正文、翻译、模型输入、完整 receipt、供应商 payload 或原始错误。发送投影明确区分人工/AI 来源及 queued/sending/sent/failed/unknown/skipped/canceled，并仅把持久 provider success 标为明确接受。

消息中心新增“操作日志”对话框，显示有界分页和当前投影。平台原文仍在原消息区域，不复制到操作日志；内部备注正文仍在独立受限入口。该增量建立 R14 的控制事件骨架，但尚未完成按时间/店铺/渠道/阶段/负责人/接待方式/发送结果/策略版本筛选，也未把 AI 草稿、译文、外发尝试历史和平台原始消息合并成完整业务时间线，因此 R14 仍为进行中。

### 7.43 R14-2：事件类别、动作与时间范围筛选

操作日志 API 增加可选 `category/action/from/to`。类别只能是全部、人工、AI/系统、消费者事件；动作必须来自控制事件白名单；时间使用非负毫秒并要求 `from < to`，采用 `[from,to)`。所有筛选值写入 v2 cursor，换筛选条件重放旧 cursor 明确返回无效请求，不能把另一范围的分页位置误用于当前结果。

SQL 在 limit 前应用类别、动作和时间条件，仍受冻结控制 sequence 限制。前端首批开放类别选择；动作和时间合同先供后续公司日志页复用。日志条目增加仅布尔型关联记录标志，区分平台消息、内部备注、AI 草稿、翻译确认和回复意图的存在，不返回这些记录的正文。AI 草稿标志只在持久 `ai_answer` 与原 handoff 运行关联时成立，不能从模型措辞猜测。

该增量完成每会话事件类别/动作/时间过滤基础，仍没有公司级店铺、渠道、业务阶段、负责人、接待方式、发送结果与策略版本组合筛选；R14 继续进行中。

### 7.44 R14-3：公司级会话日志与组合筛选

新增 `GET /api/companies/:companyId/conversation-activities`，跨当前成员有权店铺读取控制事件。接口支持店铺、事件类别、动作、半开时间范围、业务阶段、当前负责人、当前接待方式、当前会话状态、发送结果、策略 ID/修订和渠道组合筛选；当前数据模型只有 Ozon 私聊，因此渠道唯一合法值为 `private`，不伪造未接入渠道。

公司分页使用 `conversation_control_event.rowid` 冻结首读快照，再按 `projected_at/controller_id/sequence` 稳定倒序翻页。Cursor 固定全部筛选、成员及授权店铺集合 SHA-256；授权店铺增加或撤销后，旧 cursor 失效，避免新授权记录插入旧分页或撤权后继续翻页。每次读取前后都重读有效 session、已验证用户、公司成员和完整授权店铺集合；SQL 本身也逐事件应用 `storeAccess`。普通成员看不到未授权店铺，撤销全部店铺权后得到空结果而不是其它店铺元数据。

业务阶段和策略版本只从已持久 `ai_execution.payload.run.admission` 读取；没有关联运行的人工事件不会被猜测归类。发送结果只来自持久 `send_intent.state`。负责人、接待方式和会话状态明确筛选当前 `conversation_control` 状态，不声称它们是事件发生时的状态；事件发生后的状态仍由每行已校验 receipt 的 `appliedState` 表达。

消息中心增加“公司日志”对话框，提供授权店铺、类别、阶段、本人/未分配负责人、接待方式、会话状态、发送结果及策略筛选，并可回到对应会话。响应继续只返回内容最小化事件、店铺名和平台会话 ID，不复制正文或供应商数据。R14 尚缺平台原始消息、AI 草稿/译文内容入口和完整外发尝试历史的统一时间线。

### 7.45 R14-4：冻结的完整业务时间线与 AI 运行结果

新增 `GET /api/companies/:companyId/conversations/:id/timeline`，在同一倒序时间轴明确区分六类来源：平台原始消息、不可变控制动作、AI 草稿、人工回复翻译预览、真实外发意图和平台发送回执。平台消息显示源记录正文；AI 草稿显示已持久答案和知识依据的文档标题/修订，不返回 citation 正文、模型提示词或内部路由；翻译显示原文、已确认译文和费用状态；外发意图显示实际确认发送的正文；平台回执只在 `send_attempt.finished_at` 已进入快照时出现，并区分明确接受、失败和未知，不把 HTTP 尝试或排队冒充送达。内部备注仍只显示动作存在，正文留在原受限备注入口。

首读同时冻结控制 sequence、消息 append sequence、AI 答案/翻译/发送意图/发送尝试 rowid 和 `snapshotAt`。六路来源各自在 SQL 中应用快照与翻页边界，合并后按 `occurredAt/id` 稳定排序；后续新增消息和完成回执不会插入旧分页。发送尝试在快照时尚未完成时只显示当时可证明的 queued/sending，不使用快照后的完成状态倒灌历史。每页读取前后复核当前会话、成员和店铺权限。

R14 三类 cursor 均升级为以服务端身份 Secret 执行且绑定当前数据库 session ID 的 HMAC-SHA-256 签名；篡改快照、筛选、边界或签名会被拒绝。公司 cursor 继续额外绑定授权店铺集合哈希，跨 session、成员替换和授权集合变化均不能续页。

控制活动增加结构化 `aiRun` 投影和公司级 `aiResult` 筛选。结果固定为 `open/drafted/reply_submitted/handoff/completed/failed/aborted/unconfirmed/closed_without_output`，只从持久 AI execution、answer、reply intent、handoff 和 closure 推导；业务阶段、策略 ID/修订同样只读 admission 证据。公司页面补齐动作、精确毫秒时间、指定负责人及 AI 运行结果筛选；当前唯一渠道仍为 `private`。

消息中心新增“业务时间线”入口。正文直接读取原业务表，不新增日志正文副本；公司日志继续无正文，只负责筛选并跳转会话。至此 7.1 的时间、店铺、渠道、阶段、负责人、接待方式、状态、发送结果、策略版本和 AI 运行结果过滤，以及 7.2 的六类时间线区分均已落地，R14 本地首版完成。

### 7.46 R15-1：冻结的会话汇总 CSV

新增经理专用 `POST /api/companies/:companyId/exports/csv`，首批只接受 `kind=conversations`，范围固定为全部当前筛选、当前页 ID 或明确选择 ID。筛选合同复用消息中心的店铺、队列、工作状态和精确会话/订单查询；页/选择范围最多 100 个不重复会话，服务器重新应用筛选与当前权限，任一 ID 已移出范围则整体返回冲突，不静默少导。

会话汇总由一条 D1 statement 同时取得当前 owner/admin、公司时区、`snapshotAt` 和最多 5,001 个候选，避免查询间筛选漂移。首版本地同步下载上限为 5,000 行和 8 MiB；超过任一上限明确要求后续异步导出，不截断。字段包括店铺、会话/渠道/平台引用、最新业务阶段、当前负责人和工作状态、平台状态、创建/最近消息/解决时间、人工与 AI 明确回复数、最近转人工原因及未知发送数。只有 `send_intent.state=sent` 计入明确回复，unknown 单列。

CSV 固定 UTF-8 BOM、CRLF 和 `@json2csv/whatwg@7.0.8` 的规范引号/换行转义。所有字符串在不改写原数据库值的前提下先以 NFKC 副本检测；跳过前导空白、控制字符和常见不可见字符后若以 `= + - @`（含全角变体）开头，则只在导出单元格前增加单引号。该防护覆盖普通文本、名称和标识，不依赖字段被认为“可信”。

迁移 0050 新增无正文 `conversation_export_audit`，在文件生成后再次核对当前 session、验证邮箱、原成员和 owner/admin 权限才写入；记录冻结筛选、选择 ID、筛选哈希、导出人快照、行数、字节数、文件 SHA-256 和时间。actor ID 不设删除外键，成员移除不销毁既有导出审计；公司删除则级联清理。响应只有审计写入成功才返回 CSV。

消息中心为 owner/admin 提供“全部筛选结果、当前页、当前会话”三个入口；普通成员默认无 export 权限。该增量完成会话汇总的小型同步导出，消息明细 CSV 尚未实现，R15 继续进行中；R16 仍负责超过本地边界的冻结快照、私有 R2 和导出中心。

### 7.47 R15-2：消息明细 CSV 与 R15 收口

同一严格请求合同新增 `kind=messages`，三种范围与会话汇总完全一致。单条 D1 statement 先冻结有权会话集合，再合并两类明细：平台原始消息和共享发送管道的实际 outbound intent。平台记录导出原始内容数组、方向、发送者、平台消息编号、发生/接收时间；outbound 记录导出人工/AI 来源、翻译前原文、已确认译文、最终发送正文、发送/回执时间、状态、HTTP 状态和平台明确接受证据。

AI outbound 额外只导出持久 admission 的语言、策略 ID/修订，以及 citation 的 `documentId@revision#chunkId` 版本标识；不导出 citation 正文、提示词、知识正文、供应商 payload 或原始错误。内部备注默认不导出。平台消息与 outbound intent 可能描述同一次业务沟通，但 `record_type` 保留来源差异，不通过不可靠正文/时间猜测合并。

消息明细复用 5,000 行/8 MiB 边界、UTF-8 BOM、CRLF、WHATWG 转义、全字段公式防护和 0050 审计。空会话仍能生成只有表头的有效文件；页/选择范围按会话数验证，不能因当前无消息把合法会话误判越权。消息中心的导出菜单分别提供会话汇总和消息明细的全部筛选、当前页、当前会话入口。

至此 R15 的两类 CSV、三种范围、冻结筛选、权限复核、中俄文本、换行/引号和公式注入防护均已落地，R15 本地首版完成。超过同步边界的 100,000 行任务、私有 R2、生成/下载阶段重新验权、过期和恢复继续属于 R16。

### 7.48 R16-1：导出作业数据库与私有 R2 适配

迁移 0051 新增 `export_job` 与 `export_row`。作业冻结 kind、范围、筛选、选择 ID、创建时全部有权店铺、筛选哈希、请求成员快照、`snapshotAt`、过期时间和状态修订；临时行以 `(job_id,ordinal)` 唯一并保存当时生成所需的有界 JSON payload。行号上限 100,000，payload 单行上限 1 MiB。公司删除级联作业，作业删除级联临时行；请求成员不设删除外键，离职不能抹除历史主体。

状态固定为 `queued → snapshotting → generating → ready`，另有 failed/canceled/expired。后台以短租约 token 领取，追加快照行、进入生成、完成或失败均比较原租约和当前状态；重复领取、旧 worker 和错序完成不能覆盖新状态。只有数据库中恰有声明数量的临时行才能进入 generating。ready 必须同时具备对象键、行数、字节数和 SHA-256；进入 ready 后删除 D1 临时行。过期先枚举 ready 对象，R2 删除成功后才以 revision CAS 清除对象引用并标记 expired。

新增可选 `EXPORTS_BUCKET` 类型及 R2 适配器。对象键固定为 `exports/{job UUID}/{sha256}.csv`，不在 key 暴露公司或会话标识；put 前拒绝同 key 已存在对象，put 后以 `head` 正面核对字节数和自定义 `schemaVersion/jobId/organizationId/sha256`，不匹配则删除并保持未确认。读取同时复核 key、大小和全部元数据；bucket 缺失时明确不可用，不退回公开 URL 或 D1 blob。账号实际返回 R2 未启用；用户明确拒绝开通和支付，因此默认部署配置不声明 R2 binding，也不创建云资源。将来只有运营者主动提供私有对象存储时才增加 `EXPORTS_BUCKET`；适配器保留为可选能力，不影响免费配置构建运行。

创建作业只允许当前 owner/admin，并在写入同一时点重新比较完整店铺集合；读取要求当前 owner/admin 且冻结店铺仍存在。首版保留期参数限制在 1 分钟至 7 天，默认 24 小时。该增量完成数据库状态机和可选 R2 适配，但尚未接入快照分批生成、Queue/DLQ、导出中心、授权下载、取消/重试和 100,000 行云端验证，因此 R16 继续进行中。免费配置继续使用 R15 的 5,000 行/8 MiB 同步导出；不以 D1、KV 或 Durable Object 冒充大文件对象存储。

### 7.49 R17：基础分析与公开指标口径

新增管理者只读 `GET /api/companies/:companyId/analytics/overview`。接口接受可选 `storeId` 及公司本地日期 `fromDate/toDate`，日期范围固定为 `[from,to)`；缺省为公司时区当天，最长 366 个日历日。IANA 时区边界在服务端换算，春季/秋季 DST 日分别允许 23/25 小时。读取前取得时区，最终统计语句再次验证同一时区、owner/admin session 和完整店铺授权；设置或权限在两步间变化时失败关闭。

全部指标在一条 D1 statement 的同一 `snapshotAt` 计算。新增会话使用平台创建时间，不使用导入时间；已解决使用期间持久 resolve 事件并同时给出去重会话数和事件数；当前积压只统计当前 open + needs_reply，是存量而不与期间流量相加。首次响应 cohort 是期间发生全生命周期首条平台入站的会话，响应只接受平台 outbound 消息或 sent attempt 的确认时间，内部备注、草稿、queued/failed/unknown 不算；未响应会话单列，平均/P50/P95 只计算非负已响应时长。

转人工分母是期间创建 AI reception execution 的去重会话，分子是其中期间有持久 `request_handoff` 控制事件的去重会话；回复测试、翻译和模型建议文字不算实际转人工。发送失败分母只含期间完成且明确 sent/failed 的 attempt；failed 为分子，unknown 与 sending 单列。所有比例在分母为零时返回 null，页面展示“无数据”，不得显示 0%。

AI 用量按接待生成/嵌入、翻译预览、问答测试生成/嵌入五类持久 provider claim 分列。只汇总已记录的 input/output/cache tokens，不推断缺失 token；费用只汇总持久冻结估算，分别公开 cost-known/cost-unknown claim，并固定 `supplierCostsVerified=false`。Gateway、内部估算和释放零费用都不冒充供应商发票。

响应内嵌 `analytics-v1` 数据字典，逐指标公开分子、分母、排除项、时区、端点和零分母规则。公司设置页展示新增、解决、当前积压、首次响应、转人工、发送失败和 AI 用量，并可展开完整口径。接口和日志不包含客户正文、提示词、供应商 payload 或错误文本。

### 7.50 R18-1：独立自部署与开源交付骨架

新增贡献、自部署、升级/回滚和故障排查文档。干净检出路径固定 Node 24.14.0、`npm ci`、本地 D1 迁移、全套检查和显式 `.dev.vars`；云部署由部署者自己的 Cloudflare/D1、邮件、Ozon 和可选模型账号组成，不存在 DingBell 商业账号、中心许可证检查或必需遥测主机。所有模型、翻译、知识索引、AI 接待和外发开关继续默认 false；当前默认 Wrangler 无 R2 binding。

升级文档固定 D1 迁移先于匹配 Worker、Durable Object tag 只追加、外部开关先关闭、未知请求不重放，以及 D1/DO/Workflow/R2/密钥必须作为整体恢复范围。旧 Worker 只有在理解新版已持久状态时才能回滚；不可删除审计/财务事实或用 ad-hoc DROP 冒充回退。

`THIRD_PARTY_NOTICES.md` 记录直接运行依赖、字体、图标和 Figma/Obra 来源。`license-inventory.mjs` 从 lockfile v3 核对 905 个锁定包的版本、integrity 和 license metadata，并显式列出 LGPL/MPL/CC-BY/Python 等待发布复核表达式，可生成机器清单到忽略的 `dist/compliance`。这只是工程清单，不替代许可证全文、NOTICE 和法律复核。

`check-release.mjs` 核对交付文档、Node 版本、安全忽略项、可选 R2 未绑定及六个外部功能默认关闭。DingBell 自身许可证 D-04 仍未由用户确认，因此仓库不添加 LICENSE、保持 `private:true`，release check 明确失败为 `project license pending owner decision`。不能把文档骨架或第三方 metadata 完整误报为开源发布完成。

### 7.51 R20-1：数据治理现状与删除失败关闭

新增 manager-only `GET /api/companies/:companyId/data-governance` 和公司设置页状态面板。它是无正文的治理能力清单，不是删除命令。响应固定 `governance-v1`，将架构建议的业务副本 90 天、审计 180 天、原始回调/AI 原始轨迹 7 天、导出 24 小时明确标为 `pending_operator_approval`，并固定 `automaticDeletionEnabled=false`；D-06、法务/审计期限、备份和恢复合同批准前不运行定时删除。

资源矩阵逐项列出 D1 身份、会话、知识、AI 执行、财务、导出，控制 DO、Flue DO、Vectorize、可选 R2、未实现 SEARCH_DB 和备份。每项只公开是否含客户内容、当前 readiness 和必须取得的证据。完整公司删除固定 `available=false`、`accessDisablementImplemented=false`、`businessActionCompleted=false`；不能以 D1 部分 cascade、同步 CSV 不留服端文件、默认没有 R2，或某个 DO 的删除接口冒充全链路删除。

内容边界固定声明应用内容 tracing 关闭、运维日志不保存客户正文、真实 AI Gateway payload 关闭状态仍为 `external_configuration_unverified`，且 `supplierInvoiceVerified=false`。新增源码门禁扫描全部生产 TS/TSX，拒绝 console 内容记录器和 Sentry/OpenTelemetry/New Relic/Datadog/Application Insights 依赖；HTTP 诱饵验证未知 query 值不会回显。该检查证明当前应用代码边界，不证明 Cloudflare 账号、Gateway、边缘日志或外部备份配置。

删除编排尚未实现，因此没有新增危险的删除 API、没有停止公司访问、没有清理业务数据，也没有创建“完成凭据”。后续必须先实现跨资源不可逆状态机和访问禁用，再逐项验证恢复中断、后台任务不再生成数据以及备份到期。

### 7.52 R19-1：技术用量与 AI 业务回复双口径

`analytics-v1` 在同一 D1 statement 快照中增加 `businessUsage`。技术台账继续只汇总五类持久 provider claim、已报告 token、冻结估算费用和未知费用；不叠加 Flue 实时观测、Gateway 日志或预算汇总层。业务台账只把 `send_intent.schema_version=2` 且对应持久 `send_attempt.state=sent`、`finished_at` 位于区间内的唯一意图计为确认 AI 外发。

人工 schema 1 的 sent 意图只报告排除数量；AI unknown 意图单列，queued/sending/failed、模型生成、草稿、工具提交和 HTTP 尝试都不计业务量。`send_intent` 的 `(controller_id,id)` 主键及 AI 固定 `ai-reply:{runId}` 身份防止重复成功回执叠加业务量。页面明确并列展示“确认 AI 外发业务量”和“AI 技术用量 claims”，避免把模型请求次数当作回复数。

该增量仍固定 `supplierCostsVerified=false`。技术估算与业务发送可由持久记录复算，但真实供应商发票、Gateway 外部配置和账单差异尚未验收；因此 R19 继续依赖 R12，不能宣称费用最终核实。

### 7.53 R21-1：全产品降级状态合同

新增 manager-only `GET /api/companies/:companyId/degradation` 和公司设置页状态。读取只观察部署开关、经过严格解析的 Support 配置、当前生效预算的可用金额/运行次数及现有产品边界，不启动模型、不预留金额、不创建发送或导出任务，也不返回密钥或配置正文。

新 AI execution 状态固定为 available/disabled/configuration_unavailable/budget_unavailable。只有总开关、模型/绑定/价格及当前完整运行金额和次数全部满足时才显示 available；其余状态固定 `newAiExecutions=false` 和 `onUnavailable=human_queue`。这不取消或退款已开始运行，既有运行仍按原账本结算。

同一合同固定公开：当前授权下人工处理可用；同步 CSV 仍为 5,000 行/8 MiB；用户拒绝 R2 后大型异步对象存储导出不可用；unknown 发送 `automaticReplay=false` 且必须核对原证据；商业计费为 not_implemented。客户端 strict schema 拒绝服务器把 unknown 自动重放或扩大免费能力。

联合回归实际覆盖预算/配置拒绝后返回人工队列且不重放 admitted run、公共恢复预算门禁、人工接待控制、同步导出以及 unknown 原契约。该增量建立本地降级矩阵，但真实供应商故障、生产并发最后额度、外部告警和真实平台 unknown 核对仍待 R12/最终试点，因此 R21 继续进行中。

### 7.54 R22-1：D1 文件备份升级与恢复矩阵

新增真实 SQLite 文件演练：先只应用 0000—0044，写入合成公司、成员、加密凭据版本、会话和客户消息，再关闭数据库并复制不可变 backup。升级副本应用 0045—当前迁移后逐字核对消息 JSON、凭据 ciphertext/key version/revision、新表和全部外键；原 backup 以只读旧 schema 打开且没有新版表，SHA-256 在读取前后不变；第二个恢复副本从同一 backup 重新应用新版迁移后仍只保留一份原消息。

`test:upgrade-local` 将该演练与凭据 key ring 轮换、0012 带数据失败回滚及 0044 AI intent/attempt 带数据升级/失败回滚串行执行。旧 v1 key 保留时可读取旧 ciphertext，新 v2 只用于新写；移除仍被依赖的旧 key 必须失败，不把不可解密数据当作空凭据。全套只使用合成数据和 OS 临时目录。

新增恢复证据矩阵，分别标记 D1、控制 DO、Flue DO、Workflow/Queue、Vectorize、默认无 R2、未实现 SEARCH_DB、秘密、外部平台及含已删除数据备份。恢复顺序固定先关闭外发/模型，再恢复秘密和 D1，然后恢复或重建其余资源，核对 unknown 发送与费用，最后先开放只读/人工路径。D1-only restore 明确不是完整恢复。

本地 D1/密钥/迁移 16 项通过，但这不证明真实 D1 Time Travel/导出、Cloudflare DO 快照恢复、生产规模时长、Vectorize 重建、备份到期或批准的 RPO/RTO。R22 继续进行中。

### 7.55 R23-1：确定性本地容量夹具

新增 `test:capacity-local`。它在 OS 临时目录创建当前完整 SQLite schema，以固定算法生成 1 公司、3 店铺、10,000 会话、100,000 消息及 10,000 控制投影；内容仅为固定 synthetic fixture。事务完成后核对三表精确数量、全部 foreign keys、3,334 个 needs_reply 积压、10,000 个首入站 cohort，以及会话首屏恰好 51 个候选。

EXPLAIN 必须显示默认公司会话首屏使用 `conversation_org_time_idx` covering index，否则脚本失败。脚本记录 seed、首屏、积压和首入站聚合的墙钟观察值及进程 RSS；默认只输出 JSON，`--write` 才写入忽略的 `dist/compliance`，临时数据库无论成功失败均删除。

本机 Node 24.14.0 本次观察：seed 约 30.53 秒，51 条首屏约 0.23 ms，当前积压约 3.83 ms，10,000 会话/100,000 消息首入站聚合约 45.26 ms，RSS 约 49.5 MB；外键错误为零。数字只用于发现本地回归，不设置产品 SLA，也不能外推到 D1 串行执行、Workers CPU、网络、并发租户、队列公平性或生产地区。R23 的真实 10/50 条每秒、P95、100,000 行异步导出、长时间故障及依赖审计仍未完成。

### 7.56 R06-1：旧知识向量清理状态机

迁移 0052 新增 `knowledge_vector_cleanup`。候选必须是既非 `draft_revision` 又非 `active_revision` 的不可变历史修订，且 revision 的 index/published profile 与当前固定 profile 匹配；当前草稿或当前发布修订不能排队。恢复历史资料仍通过创建新 revision 完成，因此不会把已排队的旧 chunk ID 重新变为当前 ID。

每个 chunk 的 draft/published 两个精确 SHA-256 vector ID 冻结在无正文 JSON 中，单任务最多 32 个 ID。主键按公司、文档、修订和 profile 去重；领取使用 claim token、60 秒租约、最多 20 次尝试及指数退避。Vectorize `deleteByIds` 返回 mutation 只进入 `confirming`，不能冒充已删除；后续 `getByIds` 必须确认所有冻结 ID 均不可见才进入 `succeeded`。旧 Worker、过期 token 或租约不能结算新状态，供应商异常只保存固定 `VECTOR_OPERATION_FAILED`，不复制 payload。

删除范围仅是可重建的重复向量。D1 `knowledge_revision`、原始 source JSON、chunk 正文、哈希、发布记录与引用依据都不删除；并发检索仍必须经现有 D1 当前发布快照二次解析。因此该增量不启用 D-06 尚未批准的内容保留删除，也不宣称 Vectorize 全 namespace 清空。

本地状态机/异常最小化 2 项、Vectorize primitive 4 项和 0052 原子迁移 1 项通过。Cron 已按显式 `KNOWLEDGE_VECTOR_CLEANUP_ENABLED=true` 接入，每轮最多扫描/领取 10 项；默认 false。尚缺批准的修订保留期限、真实 Vectorize 最终可见性、全量盘点及 R2 原文件，R06 继续进行中。

### 7.57 R07-1：扩大双语检索语料与大目录夹具

固定语料升级为 `dingbell-semantic-ru-zh-v2`：20 份纯虚构中俄资料、52 个问题、75 个真实 production chunker/query 输入。40 个可回答问题包含 OR26/OR26X、L5/L5 Pro 等近名资料、4 个跨语言查询及 2 个答案位于多 chunk 长手册末尾的查询；12 个困难负例明确缺少实时订单、库存、折扣或个人审批事实。Calibration/holdout 各固定 20 个正例和 6 个负例。

计划哈希继续冻结 corpus、label、模型/profile、精确输入和评分设置；上限扩为 128 输入、64,000 UTF-8 bytes，单次模型批次仍不超过 16。缺行、重复 key、旧 dataset hash、错误 profile/model、维度、NaN、全零向量全部拒绝。报告保留每个误命中，`unsupportedAboveThreshold` 不等于回答错误率；`answerQuality` 固定 `not_evaluated`，相似度不能证明段落含有事实。

另有不调用模型的 10,000 文档临时 SQLite 大目录夹具。它应用当前全部迁移、事务写入双语 synthetic documents/revisions，核对外键、首/中部 keyset 页各 21 条和查询计划使用 knowledge document/revision 索引，最后删除数据库。本机 Node 24.14.0 观察 seed 约 304 ms、首屏约 0.18 ms、中部语言筛选约 0.08 ms、RSS 约 46.7 MB；只用于固定夹具回归，不能外推 D1、Vectorize、Workers、并发或 SLA。

本地评估/目录合同 8/8 通过，未发起真实模型调用。真实 BGE-M3、Vectorize approximate ranking、至少 200 例独立语料、俄语人工事实审核及云端大目录性能仍待完成，R07 继续进行中。

### 7.58 R10-1：主动通知时间与发送前门禁合同

新增不产生外发的纯调度合同。它只接受已通过现有 strict notification policy schema 的事件、延迟、到期、每日上限、静默时段和模板；公司 IANA 时区在计算时验证。静默时段同时覆盖同日和跨午夜区间，并按实际可观察本地分钟推进，因此 DST 春季缺失小时和秋季重复小时都不会提前发送。

`dueAt` 与绝对 `expiresAt` 分开保存语义：静默期可延迟 due，但不得延长事件到期；若静默期结束已越过 expiry，则固定 `expiredBeforeDue=true`。模板只替换 `store_name/order_number/tracking_number` 三个声明变量，缺变量、额外字段、空值、超长值或非法 Unicode 全部拒绝。

发送前门禁按顺序重验规则仍启用、published revision 未变化、源事件未取消、已到期但尚未过期及公司本地日发送次数未达上限，结果分别为固定原因或 `ready`。该函数只生成判断，不创建 send intent，也不会绕过统一发送管道；当前平台 `proactive_chat` 能力仍为 unknown 时不得据此外发。

本地 4/4 覆盖跨午夜、同日静默、Europe/Berlin DST gap/fold、到期、模板字段、暂停、规则变化、取消、未到期、过期和每日上限。尚缺事件持久状态机、真实订单状态来源、延迟队列、取消接线及真实平台主动会话能力，R10 继续进行中。

### 7.59 本地演示账号（仅 local D1）

新增 `npm run demo:local`，用于在不配置真实邮件时查看已认证 UI。命令先应用本地迁移，再校验 `.dev.vars` 仅使用 `http://127.0.0.1:5173` 且存在至少 32 字符身份 secret；Wrangler 配置必须仍是 `dingbell-local-only`，执行参数固定含 `--local`，不存在 remote 分支。

账号邮箱固定为不可投递的 `demo@dingbell.invalid`，密码首次运行随机生成并仅写入 git 忽略的 `.dev.vars.demo-account.json`（0600）；数据库保存 Better Auth 哈希而非明文。脚本以固定 local IDs 幂等创建一个已验证 owner 和一个演示公司，碰到同邮箱、slug、账号或成员身份冲突时事务失败，不接管其他本地身份。删除 credential 文件后重跑会轮换密码。

该能力没有 HTTP seed 路由、默认共享密码或生产开关；不能指向远端 D1，不能替代 `/setup`、真实邮箱验证、邀请或 R03 的邮件生命周期验收。脚本语法、类型和差异检查通过，未替用户写入本地账号。

### 7.60 多店铺平台选择与页面凭据配置

店铺管理主操作改为通用“添加店铺”。第一步显示平台选择器；当前唯一可选项为 Ozon，并明确同一公司可重复添加多个卖家账号。选择 Ozon 后进入既有严格表单，填写店铺名称、1—32 位数字 Client ID 和 API Key。每个账号仍生成独立 store UUID，以 `(organization,platform,platform_store_id)` 阻止同公司重复连接，但不限制不同 Client ID 的多店铺。

Ozon API Key 只从当前页面提交，经服务端 AES-256-GCM envelope 加密后写入 D1，响应、列表、详情、浏览器 storage 和日志均不回显。`.dev.vars` 仅保存独立的本地 envelope 主密钥，不保存 Ozon Client ID/API Key。更新凭据继续只接收新 API Key 并清空旧能力证据。

桌面和空状态入口均进入相同平台选择流程；店铺详情页保留顶端添加按钮，可继续添加下一家。TypeScript、生产构建和差异检查通过。Playwright 店铺套件已同步新两步流程，但当前机器缺少对应 Chromium 1248 二进制，6 项均在 browser launch 前失败，不能记为 UI 通过。

### 7.61 商品、FBS 订单独立只读视图与真实同步复验

新增当前成员授权范围内的只读 commerce API：商品列表/详情与 FBS 包裹列表/详情均要求公司、有效 session、已验证邮箱及当前店铺访问权；列表使用绑定公司、店铺、筛选的严格游标，每页最多 50 项。DTO 仅投影白名单事实，不返回 D1 原始 JSON、消费者资料、地址、电话、凭据信封或供应商 payload。商品展示 Ozon ID、货号、SKU、详情状态、价格观察值和 FBO/FBS 库存存在标记；包裹展示订单/包裹编号、平台原始状态、追踪号、时间及商品快照。观察价格、库存和状态均不冒充实时承诺。

新增 `/workspace/products` 与 `/workspace/orders`，导航分别显示“商品资料”和“FBS 订单”。商品支持店铺切换、分页、详情及知识导入边界提示；订单支持店铺切换、完整订单号精确筛选、分页、包裹详情和商品明细。FBS 页面明确只覆盖当前持久同步窗口，不表示完整历史订单账本，不包含 FBO、退货、财务结算或消费者归属证明。

真实授权本地店铺复验发现 Ozon `/v4/posting/fbs/list` 已将商品价格改为 `{amount,currency}`，而 `/v3/posting/fbs/get` 仍返回平铺 `price/currency_code`。适配器现严格接受这两种端点各自的金额形状，继续拒绝指数、负数、数字金额、非法币种和缺字段对象。修复后会话、商品与 FBS 三个来源均完成真实只读同步且无来源错误；只记录数量/状态验证，不保存诊断响应。整个过程保持 `OUTBOUND_ENABLED=false`、`AI_RECEPTION_ENABLED=false` 和店铺 `outbound_enabled=0`，没有发送客户消息。

### 7.62 会话日志独立入口

R14 的公司级最小化日志此前只通过消息中心“公司日志”弹窗开放，侧栏“会话日志”仍是占位项。现新增 `/workspace/activity` 独立页面并启用导航，复用既有权限绑定、HMAC 游标和最小化投影。页面支持店铺、类别、动作、会话状态、接待方式和半开时间范围筛选，可分页打开对应会话。

日志仍只记录控制事件；同步成功本身不伪造人工业务动作。页面不展示消息、备注、草稿、译文、供应商响应或 API Key 正文，且不会触发模型、订单变更或客户发送。当前没有控制事件时显示真实空状态，而不是用同步记录填充日志。

### 7.63 商品图片只读同步与安全展示

Ozon `/v3/product/info/list` 的 `primary_image`、`images` 和 `color_image` 进入商品详情白名单。服务端最多保留 20 个去重 URL，只接受无用户信息、密码、端口和 fragment 的 HTTPS `ozone.ru` 子域地址；任意其他主机、HTTP、超长 URL、非数组或超过数量上限均使整批响应失败，不将未知 URL 传给浏览器。`images360` 暂不导入。

当前详情事实增加 `primaryImage/images`，无需迁移；旧事实缺字段时返回空图片集。商品列表显示主图缩略图，详情显示有界图库；加载采用 lazy/async 和 `referrerPolicy=no-referrer`，失败时显示本地图标占位，不自动代理、缓存或把图片写入 R2/D1 二进制。图片仍由 Ozon CDN 提供，不能证明永久可用。

授权本地店铺重新执行商品只读同步后，380 项详情全部完成且首屏 50/50 有主图；随机首图 CDN 返回 `200 image/jpeg`。该刷新不调用消息发送、AI 或订单写接口。

### 7.64 消息中心右侧商品预览

消息中心的“商品与订单”侧栏原先只有消息携带 SKU 时才能匹配商品；真实只读数据中 26 条有上下文的消息仅 3 条携带 SKU，另 23 条只有订单号，因此多数右侧商品区显示“没有 SKU”。现有精确订单号已能唯一匹配 FBS orderId 时，服务端从采用的包裹快照取首项商品，并用同店铺精确 SKU 投影匹配唯一商品主记录；匹配不唯一时不选择缩略图。

响应新增有界 `order.previewProduct`，只含 orderId、SKU、货号、名称、可选商品 ID 与已验证 Ozon CDN 主图。直接 SKU 商品也新增主图。页面以 64px 缩略图、商品名、货号/SKU和“查看商品资料”链接展示；没有图片使用本地占位。订单预览明确标注为首项预览，不声称订单只有一项或消费者归属已验证。

真实本地数据复验：26 条上下文消息中 3 条直接商品匹配，10 条取得订单商品预览且 10/10 有缩略图；其余订单在当前 30 日 FBS 导入窗口中没有唯一匹配，不伪造商品。

### 7.65 桌面侧栏图标折叠模式

桌面侧栏由 `offcanvas` 改为 `icon` 折叠：收起后保留 3rem 宽窄栏和右侧边框，所有功能图标、当前项状态、公司切换、账号和退出入口仍可访问；功能全名、分组标题、品牌文字、公司详情和帮助文字只在展开时显示。功能图标在收起状态提供右侧 tooltip，边缘 rail 与顶部按钮均可重新展开。

移动端继续使用完整 offcanvas sheet，不缩成无法触控的图标栏。该改动只影响导航布局，不改变路由、权限、同步或外发状态。

### 7.66 侧栏账户菜单

侧栏页脚不再永久展示独立退出按钮。账户入口改为圆形文字头像、用户名和账号邮箱；图标折叠状态只保留头像。点击账户入口后才打开菜单，菜单重复显示当前用户名和邮箱，并仅提供需要现有未保存内容确认流程的“退出登录”，不会把头像点击转换为页面 URL。Base UI 的 `DropdownMenuLabel` 严格放在 `DropdownMenuGroup` 内，避免打开菜单时触发缺少 `MenuGroupContext` 的运行时错误。头像由名称或邮箱本地生成首字母，不加载第三方头像资源。

### 7.67 DingBell 客服猫品牌标识

首版原创矢量客服猫采用暖白猫脸、猫耳、腮红、青色耳麦及紫色圆角底；因小尺寸细节偏多且视觉更像卡通贴纸，已由 7.68 的几何版本替代。React 内联组件用于登录、安装和工作区品牌位；同几何的静态 `/dingbell-logo.svg` 作为浏览器 SVG favicon。标识不依赖第三方图片、字体、模型运行或外部请求。

### 7.68 几何扁平客服猫 Logo

当前标识收敛为两色几何系统：靛蓝猫头同时构成对话气泡轮廓，薄荷青圆弧、耳罩和话筒构成客服耳机，只保留双眼及一个极简鼻口符号。移除圆角底板、粗黑描边、腮红和写实面部细节，在透明背景、32px 侧栏和 favicon 尺寸下保持清晰。品牌色固定为靛蓝 `#5B5CE2` 与薄荷青 `#55D6BE`，白色仅用于负形面部标记。

### 7.69 消息中心信息降噪

默认会话列表不再把平台会话 ID 当标题。单项仅展示店铺名、最近时间、最新消息发送方与两行预览、处理状态，以及必要的“我负责”或“未分配”提示；其他负责人名称保留为非视觉辅助信息，并在打开会话后的控制区管理。选中后的标题统一为“买家咨询”，来源行只显示店铺和平台。

消息气泡保留发送方、原文和平台时间；导入时间及历史/增量来源移入时间 tooltip，平台消息 ID 与发送者 ID 不再进入默认气泡。右侧默认只展示商品/订单和店铺来源；平台会话 ID、原始类型、导入时间及同步明细折叠在“技术与同步信息”中。异常、暂停或断连仍在默认层级显式提示，不因降噪隐藏风险。

### 7.70 订单商品关联诊断

消息携带订单号不等于对应订单已进入当前只读数据集。关联链固定为“消息订单号 → 同店铺唯一 FBS orderId → 包裹首项精确 SKU → 同店铺唯一商品”；任何一层缺失或歧义都不猜测商品。当前真实数据中 23 条仅携带订单号的消息有 10 条命中 FBS、商品和主图，另 13 条在当前 FBS 快照中没有订单；这些消息日期与已匹配消息重叠，不能只归因为历史窗口，可能是未同步范围或非 FBS 订单，现有证据不能进一步断言。

界面明确区分“消息带订单号”与“已匹配订单”：未匹配时说明无法读取关联商品及可能原因；匹配后的平台 orderId 从默认订单区移至折叠关联依据，避免将技术 ID 当业务主信息。

### 7.71 已发现会话与已导入消息的区别

Ozon 会话发现和逐会话消息回填是两个持久阶段：发现列表会先创建会话及 backfill cursor，消息读取成功后才写入 message 并更新 latestMessage。因此会话卡没有预览不表示存在一条正文为“暂无消息”的消息，而表示该会话目前没有任何已导入 message。

当前本地诊断为 49 个会话：25 个已完成历史回填并有 56 条消息，24 个 backfill `completed=0` 且 message 数量为零。chat source 在最后一次成功读取后连续出现 5 次 `network_error`，按既有故障边界自动停止，未完成 cursor 均被保留。列表文案改为“消息尚未导入”，会话详情优先提示上次同步失败和前往店铺管理重试，不再把同步中间态表达成业务空消息。

### 7.72 刷新时的工作区恢复状态

浏览器硬刷新会清空 React Query 内存状态，但认证仍保存在 HttpOnly session cookie。前端不能读取该 cookie 并自行假设登录有效，必须依次重新确认安装状态、服务端 session 和当前公司成员资格；权限撤销时继续显示旧工作区会泄露受保护数据，因此身份确认完成前仍失败关闭。

原通用 LoadingPage 复用登录页 AuthFrame，视觉上容易误解为退出登录。`/workspace` 及其子路由现在使用不含用户名、公司或业务数据的 WorkspaceLoadingPage：保留中性侧栏、顶部栏和内容骨架，并显示“正在恢复工作区”。认证页继续使用 AuthFrame。该调整不缓存身份或绕过服务端复核；若复核最终无 session，仍正常转到登录页。

### 7.73 原子工作区启动与并行预载

原身份冷启动依次调用 setup、get-session、companies；其中 get-session 与 companies 分别执行一次 Better Auth session 验证，之后才触发当前 lazy route 下载。本地暖请求串行实测约 92–134ms，尚未包含分包与页面数据。

`GET /api/workspace-bootstrap` 现在以一个 `Cache-Control: no-store` 响应返回 setup、经一次服务端验证的 session、公司列表及已重新核对的 activeCompanyId。未配置或匿名状态返回 session/companies null；客户端严格验证 session 与 companies 同时存在、activeCompanyId 一致且属于公司列表，矛盾快照不进入缓存。原独立 API 保留给管理与兼容调用。

客户端冷启动只发一个身份请求，并在请求期间对根路径或当前 `/workspace/*` 路径并行预载 Workspace；已知子路由同时预载目标 route chunk。本地暖 bootstrap 实测约 24–47ms。窗口聚焦复核时，所有工作区路由统一通过 React Activity 隐藏受保护内容并保留已挂载组件；复核通过后恢复原组件状态，撤权、换账号或不一致则继续清理。没有把身份或客户数据写入 localStorage，也没有开启 Better Auth cookie cache。


2026-10-29 D-04 更新：用户已明确选择 MIT；仓库增加 [LICENSE](../LICENSE)，package.json 与发布检查同步为 MIT。此前“许可证待定”的记录保留为当时状态，不再作为当前发布阻塞项。第三方依赖保持各自许可证。

### 7.74 Pi Durable 与三种宿主（2026-10-30）

默认生产入口已切换到 Pi Durable。`packages/agent-runtime` 固定 Pi AI / Pi Durable / Chord 1.4.0，管理模型、原始 submission 与受控工具；业务层的运行定义、权限、预算、接管、回执和单次尝试发送继续复用。业务工具使用已有 Valibot 校验，发送前权限不会由模型选择。Flue 仅供旧路径开发回归，便携产物有依赖图检查，禁止夹带旧引擎或多份 Pi。

Cloudflare 使用官方 PiHarness/Lifecycle 和 native DO SQL，业务数据保留 D1。新增迁移 0053 保存不可变运行绑定；DO v6 新增 Pi 类，v1–v5 不删除。旧 Flue 类成为保留数据的归档，残留 alarm 只清除唤醒，不恢复旧执行。升级脚本要求先收尾旧运行，无法读出完整零计数证明则不迁移、不上传。旧检查点不转换为新回执。

Node 使用同步 SQLite 的事务及 checksum 迁移账本，在持久目录获得进程独占写锁；会话与店铺对象保留可重入 RPC、串行存储事务和持久闹钟。闹钟目录只在事务提交后更新，启动时从原存储复核。HTTP 使用官方 `@hono/node-server`，编译产物自包含，进程重启恢复原运行。此配置支持单进程，不宣称分布式多写。

Vercel Functions 使用官方 durable-harness/World 原生队列；业务 SQL 由私有 Node Sandbox 挂载平台自有 Drive 保存，不放 Function 临时目录。每个 Sandbox 使用唯一名称，Drive 独占挂载防止多写，生产部署 ID 阻止旧发布替换新后端。升级先停止旧会话并确认磁盘释放，再删除旧实例。请求取消信号向下传递，同时保留 45 秒网络上限；未知业务写入不重试。JSON 与有界 CSV 在交付前读完，避免升级截断被误报为成功；Vercel 同步响应限制为 4 MiB。

原生队列已被动观察到在停止 Sandbox 后重新挂载并执行维护，无需浏览器请求。最终云端基线验证连续两次升级保留设置和会话，详见[部署证据](../probes/deployment/README.md)。真实 owner 邮件和部署向导待验收；默认 Node/Vercel 没有 Cloudflare Workers AI/Vectorize 知识索引。完整跨服务灾备、真实模型与真实店铺能力不由这些合成验证推定通过。
