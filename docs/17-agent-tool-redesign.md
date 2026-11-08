# Agent 工具重设计：调研与实施边界

本文记录当前工作区的代码事实及拟议方案；不是功能已实现或生产验收证明。

## 实施状态（2026-11-06）

`support-reply-v2` 已按本文的目标合同落地。公司模型不再创建草稿/检索模式，新的 AI 接待运行直接使用 v2；旧 `support-knowledge-v1`、`support-reply-v1` 及其工具和测试已删除：

- 新版本只注册 `bash`、`read`、`get_product_info`、`get_order_status`、`send_message`、`request_handoff`；分类运行仍只注册 `submit_classification`。
- `bash` 在每次调用新建的只读 `/knowledge` 快照上执行，只有 `grep`、`cat`、`ls`、`head`、`tail`、`wc`，无网络、宿主文件或环境变量；stdout 不是证据。
- `read` 只接受服务端生成的 `/knowledge/<documentId>.md` 路径和有界行范围；成功读取把文档修订冻结到 `ai_document_evidence`，这是知识引用的唯一来源。
- `get_product_info` / `get_order_status` 由应用解析商品与订单，读取成功把带哈希的快照冻结到新的 append-only `ai_fact_evidence`（迁移 `0074`），模型只拿到不可猜测的证据 ID。
- `send_message` 接受 `citations`（文档 ID）和/或 `facts`（事实证据 ID），至少一项；最终发送前重新读取当前文档/商品/订单快照并复核运行、期限、店铺、凭据、预算和会话状态。工具只提交不可变意图，仍由应用侧共享发送器单次尝试。
- 新运行始终使用 `support-reply-v2`，默认最多 6 轮生成；UI 的“AI 回复方式”草稿/直接回复选择已删除。历史 `autoReply` 字段仅作兼容读取，运行时忽略。升级前必须先清空或放弃在途 v1 运行；新运行只能使用 `support-reply-v2`。

当前实现仍不等于真实模型质量、真实 Ozon 外发或生产验收通过；三项外发开关默认关闭。

## 当前实现

- `packages/agent-runtime/harness.ts` 使用 `@earendil-works/pi-durable` 的 `Harness` 与显式注册表，不是自动装载 `pi-coding-agent` 的默认编码工具。Cloudflare 的 `src/platform/cloudflare/agent.ts` 也通过同一个 `openAgent` 打开运行时；Node/Vercel 通过业务 authority 暴露同一套工具定义。
- `src/platform/agents/authority.ts` 现在只注册 v2 的 `bash`、`read`、`get_product_info`、`get_order_status`、`send_message`、`request_handoff`；分类任务只提供 `submit_classification`。`src/agents/support.ts` 是旧 Flue 入口，仍保留 v2 兼容注册。
- 知识正文存储在 `knowledge_revision.markdown` 和 `source_json`。`prepareKnowledge` 仍生成切块；`knowledge_text_search` 基于 chunk。`readPublishedKnowledge` 已支持历史缺失 Markdown 时从合法 source 重建，但旧来源不能凭空补造发布证明。
- `ai_document_evidence` 记录 v2 `read` 实际冻结的文档修订与内容哈希；`ai_fact_evidence` 记录商品/订单快照。`message-intent.ts` 在准备、完成审阅、入队和最终发送前重新核对证据、运行、策略、渠道、凭据、预算和期限；`controller-core.ts` 的排队、恢复及发送检查依赖这一合同。旧的 `reply-intent.ts`、`prepare_reply` 和 chunk 级证据路径已删除。
- `readAiProductContext` / `readAiOrderContext` 只从已冻结的运行和会话消息推导商品/订单，返回有限快照，不允许模型传入任意 SKU 或订单号。v2 `get_product_info` / `get_order_status` 把读取结果冻结为 `ai_fact_evidence`，`send_message` 只能引用这些服务端签发的证据 ID。
- 当前发送工具只持久化意图并安排观察；`enqueueAiReply` 需要原运行成功完成且资金结算，再重新授权，并进入原有单次外发/unknown 管道。Pi 工具的 `replay: safe` 并不保证外部副作用 exactly-once。

## just-bash 验证结论

`probes/just-bash/` 固定 3.6.0，浏览器入口在本地 Miniflare/workerd + `nodejs_compat` 执行了合成中文、俄文及字面特殊字符查询。该探针不含 Pi、业务数据或生产安全验证；生成 bundle 约 1.74 MB，具体大小取决于打包方式。直接按纯浏览器目标打包会遇到 `node:zlib`，探针将其保留给 Workers 兼容层。

官方文档支持虚拟文件系统及执行限制；威胁模型明确这不是 VM 隔离，宿主提供的文件系统、网络、扩展和代码仍是安全边界。生产构建要分别验证 Node、Cloudflare 和 Vercel，不能以探针代替实际部署。

## 建议目标合同

### 工具与知识文件

