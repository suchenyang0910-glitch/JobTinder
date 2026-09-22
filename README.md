# JobTinder

内部项目代号：**JobTinder**。首发市场：**柬埔寨，全部岗位类别**。具体城市与真实库存待确定；对外定位为 Swipe-to-Job / Job Matching Network，正式品牌另定。

> 免费，合适，真实，避免浪费时间。

2026-09-21 确认的规则：

- 企业和求职者完全免费，匹配与联系不收费。
- 技能、行业、岗位及工作内容为匹配主干；明确必须条件冲突不展示，未知不当作满足。
- 企业官网未公开薪资的岗位照常展示，薪酬显示“面议”，注明“官网未公开薪资”；不因薪资缺失隐藏，也不认定已满足期望薪资。
- AI 整理现有描述或简历/JD，由本人检查、修改和确认。
- 入驻双方对同一岗位互相感兴趣后立即开放联系；分享规则在发兴趣前说明。
- 收到站内兴趣后 24 小时应处理，未处理提醒；超过 72 小时未回复暂停相关推荐。招满或找到工作及时退出。
- 前期每日采集企业官网招聘信息，标明来源与核查时间；企业未入驻时跳转官网申请，不冒充站内双向匹配。

平台负责信息整理、条件匹配与联系入口；不承诺面试、录用或实际待遇，仍提供来源、纠错、失效撤下和举报处理。

## 文档

- [产品定义](docs/JobTinder-V0.1-产品定义.md)：已确认规则、两条岗位路径、AI 建档、采集、匹配、计时与验收。
- [Telegram Bot 交互流程](docs/JobTinder-V0.1-Telegram-Bot交互流程.md)：求职、招聘、官网申请、立即联系及暂停恢复。
- [Trae 开发交接文档](docs/JobTinder-V0.1-Trae开发交接文档.md)：开发顺序、数据模型、接口行为与 P0 验收标准。
- [视觉设计规范](docs/JobTinder-V0.1-视觉设计规范.md)：参考 PayEase Style 的 Token、页面语气、组件状态、动效与三语可访问性。
- [技术架构与代码边界](docs/JobTinder-V0.1-技术架构与代码边界.md)：目录边界、状态机、服务接口、采集器、通知和测试边界。
- [Telegram Bot 创建清单](docs/JobTinder-V0.1-Telegram-Bot创建清单.md)：BotFather、环境、数据库、双账号测试、安全和上线检查。
- 修订前两份文档保留在 `docs/archive/before-2026-09-21-revision/`，仅作历史参考。

当前仅完成设计文档，尚无 Bot、爬虫、运行服务、真实企业接入或试点结果。上述每日采集与 24/72 小时机制均为待实现要求；本次没有创建定时任务。演示企业、人物和岗位不是真实库存。

---

## 阶段一：本地启动与质量门禁（V0.1）

### 前置要求

- **Node.js** ≥ 20.11（已验证 v25.9.0）
- **pnpm** ≥ 10（已验证 v10.28.2）
- **PostgreSQL** 16（本地或 Docker；默认 `postgresql://postgres:postgres@localhost:5432/jobtinder`）
- （可选）**Docker**：用于运行 `RUN_INTEGRATION=1` 的 Testcontainers 集成测试
- （可选）**Telegram Bot Token**：通过 `@BotFather` 获取；不填时 Bot 仍能启动，但处于禁用模式

### 一键启动

```bash
# 1. 安装依赖
pnpm install

# 2. 环境变量
cp .env.example .env      # Windows: Copy-Item .env.example .env -Force
# 打开 .env，填入:
#   - DATABASE_URL           (指向你的 Postgres 16)
#   - TELEGRAM_BOT_TOKEN     (可选，@BotFather 申请；不填则 Bot 禁用，其他模块正常)
#   - APP_HASH_PEPPER        (≥32 位随机字符串，用于审计指纹哈希)
#   - TELEGRAM_SESSION_SALT  (任意长随机字符串，用于会话键)

# 3. 校验环境变量 + 生成 Prisma Client
pnpm env:validate
pnpm prisma:generate

# 4. 生成并执行数据库基线迁移（首次必跑）
pnpm prisma:migrate --name baseline        # 生成本地 migration SQL
pnpm prisma:migrate:deploy                 # 等价的生产式部署命令（CI/服务器）

# 5. 质量门禁（CI 顺序执行，exit ≠ 0 即失败）
pnpm exec tsc --noEmit                     # TS 严格检查（0 error 才过关）
pnpm lint                                  # ESLint9 + Prettier
pnpm test:unit                             # 33 个 domain 纯函数 UT
RUN_INTEGRATION=1 pnpm test:integration    # PostgreSQL 集成测试（需 Docker）

# 6. 启动
# 终端 1: 主服务（NestJS + grammY Bot；默认 FASTIFY，3000 端口仅健康检查）
pnpm start:dev
# 终端 2: Outbox Worker（发布通知异步消费；V0.1 为 no-op，跑通生命周期即可）
pnpm worker:outbox
```

