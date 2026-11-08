# 生产加固首轮（2026-11-04）

这是本地确定性回归与发布合同的加固记录，**不是完整生产验收结论**。原架构、实施进度和验收文件的历史章节保留为升级依据；本页与当前部署文档说明以下行为变更。

## 并发与最终授权

- Node 对象存储事务使用 `async-mutex`，显式 `blockConcurrencyWhile` 使用输入门控与 `AsyncLocalStorage`。普通 RPC 不全局串行，避免工具回调原控制对象时死锁；显式临界区内，后续 RPC/闹钟不得越过保护边界。发起平台请求仍在短临界区内，网络响应不占用整段门控。
- 同一异步保护链允许重入；存储操作也经输入门控，因此早已进入 RPC、后来才完成授权的异步续段不能穿过发送临界区。事务上下文在结束后失效，后台任务不能继承过期事务权限。正常事务回滚不使对象失效；构造函数无法 await 的初始化拒绝由宿主管理。
- 显式保护失败后，该 Node 实例拒绝后续事件，直到进程重启；先核对原持久状态，不能把重启视为可以重发 unknown 消息。此策略保守关闭，不宣称完全复刻 Cloudflare 的实例重建机制。
- 商品货源的新增、修改、清空在最终 SQL 重新检查当前 session、邮箱验证、成员与管理角色；前面的 HTTP 检查不是长期授权。拒绝修改时不覆盖已有值；有权重复清空返回成功的空结果。
- 发送幂等、原 intent/receipt、单次平台尝试与 unknown 核对规则不变。

## 预算、价格与自动回复

- 新 AI 准入只选择明确配置且唯一、范围适用、启用、在有效期、金额和次数足够的预算。缺失、歧义、暂停、耗尽均不可用；不自动创建 unlimited 预算。历史 `ai-unbounded-*` 只为原运行结算保留。
- 仅保存/测试模型连接不推断价格、限额或外发授权。执行表单完全留空时保存 `execution:null`；部分填写拒绝保存。四项价格均需明确核实，显式免费可填零，未知不能当零。翻译配置也必须提供完整价格，不再隐式免费。
- 新的 AI 接待运行始终使用 `support-reply-v2` 直接回复；内部草稿模式和 `autoReply` 控件已移除，历史字段仅作兼容读取。直接回复仍受部署、店铺、策略、控制状态、依据和最终发送门禁约束；公司的生成轮数与回复权限不被部署默认配置覆盖。
- readiness/degradation 使用公司实际配置与可用预算，不把“保存过连接”或“存在某个预算”当成可执行。

## 完整文本检索与旧发布

- `0071_knowledge_text_search.sql` 使用 SQLite 原生 FTS5 trigram 索引，回填既有 chunk，并随新增/删除维护派生索引。Node、Vercel、D1 使用同一检索合同；不新增第三方搜索服务。
- 授权范围、语言、active revision 与发布证明在 SQL 中应用，再排名、限制结果；不再截取最前 500 块后才匹配。Unicode 规范化、俄语大小写及中文检索有回归；两个字符的词走范围内 substring 查询。短词路径可能扫描较多行，不宣称已完成生产容量验证。
- 当前功能是关键词/子串匹配，不是语义召回或答案正确性证明。读取和 citation 重验仍查询权威业务表。
- 旧向量发布必须保有完整的原始审核/索引/发布证明。Markdown 缺失时从合法 source JSON 重建，不拼接重叠 chunk，也不伪造新审批。证据不完整的版本需重新人工发布。

## 不丢历史的升级

迁移编号、内容及 DO 历史标签不改写。迁移执行层在删除已知退役表前冻结、归档并验证原始行，保留恢复用原表 SQL，档案拒绝普通写入。Cloudflare 发现历史行时先阻断，须备份、停止旧作业并明确选择 `--archive-retired`；Node 在单写者锁和迁移事务内完成。详见[升级和回滚](10-upgrade-and-rollback.md)。

**已经被旧版 0069 删除的数据必须从合格备份恢复，不能靠新迁移补造。** 归档仍在同一数据库中，不替代独立备份；中断的远程归档可能已冻结源表，需人工核查，不自动解冻/重放。

## 验证入口

```sh
npm run check:platforms
npm test
npm run test:upgrade-local
npm run test:knowledge-evaluation-local
npm run test:portable
node --test tests/integration/build.test.ts
npm run test:web:portable
npm run test:web:cloudflare-smoke
npm run check:release
```

本轮已执行结果（Node 24.22.1，均为本地合成数据）：

| 检查 | 结果 |
| --- | --- |
| 完整 `npm test` | 1148 通过，0 失败、0 跳过 |
| 平台类型检查、release/license 检查 | 通过；许可证特殊条款仍需发布方复核 |
| 临时目录 Cloudflare/Node 构建及编译产物/native 集成 | 14 通过，含真实 workerd Pi 翻译与 Push、Node SIGKILL 恢复、前后端隔离 |
| `test:upgrade-local` | 20 通过 |
| 当前便携浏览器回归 | 15 通过，含图片同源网络断言 |
| 编译 Cloudflare 浏览器文件导入 | 1 通过 |
| Pi runtime 包测试、Cloudflare 部署 dry-run | 通过；没有远程迁移或部署 |

构建使用临时目录，没有覆盖原 Node 服务的产物，也未重启该服务。GitHub Actions 已新增工作流并校验 YAML；尚未声称远程 CI 已执行。浏览器不再以“Vite 成功送出文件”当作 Pi Worker 可运行；Cloudflare 夹具使用实际编译的 Worker，意外模型请求在本地拒绝。

新增重点回归：`tests/node-objects.test.ts`、`tests/product-sourcing.test.ts`、`tests/knowledge-search.test.ts`、`tests/retirement-migration.test.ts`、模型/翻译准入与表单测试，以及当前文本发布、模型设置、Push/SSE 浏览器用例。CI 使用锁定依赖，无生产密钥、真实邮件、模型或 Ozon 业务请求。

历史 `test:web` 全集仍包含旧向量/回复测试台场景；未转换的场景不能冒充当前功能覆盖或全套通过。当前发布子集显式使用 `test:web:portable`，不是把旧断言静默删除。

## 尚未由首轮解决的生产事项

- 真实供应商价格、模型事实正确性、真实 Ozon 送达/回显及账号权限验收。
- 生产流量下 FTS 短词性能、JSON 查询计划与 SSE 每连接数据库读取成本。
- 后台错误的统一可观测性、告警与故障处置；Node 门控失败需要可见的重启流程。
- 数据保留、公司停用/删除、完整跨服务备份恢复和灾难演练。旧 Workflow 的停止及在途调用核对仍需运营者用原部署确认；归档不是 D1/Workflow/供应商之间的全局事务。
- 历史浏览器/原生夹具向当前 Pi 与文本知识合同的完整迁移。

这些事项需独立证据和复核，不能因本地测试数量增加而视为完成。
