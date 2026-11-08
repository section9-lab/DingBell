# Ozon Push 驱动同步

## 范围与当前状态

本地收件、后台处理、恢复与浏览器实时链路已实现。**本地模拟通过不等于 Ozon 公网订阅已接通**；此改动不执行云端发布，也不自动修改现有 Ozon 订阅。

同步分为 **一次启动引导 + Push 增量**，不存在周期性轮询兜底：

- **启动引导**：首次定时任务执行一次 `runStartupBootstrap`，为所有已验证、具备凭证和读取能力的店铺创建初始 chat/product/FBS/FBO/FBP 工作并唤醒协调器。全部店铺完成后写入 `sync_bootstrap` 标记，之后不再扫描店铺。
- **增量实时**：Ozon Push Webhook 是增量同步的唯一入口；定时任务不再唤醒店铺、不再发现或轮询 Ozon 数据。未配置或未完成 Push 切换的店铺在初始引导完成后不会自动获得新数据；必须在“店铺管理 → Ozon Push 同步”完成回调握手并启用来源。
- 新店铺完成连接检查后会立即触发一次该店铺的初始引导；已有店铺不会因重启重复引导。
- Push 激活后，聊天、商品、FBS 的变更由 Webhook 事件驱动读取；FBO/FBP 没有完整生命周期通知覆盖，只能显式人工回补。
- Push 暂停或地址重新生成：队列保留，不恢复扫描；恢复 Push 后继续处理。
- 人工回补是有限任务，分页结束即停止，不会变成另一条周期发现链路。
- 定时任务只保留内部 AI、控制、财务修复；启动引导只创建持久任务并唤醒协调器，不直接调用 Ozon。

## 数据流

```text
Ozon / 本地模拟器
  → POST /api/ozon/push/:endpointId/:token
  → 校验独立地址密钥、可选 seller_id 绑定、有限大小与提示字段
  → D1 持久化、去重
  → 返回协议确认（接收接口不等待 Ozon 读取或模型运行）
  → 现有 StoreCoordinator alarm
  → 按实体读取 Ozon 权威接口
  → 现有 epoch / fence / 凭证版本 / 页提交事务
  → 业务事实、快照与 ingest outbox
  → 当前店铺的输入投递和 AI dispatch；失败仍由既有修复任务恢复
  → D1 变更版本 → 经权限检查的 SSE → 浏览器查询失效与增量追赶
```

Webhook 的 `data`、商品名称、状态、价格、用户类型等**不作为业务事实直接入库**。它们只提示读取哪些对象；买家身份、正文、包裹状态等来自使用该店铺凭证读取的 Ozon 响应。

### 存储

迁移：`migrations/0070_ozon_push.sql`。

- `sync_bootstrap`：全局 `startup` 标记和逐店 `completed_at` 标记，确保启动引导只执行一次；新店铺由连接检查显式触发。
- `store_push_endpoint`：每店铺独立配置、地址密钥哈希及 AES-GCM 密文、握手、切换状态与健康时间。
- `ozon_push_event`：归一化实体提示、幂等键、处理进度、处理租约、重试和需核对状态；不保留原始回调正文。
- `ozon_push_chat_head`：由聊天历史**第一页**确认的最新买家/卖家消息。迁移前及回滚扫描也维护该投影；Forward 尚未追赶完时不认定当前 AI 输入。迟到通知、旧历史页不会把当前输入退回旧消息，同时间戳也不靠随机本地 ID 判断平台先后。
- `ozon_push_live_message`：真实新消息的已核对 live 证据。模拟、历史回补、已由卖家回答的旧消息不据此触发 AI；历史观察收到真正的新消息通知后，可在证据约束下晋升，而不改写正文。
- `store_change_revision`：授权店铺的轻量变更版本，含已读/回显等原地更新版本。

队列与辅助表通过租户/店铺外键关联。重新生成地址使旧 URL 失效，但已持久化的旧代通知仍可恢复处理；在途读取则由协调器 fence 阻断。

### 有界处理与恢复

