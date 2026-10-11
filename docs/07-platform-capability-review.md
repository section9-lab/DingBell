# 阶段 1：平台能力与检索选型证据

首次核对日期：2026-10-08；Ozon 只读实测补充日期：2026-10-09。范围：Ozon、ADR-08 检索选型、模型与数据地域。第 6 节记录已执行的小样本读取，不代表生产连接器或全部平台能力已完成。

## 1. 结论与证据等级

当前建议维持 **Vectorize 为唯一施工基线**。AI Search 的官方功能已经覆盖很多需求，值得优先完成小规模远程验证；但 ADR-08 要求的六项验收尚无实测证据，不能据此替换基线，更不应同时实现两套生产检索管道。

截至 2026-10-08，Ozon 官方文档直接读取返回重定向循环，尚未取得当前接口合同，也未执行平台 API。2026-10-09 通过官方站点文档索引核对部分方法，并取得授权店铺的鉴权、商品、会话及订单列表只读结果，见第 6 节。未覆盖的能力继续保持 `unknown`，AC-011 仍不能标记通过。

| 标记 | 意义 | 可以据此做什么 |
| --- | --- | --- |
| DOC | 已读取当前官方资料 | 确定实验方向和候选合同 |
| UNKNOWN | 官方资料或必要条件不足 | 保留问题，不承诺能力 |
| NOT_RUN | 已定义实测，但未执行 | 安排实验，不能记为验收通过 |
| PASS / FAIL | 有版本、环境及实际结果的实验结论 | 按实际子场景判断；第 6 节的小样本读取不能替代完整能力验收 |

资料读取日期与页面更新时间分别记录。SDK、公开示例和方法存在，不证明某个商家账号具有该能力。文档中的代码示例也不是已经执行的命令。

2026-10-10 阶段 5B-7 补充知识库管理界面的本地证据：在真实本地 Worker/D1/Workflows 上验证索引、检索测试与发布操作及其浏览器恢复，外部模型和向量绑定使用合成提供方。它不新增本文件的平台实测 PASS，也不证明实际语义质量、云端自动唤醒或生产性能。实际验证范围与结果见实施进度第 57 节。

阶段 5B-8 的商品导入验证同样属于本地合成来源证据：它将已有同步快照转换为知识草稿并保护来源/版本关系，未重新读取真实 Ozon 商品，也未新增平台能力 PASS。完整商品属性和真实语义效果仍需后续验证。

阶段 5B-9 的文件导入证据仅涉及本地文件、Worker/D1 与后台界面。测试使用合成文本/CSV，不查询 Ozon、不调用真实模型、不使用云端 R2；不能据此新增任何平台能力 PASS。

## 2. Ozon 能力矩阵

### 2.1 官方资料可访问性