- 在新版本运行中注册 `read`、`bash`、`get_order_status`、`get_product_info`、`send_message` 和 `request_handoff`；独立分类运行仍只使用 `submit_classification`。兼容旧运行的工具定义必须与新运行区分，直到原有在途任务完成或安全停用。
- SQLite 是唯一权威。按运行的公司、店铺、商品、语言、当前发布证明及活动版本查询；使用服务端生成的文档 ID 路径映射到只读虚拟文件，不用用户标题拼路径。历史缺失 Markdown 时仅根据现有合法来源重建。
- 目录可以列出授权文档；`read` 和 `bash` 应使用同一份受限视图。文件内容和路径均不得暴露宿主目录、凭证、环境变量或其他租户。禁止网络与 Node 专属扩展；明确限制输入、运行时间、命令数、目录/文件字节和输出。容量超限返回明确错误，不能静默截断目录后报告完整搜索。
- 每次读取需重检运行和发布权限；针对 Agent 任务中更新、撤回、权限变化的竞态，读取完成后重验，最终发送前再复核。虚拟文件快照不可在多个租户或运行之间复用。
- Bash 支持管道、重定向和输出拼接，不能从任意 stdout 推断哪些内容是文档原文，也不能把 Agent 自造的文本视为证据。建议 `bash` 用于发现，`read` 返回服务端生成的文件版本和有界行范围引用；`send_message` 只接受本运行真实读取过、服务端冻结的证据标识。若未来允许直接依据 Bash 输出发送，须先设计并验证底层读取追踪和结果来源合同。

### 商品与订单

- `get_product_info` 优先复用现有按冻结运行和会话平台元数据解析的产品快照合同；字段、来源和观察时间显式暴露，缺失/歧义时不猜测。
- `get_order_status` 只能根据已授权会话中可信的平台关联元数据定位订单；禁止模型自行枚举任意订单号。明确多包裹、多履约模式、订单号歧义、部分同步、陈旧观察及分页/容量上限。库存、预计送达、个人信息和退款状态不得猜测。
- 如果允许仅依据订单或商品状态发送，必须增加独立的服务端事实快照证据、时效策略及发送前复核；不能要求虚构一条知识文档引用，也不能把模型声明视为证明。

### `send_message`

- 它是提交消息请求的工具，不是模型直连 Ozon。提交不可变 body 和服务端签发的证据引用，限定本运行/会话，写入原始意图并使用稳定幂等标识。结果只报告已记录/冲突/不可用/未知，不把已提交或平台接受等同于最终送达。
- 工具调用时不立刻外发：运行成功结束、结算完成后，再复核证据、会话状态、成员/店铺授权、发送开关、凭证、期限与预算；经既有 sender 在最终临界区重新授权后尝试一次。结果 unknown 禁止自动重发。
- 知识版本变更、权限撤销、商品或订单事实变化、模型未正常结束、证据或审计不可用都失败关闭并可转人工。读取证据不证明自然语言回答正确；真实模型质量必须单独评估。

## 迁移顺序

1. 固定新工具版本及持久化合同；新旧版本并存、旧运行按旧定义完成或明确终止，禁止直接重写历史回执。
2. 添加文档级/订单级/商品级证据及只读虚拟文件实现，覆盖权限、发布撤回、竞态与容量错误。以增量迁移保留历史 chunk、索引和原证据。
3. 先在自动外发关闭下接入 `read` / `bash` 与商品/订单工具，验证真实 Node/Workers/Vercel 构建、恢复和结果一致性。
4. 实现 `send_message`，连接既有单次发送和预算门禁；验证运行中断、重复调用、权限撤销、数据更新和 unknown。
5. 完成工具及历史迁移、端到端验收和外发演练后，才停止新路径的切块/FTS 写入。历史数据删除需独立的备份、归档、保留和回滚方案。

## 验收要点

- 类型、全量测试和构建通过；实际 workerd 和 Node 成品运行，以及 Vercel 适配构建通过。
- 多租户、店铺/商品/会话和语言隔离；路径穿越、命令注入、环境变量、文件系统、网络和超额负载测试。
- 针对中文/俄文、长行、Unicode、特殊字符、搜索无命中、目录超限和大数据集验证；无静默丢失。
- 测试真实读取证据与构造 stdout、过期引用、撤回、并发、恢复、历史运行和同一消息重复发送。
- 评测真实模型的工具调用、引用支撑和转人工；小流量核对真实 Ozon 订单/商品与发送回显。模拟通过不等同真实质量与送达。

## 参考资料

- [just-bash README](https://github.com/vercel-labs/just-bash/blob/main/packages/just-bash/README.md)
- [just-bash 威胁模型](https://github.com/vercel-labs/just-bash/blob/main/THREAT_MODEL.md)
- [Pi Durable](https://github.com/earendil-works/pi/blob/main/packages/durable/README.md)
- [Cloudflare Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)
