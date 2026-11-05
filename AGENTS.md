# AGENTS.md

面向 AI Agent / 协作开发者的项目约定说明。

## Ozon Seller API 集成

### 官方文档链接

- **API 参考手册（主文档）**：<https://docs.ozon.ru/api/seller/>（默认俄语，右上角可切换英语）
- **开发者门户**：<https://dev.ozon.ru/>（接入指南、接口与权限角色映射、密钥管理）
- **接口-角色映射表**：<https://dev.ozon.ru/start/300-Mapping-rolei-i-metodov-Seller-API/>
- **API 基地址**：`https://api-seller.ozon.ru`，认证用请求头 `Client-Id` + `Api-Key`

中文第三方镜像（如 apifox 翻译版）更新可能滞后，涉及字段细节以官方文档为准。

### 无官方 SDK，使用手写 fetch 封装

Ozon **不提供官方 JavaScript/TypeScript SDK**（社区 SDK 主要是 Python/C#）。本项目直接用 `fetch` 调官方 REST 接口，封装在 `src/modules/ozon/read.ts` 的 `readOzonJSON()`，而不是引入第三方依赖。原因：跑在 Cloudflare Workers 上，零依赖且可控（尤其 int64 精度与响应校验是通用 SDK 处理不好的）。

调用层约定（改动前必须了解）：

- **端点白名单**：只允许调用 `readOzonJSON` 中明确列出的接口，新接 Ozon 能力时需先在白名单加入端点路径，并同步更新 `readOzonJSON` 的参数类型联合。
- **8 秒超时** + 外部 `AbortSignal` 取消透传。
- **响应严格校验**：响应体上限 1MB，逐字段类型校验，不合规格抛 `invalid_response`，不带病继续。
- **int64 ID 保护**：`product_id`、`sku` 等字段是 64 位整数，JSON 解析时以原始字符串保留，避免 `Number` 丢精度（`tests/products-ozon.test.ts` 有专门验证）。
- **错误分类**：401→`invalid_credentials`、403→`permission_denied`、429→`rate_limited`（读取 `Retry-After`）、超时/网络错误分开。

### 当前使用的接口

| 接口 | 用途 | 代码位置 |
|---|---|---|
| `POST /v3/product/list` | 商品目录列表（cursor 分页） | `src/modules/products/ozon.ts` |
| `POST /v3/product/info/list` | 商品详情（含 `created_at` 上架时间） | `src/modules/products/ozon.ts` |
| `POST /v3/chat/list`、`/v3/chat/history` | 买家聊天消息同步 | `src/modules/sync/` |
| `POST /v4/posting/fbs/list`、`/v3/posting/fbs/get` 等 | FBS/FBO/FBP 包裹查询 | `src/modules/postings/` 等同步模块 |

### 商品上架时间（created_at）

- `POST /v3/product/info/list` 响应中的 `created_at` 是 Ozon 平台的商品创建时间（ISO 8601，微秒精度，UTC），即商品的真实上架时间。
- 解析入口：`src/modules/products/ozon.ts` 的 `timestamp()`（校验 ISO 8601，容忍微秒与时区后缀，缺失返回 null）。
- 落库：随商品详情快照写入 `product.facts` JSON 的 `createdAt` 字段（`src/modules/products/storage.ts`）。
- 展示与筛选：商品详情页「上架时间」；商品列表筛选的「上架时间」区间即基于此字段（`src/modules/commerce/storage.ts`）。
- 注意：存量商品需等详情同步刷新一轮后才有该字段，此前为 null，筛选弹层提供「缺失」选项筛出这部分商品。

## 其他约定

- 数据库为 Cloudflare D1（SQLite 方言），migrations 为手写 SQL（`migrations/*.sql`），JSON 字段查询用 `json_extract`。
- 全链路类型校验使用 Valibot（后端与前端 schema 共享风格）。
- 分页为不透明 cursor（base64url 编码），列表接口在返回页数据的同时返回过滤后的总数与总页数（参照 `listCommerceProducts` / `listOrderPostings`）。
- 测试：`npm test`（node:test + Miniflare）；类型检查 `npm run check:types`。改动后两者必须通过。