| 官方入口 | 本次结果 | 对接口版本的结论 |
| --- | --- | --- |
| [Seller API](https://docs.ozon.ru/api/seller/) | 读取工具返回 `Redirect loop detected` | 未取得正文，不能确认当前方法路径、版本或废弃状态 |
| [Ozon Global 英文帮助](https://docs.ozon.ru/global/en/) | 同样返回重定向循环 | 不能补证履约模式、套餐或聊天窗口 |
| 官方域名限定检索 | 未取得足以核对本项目能力的官方正文 | 搜索不到不等于能力不存在 |

没有用社区 SDK、镜像或 Postman 集合中的方法名称替代官方版本证据。尤其不将网上流传的套餐要求、48/72 小时窗口或“所有聊天 API 均可用”写成施工常量。后续需要可访问的官方导出/文档，以及授权测试店铺的返回结果；无需把密钥写入文档或聊天。

### 2.2 按履约方式拆开的业务能力

以下表格保留 2026-10-08 的初始能力清单，当时官方合同状态均为 `UNKNOWN`、真实测试均为 `NOT_RUN`。2026-10-09 的局部进展以第 6 节及实施进度第 12 节为准，不将整行自动升级为通过。FBO、FBS、rFBS 必须分别记录；某一模式成功不能推广到其他模式。

| 能力 | FBO | FBS | rFBS | 必须取得的合同与样本 | 未验证前的产品行为 |
| --- | --- | --- | --- | --- | --- |
| 鉴权、角色、套餐 | 未确认 | 未确认 | 未确认 | 凭证字段、权限范围、套餐限制、失效/轮换语义 | 不能将凭证格式正确显示为全部能力已连接 |
| 私聊列表 | 未确认 | 未确认 | 未确认 | 方法/版本、分页游标、排序、归档/关闭会话行为 | 不启用真实收件箱同步 |
| 私聊历史与增量 | 未确认 | 未确认 | 未确认 | 消息 ID 类型、编辑/撤回、增量边界、分页重复/缺失 | 先用假连接器验证内部处理 |
| 向已有会话发送文本 | 未确认 | 未确认 | 未确认 | 可回复窗口、文本限制、套餐、错误分类、成功响应含义 | 自动回复关闭，人工发送同样不绕过能力检查 |
| 主动创建买家会话 | 未确认 | 未确认 | 未确认 | 发起方限制、订单/包裹关联、支付/发货/签收窗口 | 主动通知不可启用，并展示未验证原因 |
| 售前商品公开问答 | 未确认 | 未确认 | 未确认 | 是否独立于私聊、读取/回复版本、商品关联与审核规则 | 不宣传已覆盖全部售前入口 |
| 商品资料、价格、库存 | 未确认 | 未确认 | 未确认 | SKU/变体关系、字段可见性、更新时间、数值 ID 精度 | AI 不推测库存和额外折扣 |
| 订单与包裹详情 | 未确认 | 未确认 | 未确认 | 订单与 posting 关系、拆包、状态枚举、买家归属 | 查询工具只使用真实已关联数据 |
| 发货、待取、签收、取消与退货 | 未确认 | 未确认 | 未确认 | 各模式实际状态、状态时间、回退与更正样本 | 未映射状态不触发通知；部分包裹不代表整单 |
| 图片、文件的接收/发送 | 未确认 | 未确认 | 未确认 | MIME、大小、链接有效期、下载授权与允许域 | 文本优先，附件能力关闭 |
| 推送/回调 | 未确认 | 未确认 | 未确认 | 事件类型、验签/来源校验、重试、顺序、稳定事件 ID | 不开放未经来源验证的公网入站路径 |
| 轮询与回填 | 未确认 | 未确认 | 未确认 | 官方允许方法、时间窗口、增量水位、回填限额 | 不能把“可以轮询”当作默认已授权替代方案 |
| 速率限制 | 未确认 | 未确认 | 未确认 | 接口桶、店铺/应用维度、429 与退避字段 | 配置保守上限，真实限额未确定前不宣称容量 |
| 发送结果核对与幂等 | 未确认 | 未确认 | 未确认 | 请求键/请求 ID、消息 ID、回显、历史可查性 | 超时或歧义结果保留 `unknown`，不盲重发 |
| 评价邀请、优惠券及营销消息 | 未确认 | 未确认 | 未确认 | 官方允许内容、适用对象、激励规则和写权限 | 首版不自动发券，不启用未经确认的激励通知 |

### 2.3 一次有结论的 Ozon 实测

测试身份必须是商家明确授权的测试店铺及允许联系的测试消费者。先读取；只有确认为测试对象的会话才能执行外发。不能以阶段 1 验证为由向真实消费者随意发送测试消息。

| 实验 | 步骤与证据 | 通过条件 | 当前状态 |
| --- | --- | --- | --- |
| OZ-T01 核心读取 | 记录脱敏店铺标识、实际履约方式、权限/套餐；读取会话列表和两页消息 | 官方版本明确；同一消息重复读取 ID 稳定，分页能解释完整性 | NOT_RUN |
| OZ-T02 文本往返 | 测试消费者发消息，商家端回复唯一测试标记，再读取历史 | 接收、回复、成功语义和回显关联均有证据；不得只凭 HTTP 200 判断已读 | NOT_RUN |
| OZ-T03 订单上下文 | 读取已关联订单及多个包裹，覆盖至少一个真实履约方式 | 状态映射有来源时间；不查询其他消费者订单；未覆盖模式明确保留 unknown | NOT_RUN |
| OZ-T04 主动联系 | 各履约模式分别在官方允许与禁止窗口测试 | 允许/拒绝原因、窗口边界、包裹关联均有证据；可明确结论为不支持而非强行成功 | NOT_RUN |
| OZ-T05 售前与附件 | 分别测试公开问答、附件下载/发送 | 每个入口独立判定；不可用功能不会因文本聊天成功被开启 | NOT_RUN |
| OZ-T06 推送与轮询 | 验证来源后重放事件；模拟重复、乱序和分页重叠 | 稳定去重键及续传水位可用，撤销凭证停止重复调用 | NOT_RUN |
| OZ-T07 限流与核对 | 遵守测试额度，收集允许的限流样本；在本地传输层丢弃已取得的发送响应后核对 | 能证明成功则只记一次；无法可靠证明则保持 unknown，不以正文相似自动去重 | NOT_RUN |

能力证据单最少包含 `checked_at`、官方 URL、HTTP 方法和带版本路径、凭证角色/套餐、履约模式、脱敏输入/输出、平台 request/message ID、错误码、结论及复核人。任何未覆盖的模式/消息类型不自动继承 `available`。

核心出口：至少明确一类目标店铺能否读取已有私聊、向测试会话回复并读取关联订单。如果其中任一项在目标客户店铺不可用，需要先缩小首版服务范围或调整连接器，不能用假连接器测试通过替代。

## 3. ADR-08：AI Search 与 Vectorize

### 3.1 当前官方接口基线

Cloudflare 已提供按 namespace 管理实例的新 AI Search API。本文采用 `https://api.cloudflare.com/client/v4` 下的 `/accounts/{account_id}/ai-search/namespaces/{namespace}/instances` 合同；不混用旧 AutoRAG API 的字段格式。实例文档更新于 2026-09-17，检索文档更新于 2026-10-01。[Instances REST API](https://developers.cloudflare.com/ai-search/api/instances/rest-api/)、[Search REST API](https://developers.cloudflare.com/ai-search/api/search/rest-api/)

| 操作 | 官方公开合同 | 工程意义 |
| --- | --- | --- |
| 创建/查询/删除实例 | `POST/GET` 实例集合，`GET/PUT/DELETE` 实例资源 | 可编程管理；不等于部署按钮已自动配置成功 |
| 纯检索 | `POST .../instances/{id}/search` | 返回片段；Flue 仍是对客回答执行器，不调用第二个 chat completion 管道 |
| 文件上传/读取/删除 | `POST .../{id}/items`，`GET/DELETE .../{id}/items/{item_id}` | 内置存储可由业务发布流程推送已确认版本 |
| 索引状态 | Item 含 `checksum`、`chunks_count`、`status`、`next_action` | `queued/running/completed/error/skipped/outdated` 分开；上传成功不作为发布完成 |
| 引用 | Search 返回 chunk `id`、`text`，可带 `item.key`、metadata | 必须建立到业务 document/revision 的映射；缺少可核实映射的结果不进入回答 |

操作与字段依据：[Items API](https://developers.cloudflare.com/ai-search/api/items/rest-api/)、[Get Item 完整合同](https://developers.cloudflare.com/api/resources/ai_search/subresources/namespaces/subresources/instances/subresources/items/methods/get/)、[Search 返回合同](https://developers.cloudflare.com/api/resources/ai_search/subresources/namespaces/subresources/instances/methods/search/)。公开 API 根版本 `client/v4` 不意味着每项功能存在独立、固定不变的 v4 产品版本；实施仍需锁定客户端/Workers 类型并保存实际响应合同。

### 3.2 六项门槛逐项判定

| 门槛 | DOC：官方资料已经说明什么 | 尚需实测的内容 | 当前结论 |
| --- | --- | --- | --- |
| 部署 | 新实例可通过 API/Workers namespace binding 创建；每实例带内置存储和索引 | 全新账号、实际权限、绑定生成、失败重试与资源清理；与 Flue 构建集成一起部署 | NOT_RUN，不能认定一键部署已通过 |
| 租户与店铺隔离 | 官方支持每租户独立实例，或共享实例加检索前过滤 | 两公司、每公司两店铺、公司通用资料、恶意客户端过滤；所有检索入口都由服务器确定范围 | NOT_RUN，不能认定真实隔离已通过 |
| 发布、撤回与版本 | 支持 metadata、Item 状态、删除；外部 R2 同步处理文件变化 | V1→V2 原子发布，撤回立即从业务放行中消失，索引延迟时旧片段不进入模型；失败发布保留旧有效版 | NOT_RUN，不能认定撤回时效已通过 |
| 引用及纯检索 | `/search` 返回片段与来源字段，无须使用 `/chat/completions` | chunk/item 与业务不可变修订版一一可核实；同名不同店铺文件不串引用 | NOT_RUN，不能认定引用完整性已通过 |
| 成本、测试与限制 | 官方公开价格、实例/文件/metadata 限制；本地开发可远程访问服务 | 真实账号使用统计、一次重建成本、清理后费用变化；替身与云端合同一致 | NOT_RUN，未形成成本验收记录 |
| 恢复及私有访问 | 可删除/重建实例，R2 原文件可独立保存；公共端点可关闭 | 删除测试索引后从业务原文及修订版重建；匿名请求与篡改租户请求拒绝；恢复后权限不变 | NOT_RUN，不能认定恢复已通过 |

隔离依据：[Multitenancy](https://developers.cloudflare.com/ai-search/how-to/per-tenant-search/)；部署依据：[Built-in storage](https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/)。官方示例里的 `x-tenant-id` 仅展示概念，DingBell 不能直接信任客户端的公司标识。

### 3.3 对实现有影响的限制

1. **筛选必须来自服务器。** AI Search 最多 5 个自定义 metadata 字段；字符串过滤仅使用前 64 个 UTF-8 字节。公司/店铺/修订 ID 应为短而稳定的内部标识，不能把长路径末尾当作安全区别。字段类型和共享/独立实例方案先冻结，再建立索引；变更 metadata schema 会触发全量重建。[Metadata attributes](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/)、[Filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/)
2. **异步索引必须有发布状态。** 内置上传会立即开始处理，但 Multitenancy 文档明确其索引仍是异步。外部 R2 默认每 6 小时同步，可配置间隔或触发任务；程序触发有频率限制。不能等待定时同步才实现业务撤回，应先以 D1 发布事实拒绝旧版本，再清理派生索引。[Syncing](https://developers.cloudflare.com/ai-search/configuration/indexing/syncing/)
3. **一键部署仍有组合风险。** Deploy Button 的自动资源列表明确列出 Vectorize，没有列出 AI Search；未列出不是“不支持”的证明，需要验证模板或初始化中的实例创建。R2-backed AI Search 另需 service API token；内置上传不需要该索引 token，可作为减少安装步骤的验证方向。业务 R2 原件仍保留用于恢复。[Deploy buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Service API token](https://developers.cloudflare.com/ai-search/configuration/indexing/service-api-token/)
4. **不要开放旁路查询。** 实例和 namespace 都可能配置公共端点；DingBell 默认全部关闭，经鉴权业务 API 调用检索。CORS 白名单不能替代认证；仅隐藏公共 URL 也不能隔离客户资料。[Public endpoint settings](https://developers.cloudflare.com/ai-search/configuration/retrieval/public-endpoint/)

### 3.4 成本快照

官方价格页更新时间为 2026-10-01，说明 AI Search 将于 **2026-11-01 开始计费**。因此不能用当前试用账单为零推导长期免费。以下是资料快照，不是本项目的实测账单。[AI Search limits & pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)

| 项目 | 页面所列用量与价格 |
| --- | --- |
| 每账号包含量 | 每月 500 万 ingestion tokens、10 GB-month 存储、1,000 次语义检索、1,000 次全文检索 |
| 超出包含量的导入 | 基础 $0.75 / 百万 tokens；图像处理额外 $0.50 / 百万 tokens |
| 超出包含量的存储 | $2.00 / GB-month |
| 超出包含量的检索 | 语义/向量/混合 $0.75 / 1,000 次；全文 $0.10 / 1,000 次 |
| 实例上限 | Free 每账号 100；Paid 每账号 5,000；不能据此代替实际账号配额检查 |

导入按最终分块计算，重叠文字会重复计量。AI Search 包含其 Workers AI 嵌入与 reranking；生成、查询重写和外部模型另按对应服务计费。用于 Flue 的客服生成费用仍独立计入预算。

Vectorize 官方按查询维度及存储维度计量，付费计划包含部分额度；文档所列超额价格分别为每百万查询维度 $0.01、每亿存储维度 $0.05。它不替 DingBell 承担解析、分块、嵌入和业务原文件成本，所以不能仅比较两个检索单价就宣布哪种更便宜。[Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)

### 3.5 当前唯一实施建议

**保持既定 Vectorize 路径作为当前施工目标，不安装第二套生产检索实现。** 原因是六门槛尚未取得远程实验结果，而非 AI Search 已被证明不符合要求。选择基线是工程决策，不能把它写成“Vectorize 已通过云端验收”。

Vectorize 的官方合同已明确 namespace/metadata 检索前过滤、向量 ID、异步写入和删除；这些使既定业务修订方案可落地，但仍要实测。元数据索引应先创建，再导入向量；新增索引不会自动为既有向量补齐过滤索引。命中后仍核对 D1 当前有效版本；撤回先停止业务使用，异步删除随后完成。[Vectorize API](https://developers.cloudflare.com/vectorize/reference/client-api/)、[Vectorize metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)

如果在阶段 1 的检索验证窗口内取得 AI Search 六项完整通过证据，按 ADR-08 **替换**为 AI Search，并同时删去计划中的自建分块/嵌入执行路径。未完成实验时只能记录“未验证”，不能把调研文档签成六项通过。检索选型涉及的实测状态由阶段进度表统一汇总。

### 3.6 可直接执行的检索实测清单

只使用合成知识，不上传真实客户内容。固定数据集含 A/B 两公司、A 公司两个店铺、公司通用政策、同名不同内容商品、V1/V2、草稿和已撤回资料；每条含独有标记，便于确定性断言。

| 编号 | 实验 | 必须保留的结果 | 当前状态 |
| --- | --- | --- | --- |
| RET-01 | 全新目标账号执行创建→绑定→最小查询→清理；重复初始化一次 | SDK/类型/配置版本、资源名、无手工遗漏步骤、重试未重复创建 | PARTIAL：现有账号新索引创建、绑定、查询、删除已验证；完整安装器重复初始化未验收 |
| RET-02 | 两租户与不同店铺交叉查询，伪造过滤条件，测试长前缀 ID | 不可见标记出现次数为 0；过滤条件从服务端身份生成 | PARTIAL：远端合成过滤及长前缀哈希通过；本地授权/引用复核通过，尚未连成云端应用链路 |
| RET-03 | 发布 V1，导入 V2，处理成功前尝试发布，再发布/撤回 | 索引状态及时间戳；有效指针切换记录；旧版/草稿/撤回内容不进入模型输入 | PARTIAL：远端 V2 可见性约 80 秒；隔离云端编排的定时等待/显式重启通过，使用合成提供方；本地持久测试与晋升已用合成绑定接通，原生重启需要显式本地唤醒；内部检索已验证生效修订前置过滤、旧版候选保留、撤回重查和权限复核；真实语义质量、大目录性能与生成/发送链路未验收 |
| RET-04 | 缺失、重复或错误 revision 映射，检查全部返回引用 | 引用均能核对原文哈希与版本；无法核对的候选被拒绝 | PARTIAL：本地适配器及 D1 引用负例通过；远端语义召回与原文核对未连通 |
| RET-05 | 导入、查询、重建和清理各跑一批；模拟远端不可用 | 使用量、估算公式、失败可恢复、测试替身合同、费用没有被当作零 | PARTIAL：本地输入预留、未知尝试保留、回执丢失与重试验证；实际费用、查询/重建/清理批次未验收 |
| RET-06 | 删除测试索引/实例，从 R2 原文及 D1 修订记录重新构建 | 数据集与隔离断言仍通过；匿名及跨公司请求拒绝；资源清单清理完成 | NOT_RUN |

所有实验记录环境、commit、依赖锁、开始/结束时间、非敏感资源标识、输入夹具版本、实际结果。不得把 API 返回“接受处理”记录成索引已可见；不得把本地 fake 返回记录成远程实验。

2026-10-10 补充证据见 test-results/stage5b-2026-10-10/ 与实施进度第 51 节。32 维手工向量用于索引合同实验；独立 BGE-M3 调用返回 1024 维，二者没有串成语义检索链路。首次 60 秒检查失败保留为失败，后续复查与新 V2 的成功不覆盖原结果。临时索引已删除并通过 API 的 deleted / 3005 状态复核；没有把试验费用写成零，也没有恢复或验证云端 R2。

## 4. 模型与地域：已经知道什么，仍缺什么

此处不替用户选择经营主体或法定留存期。2026-10-09 用户授权免费模型试用、提供 NVIDIA Key 并明确没有特殊存储地域要求，新增结果见第 7 节。模型能够在框架中调用，不代表该账号、付款主体、运行地区和业务用途都具备同样可用性。

| 项目 | 官方依据与已知边界 | 阶段 1 还缺的证据 |
| --- | --- | --- |
| 模型 ID 与工具能力 | [Workers AI models](https://developers.cloudflare.com/workers-ai/models/)按具体模型提供能力信息 | 选定 provider、完整 model ID/版本、调用接口、工具/结构化输出、俄语问答及中俄翻译样本；不能仅选一个品牌名 |
| 模型数据使用 | [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/)说明内容使用及第三方模型许可边界 | 实際所选供应商/模型条款、日志与留存设置；不能将某供应商政策推广到所有 Flue 模型 |
| D1 地域 | [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)说明 location hint 不保证准确位置，jurisdiction 是单独约束且创建后不能直接修改 | 目标 jurisdiction 是否满足业务要求、账号可用性、创建及恢复配置；未选定前不承诺“全部在新加坡/俄罗斯” |
| Flue 与控制 DO | [DO data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)区分 hint 与 jurisdiction；Worker 仍可从其他地区访问 | Flue 公共初始化/生成绑定能否保持选定 jurisdiction；已有对象世代与恢复后地域是否一致 |
| 文件与备份 | [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/)区分提示与区域约束 | 原文件、导出、备份 bucket 的实际约束及恢复路径；不能只约束主库 |
| 检索和模型处理位置 | R2/D1 的存储位置不能推导全部 AI Search、Vectorize 或模型推理位置 | 所选服务的明确数据处理边界及必要的供应商说明；本次资料不足以证明整条处理链的地区保证 |
| 到 Ozon 的连接 | Seller API 官方当前合同未取得 | 目标 Cloudflare 测试环境到官方端点的真实可达性、超时、限流及授权响应 |

需要补齐的最小非秘密信息：测试 Cloudflare 账号/环境的授权范围和套餐、实际店铺履约模式及可测试会话、模型供应商/具体模型、可用月度测试预算、是否存在必须落在特定地区的数据要求。密钥仅通过受控 Secret 配置提供，不进入此文件。

在这些信息和真实实验缺失时，可以继续本地确定性测试、构建验证和假连接器开发；不得宣称阶段 1 的 Ozon、云端检索、模型/地域验收已完成。

## 5. 首次资料核对完成与未完成（2026-10-08）

- 已完成：官方资料可访问性检查；Ozon 分能力/履约方式的证据矩阵；AI Search 新 API、限制、价格与六项门槛核对；Vectorize 单一基线建议；可执行实测步骤及模型/地域缺口。
- 未执行：Ozon API、店铺外发、Cloudflare 资源创建/修改、AI Search/Vectorize 云端实验、模型调用、成本与跨资源恢复测试。
- 阶段状态：本文完成资料核对，**不单独证明阶段 1 完成**；门槛以真实实验结果和[实施进度](06-implementation-progress.md)为准。

## 6. Ozon 只读实测补充（2026-10-09）

采用用户配置的 Seller API `Client-Id` 与 `Api-Key`，从本机执行有限只读请求。`/v1/roles`、`/v1/seller/info`、`/v3/product/list`、`/v3/chat/list`、`/v3/chat/history`、`/v4/posting/fbs/list`、`/v3/posting/fbo/list` 均返回 HTTP 200。取得商品、买家会话、单条历史消息与 FBS 订单样本；FBO 近 7 天查询为空。会话列表通过服务端 cursor 读取两页，样本之间没有重复 ID。

方法合同通过 Context7 官方站点索引取得，不使用社区 SDK 猜版本；直接官方页面重定向问题不因此被记为已解决。当前店铺 `is_premium=false` 且买家历史读取成功，不能将其他聊天方法的套餐门槛推广到历史读取，也不能反向推断发送能力已开放。

本次未发送任何消费者消息、未标记已读、未修改商品或订单、未上传凭证至云端。返回数据只保留脱敏计数和结构；完整结果及边界见[实施进度第 12 节](06-implementation-progress.md#12-ozon-首次真实只读验证2026-10-09)。AC-011 继续为部分完成，不能用本机小样本替代 Cloudflare 连接、会话订单关联、测试回复或完整状态/增量验收。

## 7. NVIDIA 免费试用与测试会话补充（2026-10-09）

已使用现有 NVIDIA Key 和当日标记 Free Endpoint Available 的 `nvidia/nemotron-3-super-120b-a12b` 完成真实连接、俄语售前/售后样本及本地 Flue 合成订单工具往返。原生 Pi provider 复用现有依赖；两轮真实 SSE、一次工具调用、同键重放与 token 用量均有证据。售前首次回答出现将未知包邮条件说成否定的错误，修正提示词后单次复测改善，仍不构成生产质量验收。

用户未指定存储地区，后续无需等待这一偏好答复；实际存储与推理位置、数据使用/留存、生产条款仍需按具体部署记录。只授权免费试用，没有充值或新增付费资源预算。NVIDIA 原型免费访问不能推广为无限或生产免费；官方支持语言列表也没有俄语，本轮只作探索性验证。

本地合成会话已创建，Ozon Seller Chat 自聊/沙箱没有获得官方证实；真实发送仍缺受控买家会话，不使用真实消费者作为测试对象。详见[实施进度第 13 节](06-implementation-progress.md#13-免费模型与内部测试会话2026-10-09)及[探针说明](../probes/nvidia/README.md)。

后续独立云端探针已验证 Cloudflare 到 Ozon 的权限、商品、会话及 FBS 列表读取，以及 Flue 到 NVIDIA 的真实 SSE/工具往返。完成结果重放及同身份重部署未增加模型调用；这不代表在途故障恢复或 Ozon 真实发送已通过。4 项合成质量测试暴露了退款错误拒绝及不必要的内置 task 调用，失败保留，不能将网络接通等同于生产模型可用。详见[实施进度第 14 节](06-implementation-progress.md#14-cloudflare-外部服务验证与回答边界2026-10-09)。

仅纯文本评估通过 Pi 公开 `toolChoice: 'none'` 禁止工具调用后，退款单样本完成：建议店铺人工审核，没有宣称退款或转接已完成。旧失败和新成功分开保存，未扩大重试预算。该修复不改变需要查单的 Flue 工具探针，也不将一次成功升级为俄语生产质量通过。

## 8. 商品与 FBS 读取合同补充（2026-10-09）

此节属于 DOC 与合成合同验证准备，不增加真实店铺 PASS。来源为 [Ozon Seller API 官方文档](https://docs.ozon.ru/api/seller/)，通过 Context7 官方站点内容索引读取；官方站点直接访问的问题仍存在。

| 方法 | 已核对合同 | 实施边界 |
| --- | --- | --- |
| `/v3/product/list` | `filter.visibility`、`last_id`、`limit`；响应 `result.items/last_id/total`，官方最多 1000 条 | 应用每页最多 100；总数或短页不作为一致快照完成证据；无进展的非空页拒绝推进 |
| `/v3/product/info/list` | 按 `product_id` 查询，顶层 `items`；商品 ID、offer_id、名称、SKU/来源、字符串价格与币种、归档标记 | 只接收请求过的 ID；缺失详情不当作删除，导入不自动发布知识；库存布尔标记不当库存数量 |
| `/v4/posting/fbs/list` | `cursor`、必需的 `filter`、每页 1–100、`sort_dir`；顶层 `postings/has_next/cursor`；查询期间最多一年 | 不混入旧 v3 的 result/offset；应用采用更小固定窗口，逐页保持同一组条件 |
| `/v3/posting/fbs/get` | 按 `posting_number` 获取 `result`；订单/包裹标识、原始状态、商品数量、字符串金额、物流字段与业务时间 | 包裹不等同订单；不采集本批不需要的收件人地址/电话；不生成履约通知 |

仍未核实商品列表的终页细节、扫描期间一致性、FBS 游标有效期、时间边界包含性及 `sort_dir` 对应字段。FBS 示例中的 `last_changed_status_date` 与 `since/to` 的组合关系和基准时间也未明确，本批不以它建立可靠增量水位。

没有取得可依赖的状态版本或状态更新时间合同。`in_process_at`、`shipment_date`、`delivering_date` 是不同业务时间，不能代替 `updated_at`；本地收到响应的时间也不证明平台事实更新。后续应保存观察证据，将相互冲突或未知的状态保留为待核实，不按自造状态排名触发通知。原 AC-019 的完整状态防倒退与自动通知验收仍待可靠源合同及真实样本。