### 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `pnpm exec tsc --noEmit` | 类型检查（**第一门禁，优先跑**）|
| `pnpm lint` | ESLint 9 flat config + Prettier |
| `pnpm test:unit` | Vitest 跑 `src/` 下的 4 个 domain 状态机 UT |
| `RUN_INTEGRATION=1 pnpm test:integration` | Testcontainers PG16 跑 `test/integration/` |
| `pnpm env:validate` | Zod 校验 `.env`，逐字段脱敏打印 |
| `pnpm prisma:generate` | 生成 `@prisma/client` 类型（schema 变了必跑）|
| `pnpm prisma:migrate --name <tag>` | 生成并应用迁移（本地开发）|
| `pnpm prisma:migrate:deploy` | 迁移部署（CI/服务器，不生成新 SQL）|
| `pnpm start:dev` | NestJS 开发模式（带 watch）|
| `pnpm worker:outbox` | Outbox Worker 独立进程（通知消费）|

### V0.1 已交付能力清单（Bot 侧可测）

1. **Bot 交互（grammY + PostgreSQL 会话）**
   - `/start` → 三语 Inline 键盘（km/zh/en）→ 用户 Upsert → 角色选择（CANDIDATE/COMPANY/BOTH）
   - `/profile` → 草稿创建或从已发布克隆 → 三步步进建档（目标岗位 → 技能 → 行业）→ 预览 → Inline 确认/修改
   - `/menu /help /cancel /matches /settings /delete` — 未实现的功能给出 "Stage-2 coming" 提示，不泄露任何异常
   - 所有命令统一走 `safeRun()`：`AppError → translateAppError → i18n 文案`，永不泄露堆栈
2. **三语 i18n**（手搓强类型，未用 typesafe-i18n 运行时；包仍保留供未来生成器）
   - `🇰🇭 ខ្មែរ / 🇨🇳 中文 / 🇬🇧 English`，所有文案字段都是 0/1 参函数，调用风格统一 `T.FOO.BAR()`
3. **后端健壮性（P0 功能）**
   - 稳定字符串错误码枚举：`AppErrorCode`（55 个左右，按 `VERSION_ / IDEMPOTENT_ / PROFILE_ / AI_ / ...` 分组）
   - `expectedVersion` 乐观锁：`updateDraft` / `confirm` 在事务内部读取当前版本，冲突抛 `VERSION_MISMATCH`，整体回滚
   - 幂等键构造器 `IdempotentKeyBuilder`：6 类（interest / match / notification / 24h-reminder / 72h-pause / crawl）
   - `Clock` 接口 + `SystemClock` 生产实现 + `FakeClock` 测试实现（可 `advanceDays / advanceHours`）
   - Outbox 表 + Worker：V0.1 Worker 为 no-op logger，状态机 `PENDING → PROCESSING → SUCCEEDED / PENDING(retry) / DEAD` 已跑通
   - grammY Session 持久化 Postgres `sessions` 表，30 天 TTL，禁止 PII 写入
   - AI Provider 抽象：`AIExtractProvider` + `MockAIProvider` 默认（V0.1 无 AI 调用），后续可接 Ollama/DeepSeek/OpenAICompatible
   - `AuditRepository` 强制 `AUDIT_METADATA_SAFE_KEYS` 白名单，物理拦截手机号/邮箱/薪资/Token 进 audit_events；Telegram 用户 ID 落库的是 peppered hash，非明文
4. **测试与质量**
   - `tsc --noEmit`：0 errors（strict + `noUncheckedIndexedAccess: true`）
   - `pnpm lint`：0 errors（ESLint 9 flat config + TS recommended + prettier/warn）
   - `pnpm test:unit`：33 / 33 个 domain UT 全部通过（Job 16、Interest 6、Match 7、Profile 4）
   - `test/integration/candidate-onboarding.integration.test.ts`：Testcontainers PG16，默认 `RUN_INTEGRATION` 不开启

### V0.1 尚未实现（V0.2+）

- 企业/招聘者建档对称实现（当前 CANDIDATE 先跑通）
- Interest / Match 状态机落地（Application 层，已在 Domain 写好纯函数）
- 真实 AI Provider 实现（Ollama / DeepSeek / OpenAICompatible 类与 key）
- 24 小时提醒、72 小时暂停推荐的 `@Cron` 定时任务
- 爬虫模块（crawl_runs 表已建，但 `@nestjs/schedule` 的爬取循环未写）
- 通知 Outbox 的真实 Telegram 消息发送（当前 Worker 为 no-op logger）
- H5 视觉规范落地（PayEase Style Token、48px 触控、圆角等）—— 当前为 Bot-only
- 真实 Telegram 双账号 E2E 验收：申请 Bot token → 两个真实账号跑通建档 + Match + 联系方式

### 验证 Checklist（交接文档 §9 推荐）

| 项 | 命令 / 方法 | 当前状态 |
| --- | --- | --- |
| TS 严格模式 | `pnpm exec tsc --noEmit` | ✅ 0 errors |
| Lint + Prettier | `pnpm lint` | ✅ 0 errors |
| Domain 单元测试（33）| `pnpm test:unit` | ✅ 33 passed |
| Zod env 校验 | `pnpm env:validate` | ✅ Environment OK |
| Prisma Client 生成 | `pnpm prisma:generate` | ✅ exit 0 |
| **基线迁移 SQL 生成** | `pnpm prisma:migrate --name baseline` | 需本地 Postgres（暂未执行，schema 已就绪）|
| **集成测试** | `RUN_INTEGRATION=1 pnpm test:integration` | 需 Docker+Testcontainers（代码就绪，未执行）|
| **真实 Telegram E2E** | 填 token → 启动 → 双账号走 `/start → 角色 → /profile → 确认 → Match` | 需 Bot token + 真实账号（代码就绪，未执行）|
