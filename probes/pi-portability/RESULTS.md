# Pi Durable 三端执行探针结果

验证日期：2026-10-29（Asia/Shanghai）。本次在独立探针中安装发布包并运行测试；主应用仍使用原来的 Flue/Cloudflare 实现。三端完整应用支持尚未交付。

## 已执行结果

| 环境 | 实际执行内容 | 结果 |
| --- | --- | --- |
| 本机 Node + SQLite | 并发同键提交；工具等待时 SIGKILL；新进程打开原磁盘、续接原回执；完成后再开新进程读取 | 通过 |
| durable-harness + 本地 World | 相同工具与模型；SIGKILL 后由注册的 World 队列在启动时自动恢复；被动读取器刷新后先观察完成及原始转录，再读取终态 | 修正观察器后复跑通过 |
| 本地 Cloudflare workerd | PiHarness、DO SQLite、并发去重、对象强制重置、独立 Gate DO 观测闹钟恢复、取消和终态重开 | 通过 |
| Cloudflare 真云 | 独立临时 Worker；同一组恢复与取消合同；重新部署后在不重新提交的前提下读取原成功/取消回执 | 通过；两次部署版本不同，新增模型调用为 0，临时 Worker 已删除 |
| Vercel 真云 | 官方 `durable-harness/pi-durable`、World 和原生队列；真实 Function 超时；仅被动观察队列恢复；重新部署后读取原回执 | 通过；两个部署 ID 不同，新增模型调用为 0，测试运行已取消且临时项目已删除 |

最新本地执行为 3 组测试通过、0 失败，包含上述 Node、World 和 workerd 场景；增加 World 被动转录断言后，定向复跑另通过 1 组。独立严格 TypeScript 检查和 Wrangler dry-run 构建通过。Cloudflare 成功运行时间为 17:41:30–17:43:01，Vercel 为 19:19:22–19:22:07（均为 Asia/Shanghai）。版本、检查项、哈希和清理状态见 [evidence.json](evidence.json) 与 [vercel-evidence.json](vercel-evidence.json)；本机详细记录在忽略目录 `test-results/pi-portability/`。

观察器修正：初版 World 被动读取漏掉 `reader.refresh()`，空快照不能证明队列完成。已修正本地及 Vercel 读取器，并要求原用户输入、完成文本、非空事件/提交以及独立工具调用记录。初版本地结果中的被动完成证据由修正后的复跑替代；遇到同一问题的 Vercel 尝试按失败记录，没有计入通过。

Vercel 返回 HTTP 504 / `FUNCTION_INVOCATION_TIMEOUT`（10,348 ms）；超时后被动观察为未完成，随后原生队列完成原提交。已完成工具调用 1 次；安全等待工具以同一任务 ID、不同 Harness opener 执行 2 次；合成模型调用共 3 次，用户输入只有 1 条。重新部署后原回执仍为 `done`，无新增模型或工具调用。执行层没有使用 Sandbox、Drive、外部数据库或真实供应商。实现及复跑方法见 [VERCEL.md](VERCEL.md)。

Vercel 两次部署均 Ready 且 HTTP/队列检查通过，但云端 Node builder 输出缺少 `node` 和 `@cloudflare/workers-types` 类型声明的 TS2688 诊断；本地独立严格类型检查通过。该构建配置尚不能作为无诊断的生产发布模板。

恢复验证要求：已完成的 `fixture_prepare` 只执行一次；中断且标记安全重放的 `fixture_wait` 以同一个任务 ID 再执行；Cloudflare 记录不同对象启动 ID；最终只出现一条用户输入。完成后的存储重开/云端重新部署不再调用模型。所有模型调用均由合成 faux provider 完成，没有真实供应商请求。

## 实测发现的合同差异

**相同 requestId/operationId 配上不同正文，会返回原提交，而非 Flue 的载荷冲突拒绝。** Node SQLite、World 与 PiHarness 均观察到这个行为。它符合本探针对原生行为的记录，但不满足直接替换 DingBell 提交合同的要求。

迁移时保留现有冻结输入、稳定业务键和载荷指纹校验，在交给原生去重前拒绝同键不同载荷；不能只替换 import 或将 Pi 的原生去重当成完整业务幂等。费用许可、接管版本和未知发送结果也仍需由原业务合同约束。

Cloudflare 前两次云端尝试分别遇到访问错误、鉴权探针的意外 404，均未记为通过，临时 Worker 均已删除。增加有上限的只读就绪等待后，完整云端合同与重新部署检查通过。这与新路由就绪延迟相符，但没有单独确认失败请求的根因；没有为绕过这些问题自动重放发送或取消操作。

## 锁定组合与依赖检查

| 组件 | 版本 |
| --- | --- |
| Node | 本机 24.22.1；Vercel Functions 24.21.0 |
| Pi Durable / Pi AI / Chord | 1.4.0 |
| Cloudflare Agents SDK | 0.30.0 |
| durable-harness | 0.0.1 |
| Workflow World | 5.0.5 |
| Local World | 5.1.2 |
| Vercel World（真云验证） | 5.2.3 |
| Wrangler | 4.155.0 |
| TypeScript | 7.0.2 |

探针中三个 Pi 包各只有一份锁定版本。锁文件共 444 个包记录（含开发工具及不同平台的可选包），版本、integrity 和 license metadata 均完整。锁文件中的 sharp/libvips 平台包含 LGPL 相关表达式，caniuse-lite 为 CC-BY-4.0；正式引入生产时须一并进入项目现有许可证清单与发布评审。本次没有修改生产依赖，也没有据此作再分发许可结论。

Cloudflare 探针 dry-run 上传大小为 1180.46 KiB，gzip 226.32 KiB。这是合成探针的构建结果，尚未与 DingBell 的 Flue 完整产物比较，不作为运行成本、冷启动或体积减幅承诺。

## 尚未验证

- Vercel 任意重复投递、应用级取消语义、多会话并发及无诊断的生产构建配置。
- DingBell 全套业务数据、权限、预算、知识、文件、发送器在新运行时的接线和回归。
- Flue 历史回执、未完任务与数据迁移；Pi 存储版本升级；停电/主机故障恢复。
- 多节点执行归属、生产负载、真实模型语义质量、真实 Ozon 外发和实际费用。

结论：锁定组合具备进入业务迁移验证的执行层基础；完整应用三端验收仍按 ADR-11 分项推进。

另一个 [Sandbox/Drives 原生存储探针](../vercel-native/README.md)已通过真云 SQLite 持久性、进程中断、单写入和清理检查。它仅为业务存储候选提供底层证据；本目录的 Pi/World Agent 独立使用 World/队列，不依赖该存储探针。