- 每次处理至多一个平台请求，沿用店铺共享的读/发送限速和 20 秒同步租约；收件处理租约为 30 秒，过期后可恢复。
- 平台读取继续使用 `readOzonJSON()` 的白名单、8 秒超时、取消、1 MB 响应限制、逐字段校验与 int64 字符串保护。
- 回调体上限 1 MB；只持久化必要提示。`TYPE_NEW_MESSAGE` 按店铺、地址代、聊天与消息 ID 去重，正文不参与生成 AI 输入。
- 失败指数退避，遵守更长的 `Retry-After`；429 写入共享冷却。同一未完成阶段失败达到 8 次或出现永久错误后转“需处理”。权限失败停止对应来源，凭证失败停止所有来源。
- 成功写事实、随后进程退出也可重放：平台消息唯一键、原 ingest outbox 和控制器 receipt 防止重复自动回复。
- 定时任务只修复内部 AI、控制、财务任务；Ozon 增量只能由 Webhook 或管理员显式回补触发。启动引导完成后，Webhook 初次唤醒失败时不提供定时兜底，需通过 Push 面板重试或等待下一次通知。

## 接入能力

| 通知 | 处理 |
| --- | --- |
| `TYPE_PING` | 返回 `version` / `name` / UTC `time`，记录协议握手 |
| `TYPE_NEW_MESSAGE` / `TYPE_UPDATE_MESSAGE` | 读取对应聊天历史；未知聊天先有限分页核对 `BUYER_SELLER` 元数据 |
| `TYPE_MESSAGE_READ` | 刷新聊天已拉取窗口内的权威已读标记，不根据提示猜测整段历史已读 |
| `TYPE_CHAT_CLOSED` | 核对平台聊天列表并更新状态 |
| `TYPE_CREATE_OR_UPDATE_ITEM` / `TYPE_STOCKS_CHANGED` / `TYPE_PRICE_INDEX_CHANGED` | 读取相关商品详情，再用商品 ID 过滤读取列表中的库存/归档标记；SKU 必须唯一关联，不能猜商品 |
| `TYPE_NEW_POSTING` / `TYPE_STATE_CHANGED` / `TYPE_POSTING_CANCELLED` / 日期变更 | 读取对应 FBS 包裹详情，不把通知状态当作最终状态 |

FBO / FBP 不假定存在覆盖完整生命周期的通知：本版保留各自原生接口的**人工回补**。包裹默认人工回补最近 30 天，更早范围继续使用原历史导入面板；其进度、取消、恢复及详情补齐沿用原事务机制。

商品通知也不保证覆盖每个字段；缺少通知或平台未提供对应能力时，管理员需要明确执行回补。缺失接口结果不会被推断为删除、零库存、零费用或完整财务资料。

### 不可变消息冲突

若权威接口返回的正文/不可变字段与已保存消息冲突，保留原记录，通知进入需核对状态，并阻断该会话 AI 输入准入、模型授权和对外发送。冲突页不半页提交，同页的新消息也会等待核对，本地可能仍是旧快照；人工发送权限保留，但应先到平台核对完整对话再回复。失败重试、换地址不会抹掉该阻断。只有重新核对成功才清除对应冲突。

**本版不实现任意历史正文的版本编辑器**，不以覆盖已经被引用的事实来假装“编辑同步成功”。平台原始内容未恢复一致时，应人工处理并安排版本化修复。

## 本地操作

以下切流步骤仅用于隔离测试店铺/数据库。现有真实店铺在公网通知验证前保留原有同步，不要为了本地调试中断实际更新。

1. 在“店铺管理 → 店铺详情 → Ozon Push 同步”生成回调地址。
2. `seller_id` 可选；确认平台通知标识后再绑定，**不要假定它等于 Client ID**。本地店铺始终由独立地址密钥确定，绝不由请求体选择。
3. 本地模拟器先发送默认 `TYPE_PING`，验证真正的接收路由。
4. 确认“切换为 Push”，并开启需要处理的来源。注意：没有公网通知时，真实店铺的后续变化不会自行被发现。
5. 在模拟 JSON 中填写真实平台实体 ID。后台仍核对真实 Ozon 事实，不接受凭空构造的买家正文；所有本地模拟都不触发 AI 自动回复。
6. 查看队列与失败原因，按需重试或执行一次回补。另开消息/商品/订单页面，可验证无需手动刷新的页面更新。

示例（ID 为示意字符串，须替换）：

```json
{"message_type":"TYPE_NEW_MESSAGE","seller_id":"123","chat_type":"BUYER_SELLER","chat_id":"actual-chat-id","message_id":"9007199254740993"}
```

```json
{"message_type":"TYPE_CREATE_OR_UPDATE_ITEM","seller_id":"123","product_id":"9007199254740993"}
```

模拟器仅在 `APP_BASE_URL` 为环回地址时可用，匿名调用正式路由并附加只能**降级禁止自动回复**的模拟标记。正式部署拒绝带此标记的请求，绝不忽略标记后把模拟提升为真实通知。模拟健康时间与正式通知接收时间分开，模拟不会伪造正式送达证据。真实链路测试使用隔离的 D1/SQLite 与外部 API 替身，不操作真实买家。

## 云端启用检查（本次未执行）

1. 用项目既有 Wrangler 发布流程应用迁移并配置协调器；保留原凭证加密密钥版本。迁移已有数据库时，还需制定数据和运行中任务的迁移方案，不能只复制 URL。
2. `APP_BASE_URL` 为正确站点 HTTPS origin；有独立公开回调域名时，可设置 `OZON_PUSH_PUBLIC_BASE_URL`（只接受 origin，不含路径/凭证/查询串）。
3. 回调地址是独立随机 bearer capability，不是 Ozon 官方 HMAC 签名。必须使用 TLS，并对网关/访问日志中的回调路径脱敏；不能公开截图或粘贴。可在边缘额外设置适合业务流量的限流。
4. 先检查该卖家/密钥实际可用的 Push 类型及**已有订阅**，再配置 URL。不要覆盖其他系统的订阅；同一种通知可能只能指向一个地址。
5. 通过 Ozon 实际握手、真实变更、事实入库、失败恢复和页面更新逐项验证，再确认正式切换。协议握手成功本身不证明公网真实事件覆盖。

本版不调用请求契约尚未核实的通知管理 API，也不虚构回调签名、`auth_header` 或订阅成功状态。官方资料优先：

- <https://docs.ozon.ru/api/seller/>
- <https://dev.ozon.ru/start/489-Gaid-po-nastroike-i-upravleniiu-Push-uvedomleniiami-cherez-Seller-API/>
- <https://dev.ozon.ru/start/488-Novye-chaty-Seller-API/>

## 浏览器与验证

`GET /api/companies/:companyId/events` 是独立的浏览器 SSE，不是 Ozon 的传输方式。只发送授权店铺版本及当前角色，不发送正文、API Key 或回调密钥；连接中持续核对会话、成员和店铺授权。断线由 EventSource 重连；消息中心保留有界增量追赶、失败读取的有限重试、草稿和历史阅读位置，不恢复空闲轮询。

验证命令：

```sh
npm run check:types
npm test
npx playwright test --config tests/e2e/playwright.config.ts tests/e2e/ozon-push.spec.ts tests/e2e/message-catchup.spec.ts
npm run build:node
npm run build
node --test tests/integration/ozon-push-cloudflare.test.ts
npm run db:check
```

`tests/integration/ozon-push-cloudflare.test.ts` 直接加载生产编译产物，在 Miniflare 中验证真实 StoreCoordinator、持久接收、去重、canonical 读取、int64 保留及模拟禁止自动回复，不依赖旧 Vite dev fixture。

关键测试：`tests/ozon-push-http.test.ts`、`tests/ozon-push-worker.test.ts`、`tests/node-ozon-push.test.ts`、`tests/realtime-http.test.ts`。浏览器场景使用隔离 Node 实例及独立编译目录，不复用真实店铺预览数据。自动删除策略仍遵循现有待审批保留政策；治理清单单列回调密文、规范化标识及 live/head 证据，删除与备份恢复不能重新激活旧地址。

### 本地现有预览验收（2026-11-03）

`http://127.0.0.1:5173` 已更新至 Node 24。迁移前离线备份业务库及对象运行状态，并在副本演练，再应用待迁移的 0069 / 0070。0069 涉及的旧辅助表均为空；84 张保留原表的原有列逐表计数与内容摘要一致，外键检查为零异常。备份及审计位于 `test-results/local-preview-backups/ozon-push-2026-11-03T12-52-28-515Z/`。

实际浏览器验证桌面/窄屏 Push 面板、SSE 连接、商品与核算页面可读取，无未捕获页面异常。真实店铺保持“尚未配置”，未生成回调密钥、未切流、未发布云端；这不构成 Ozon 公网送达证明。截图位于 `test-results/ozon-push-live/`。
