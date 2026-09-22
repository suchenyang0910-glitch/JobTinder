# JobTinder V0.1 技术架构与代码边界

版本：2026-09-21｜交接对象：Trae｜状态：开发基线

## 1. 架构目标

先交付一个可验证的单体服务，保持 Bot、官网采集、匹配和通知的边界清楚。不要因为未来可能扩展全柬埔寨而提前拆微服务。

推荐分层：

```text
Telegram Adapter / Admin Web
        ↓
Application Services
        ↓
Domain Rules
        ↓
Repositories + Job Queue
        ↓
PostgreSQL / Telegram / AI Provider / Official Websites
```

## 2. 代码目录边界

如果项目尚未初始化，可按以下结构创建：

```text
src/
  adapters/
    telegram/          # update、callback、菜单和消息格式，不写业务规则
    http/               # 健康检查、内部管理 API、错误映射
  application/
    onboarding/         # 建档、草稿、确认
    jobs/                # 岗位发布、认领、关闭
    matching/            # 推荐、兴趣、Match
    contacts/            # 联系方式告知与开放
    notifications/       # 提醒和通知队列
    crawling/            # 来源调度、抓取运行、岗位同步
  domain/
    profiles/            # 求职卡与确认版本
    companies/           # 企业和负责人权限
    jobs/                # 岗位、来源、生命周期
    matching/            # 硬条件、相关性、版本一致性
    trust/               # 来源状态、举报、屏蔽、审计
  infrastructure/
    db/                  # migrations、repositories、事务
    queue/               # outbox、重试、定时任务
    ai/                  # 提取接口、提示词、脱敏和降级
    web/                 # HTTP client、限速、解析器
  shared/
    i18n/                # zh-CN/en/km 翻译键
    validation/          # 输入与权限校验
    clock/               # 可注入时钟，方便测试 24/72 小时
```

### 2.1 允许的依赖方向

- `adapters` 只能调用 `application`；不能直接写数据库；
- `application` 可以调用 `domain`、repository 接口和队列接口；
- `domain` 不依赖 Telegram、HTTP、数据库、具体 AI SDK；
- `infrastructure` 实现接口，不把供应商对象泄露到 domain；
- `shared` 不反向依赖业务模块；
- 翻译、日志和错误码由应用层提供，领域层返回稳定的业务错误类型。

### 2.2 不能跨越的边界

- 爬虫不能直接创建企业兴趣或 Match；
- 官网 URL 不能被当成企业负责人权限；
- AI 输出不能直接发布岗位、公开求职卡、发送兴趣或分享联系方式；
- 前端/Telegram callback 不能直接改变岗位、兴趣或 Match 状态；
- 通知成功不能被当作对方已读或已聊天；
- 已开放联系方式后的私聊不进入平台自动监控；
- 未入驻官网岗位不能进入 24/72 小时未回复处罚。

## 3. 领域状态机

### 3.1 岗位

```text
draft → pending_review → active_external / active_claimed → paused → closed
```

官网采集岗位使用 `active_external`；企业认领并确认后才可成为 `active_claimed`。抓取失败进入 `needs_review`，不能直接变成 `closed`。

### 3.2 兴趣

```text
pending → accepted → matched
pending → declined / withdrawn / invalidated / expired
```

`accepted` 需要接收方实际点击接受。双方对同一岗位、同一版本均有效时，事务内创建唯一 Match。

### 3.3 Match

```text
matched → contact_available → ended / blocked / needs_reconfirmation
```

Match 创建时即进入 `contact_available`，联系方式开放是服务端事实；消息发送失败单独记录，不回滚 Match。

## 4. 核心服务接口

接口名称可调整，但行为不能改变：

| 服务 | 输入 | 输出/副作用 |
|---|---|---|
| `createProfileDraft` | 用户文本/简历文本、角色 | AI 草稿和字段来源 |
| `confirmProfile` | 草稿版本、用户修改 | 新的本人确认版本 |
| `syncExternalJobs` | 来源 ID、采集时间 | 新增/变更/关闭候选岗位，不创建兴趣 |
| `claimJob` | 企业成员、岗位 ID、证据 | 企业确认版本或拒绝原因 |
| `getRecommendations` | 已确认资料、分页游标 | 通过硬条件的岗位及匹配理由 |
| `recordInterest` | `candidate_id`, `job_id`, actor, versions | 单侧 pending 兴趣，幂等 |
| `respondInterest` | interest ID、接受/拒绝、操作者 | accepted 或 declined；可能创建 Match |
| `openContact` | Match ID、双方联系方式版本 | 由 Match 事务确认并展示联系方式 |
| `processInterestTimers` | 当前时间 | 24h 提醒、72h 暂停，幂等 |
| `closeJob` / `stopSeeking` | 对象、操作者 | 停止新推荐和新兴趣 |
| `reportObject` | 举报对象、原因 | 隐藏候选/审核队列/审计 |

所有写接口都需要：服务端身份、对象权限、版本检查、幂等键和审计事件。

## 5. 匹配规则实现

先做规则筛选，再做相关性排序：

1. 对象有效、未关闭、未屏蔽、权限允许；
2. 检查用户确认的必须条件与岗位明确必需条件；
3. 明确冲突直接排除；
4. 必须条件缺失进入待补充；官网薪资未公开是展示例外，渲染为“面议”；
5. 用技能、行业、岗位和工作内容关键词计算可解释的相关项；
6. 返回 `reasons[]`，每条理由指向已确认字段或原文片段；
7. 不返回没有证据的精确百分比。

推荐服务不得修改用户资料或岗位原文。相关性算法可以替换，但硬过滤规则必须有单元测试。

## 6. 采集器边界

采集器由 `source_registry` 配置驱动，每个站点有独立 parser。必须具备：

- 请求限速、超时和重试上限；
- 原始 URL、抓取时间、解析版本和错误记录；
- 岗位去重和版本比较；
- 页面无法访问时保留旧数据并标记待复核；
- 不绕过登录、验证码或访问限制；
- 不抓取求职者个人档案或不必要的个人数据。

采集摘要应保留原文链接和必要证据，不能把摘要改写成企业亲自发布。

## 7. 通知与定时任务

使用 outbox 或等价队列，业务事务先写状态和通知事件，再由 worker 发送 Telegram 消息。

- 业务去重键示例：`interest-reminder:{interest_id}:24h`；
- 24 小时提醒最多一次；
- 72 小时暂停任务必须在执行前重新读取兴趣状态；
- Telegram 失败、超时、未知送达状态分开记录；
- 通知失败不能变成“用户未回复”；
- worker 重试有上限和退避，不能重复开放联系方式。

## 8. 安全与数据边界

- Telegram token、AI API key、数据库密码只能在服务端环境变量或密钥服务中；
- 不在浏览器持久化保存 token、Telegram initData、联系方式或完整简历；
- 日志只记录内部 ID、错误码和事件时间，不记录完整身份证件、电话号码或输入原文；
- 公开岗位卡只展示允许展示的字段；联系方式在 Match 后按分享规则开放；
- 所有 callback 在服务端重新检查用户、角色、对象和版本；
- 删除、拉黑、关闭和权限撤销在异步发送前再次检查。

## 9. 测试边界

最低测试层级：

- Domain：硬条件、面议展示、版本失效、状态转换；
- Application：兴趣幂等、并发 Match、24/72 小时计时、权限；
- Adapter：Telegram callback 映射、翻译键、错误回退；
- Crawler：去重、字段缺失、薪资未公开、请求失败保留旧数据；
- E2E：两个 Telegram 测试账号完成建档、匹配、立即开放联系方式和暂停恢复。

测试时间使用可注入时钟，不能真的等待 72 小时。测试账号、演示岗位与真实库存必须隔离。

## 10. 交付与验收

每个开发阶段提交代码、迁移、环境变量模板、运行说明和测试记录。必须明确：已实现、人工配置、未实现、已知风险。

验收以真实 Telegram 操作、服务端日志、数据库状态和通知队列相互对应为准。能启动服务或本地页面显示，不代表招聘闭环已经完成。

---

## 11. 错误码体系（AppError.code）

所有业务错误使用稳定的字符串枚举，**禁止用数字错误码或 throw Error 裸字符串**。`AppError.code` 由 domain/application 层抛出，adapters 层（Telegram/HTTP）根据 code 查 i18n key 映射为用户可见文案。

### 11.1 错误分类前缀

| 前缀 | 范围 | 示例 |
|---|---|---|
| `AUTH_*` | 身份、权限、会话 | `AUTH_UNAUTHORIZED`、`AUTH_ROLE_MISSING` |
| `VERSION_*` | 版本一致性 | `VERSION_MISMATCH`、`VERSION_EXPECTED_MISSING` |
| `IDEMPOTENT_*` | 幂等冲突 | `IDEMPOTENT_DUPLICATE`、`IDEMPOTENT_KEY_MISMATCH` |
| `PROFILE_*` | 求职卡/企业资料 | `PROFILE_NOT_FOUND`、`PROFILE_NOT_CONFIRMED`、`PROFILE_DRAFT_STALE` |
| `JOB_*` | 岗位 | `JOB_NOT_FOUND`、`JOB_NOT_ACTIVE`、`JOB_EXTERNAL_ONLY` |
| `INTEREST_*` | 兴趣 | `INTEREST_ALREADY_EXISTS`、`INTEREST_NOT_PENDING`、`INTEREST_EXPIRED` |
| `MATCH_*` | Match | `MATCH_ALREADY_EXISTS`、`MATCH_VERSION_INVALID` |
| `CONTACT_*` | 联系方式 | `CONTACT_NOT_SHARED`、`CONTACT_MATCH_REQUIRED` |
| `NOTIFY_*` | 通知/Outbox | `NOTIFY_DEDUPE_HIT`、`NOTIFY_TOO_MANY_ATTEMPTS` |
| `CRAWL_*` | 采集 | `CRAWL_SOURCE_BLOCKED`、`CRAWL_PARSE_FAILED` |
| `AI_*` | AI Provider | `AI_UNAVAILABLE`、`AI_RATE_LIMITED`、`AI_OUTPUT_INVALID` |
| `TRUST_*` | 举报/屏蔽/审计 | `TRUST_BLOCKED`、`TRUST_REPORT_DUPLICATE` |
| `INTERNAL_*` | 系统级兜底 | `INTERNAL_UNKNOWN`、`INTERNAL_DB_ERROR` |

### 11.2 AppError 结构

```typescript
class AppError extends Error {
  readonly code: string;           // 稳定字符串枚举
  readonly httpStatus?: number;    // 仅 HTTP adapter 参考
  readonly retryable: boolean;     // worker 是否可自动重试
  readonly metadata?: Record<string, unknown>; // 仅用于内部日志，禁止放 PII
}
```

**严禁在 `metadata`、日志、堆栈中写入**：完整简历、手机号、证件号、Telegram initData 原文、API Key、Token 明文。

---

## 12. 版本一致性校验（expectedVersion）

所有**写操作 DTO** 强制携带 `expectedVersion: number`。应用层在**同一数据库事务内**读取当前版本，与 `expectedVersion` 比对；不匹配直接抛 `VERSION_MISMATCH`，整笔事务回滚。

### 12.1 校验流程

```text
Application Service (开启事务)
  1. SELECT ... FOR UPDATE 读取目标行，拿到 current_version
  2. if current_version !== expectedVersion → 抛 VERSION_MISMATCH，rollback
  3. 执行业务状态变迁（纯函数）
  4. UPDATE ... SET version = version + 1 WHERE id = ? AND version = ?
  5. 写 audit_events
  6. 写 outbox（若需通知）
  7. commit
```

**读操作不需要携带 expectedVersion**；但读操作返回给 adapter 的结果必须包含当前 `version`，供用户下次写时使用。

### 12.2 版本语义

- `candidate_profiles.version`、`jobs.version`、`companies.version`：每次本人确认或企业确认变更 +1，草稿变更不增版。
- `interests.version`：创建时为 1，每次状态变迁 +1。
- `matches.version`：创建时为 1，每次结束/阻断/重确认 +1。

---

## 13. 统一幂等键规则

所有写操作在进入事务前生成稳定幂等键，在对应表上设**唯一索引**。重复请求命中唯一键时，读回原结果返回，不重复副作用。

| 操作 | 幂等键格式 | 作用位置 |
|---|---|---|
| 发送兴趣（单侧） | `interest:{candidateId}:{jobId}:{actorSide}:{candidateVersion}:{jobVersion}` | `interests.idempotency_key` 唯一索引 |
| 创建 Match | `match:{candidateId}:{jobId}:{interestPairVersionSum}` | `matches.idempotency_key` 唯一索引 |
| 发送通知 | `notification:{type}:{objectId}:{objectVersion}` | `notifications.dedupe_key` 唯一索引 |
| 处理 24h 提醒 | `notification:INTEREST_REMINDER_24H:{interestId}:v1` | `notifications.dedupe_key` |
| 处理 72h 暂停 | `notification:INTEREST_PAUSE_72H:{interestId}:v1` | `notifications.dedupe_key` |
| 采集同步岗位 | `crawl:{sourceId}:{sourceJobId}:{parseVersion}` | `jobs.idempotency_key` 或去重表 |

**幂等键命中时的行为**：
- 同一用户同键重发 → 返回（或重新发送）上次成功结果，不抛错。
- 不同用户/不同对象版本撞上已存在键 → 抛 `IDEMPOTENT_KEY_MISMATCH`。

---

## 14. 可注入时钟（Clock）

所有涉及当前时间的业务逻辑**禁止直接调用 `new Date()` / `Date.now()`**，必须通过 `Clock` 接口注入。

```typescript
// shared/clock/clock.ts
interface Clock {
  now(): Date;
}

// infrastructure/clock/system-clock.ts  →  生产
class SystemClock implements Clock {
  now(): Date { return new Date(); }
}

// infrastructure/clock/fake-clock.ts    →  测试
class FakeClock implements Clock {
  constructor(private current: Date) {}
  now(): Date { return new Date(this.current.getTime()); }
  advance(ms: number): void { this.current = new Date(this.current.getTime() + ms); }
  set(to: Date): void { this.current = new Date(to.getTime()); }
}
```

### 14.1 适用范围

- 兴趣超时计时（24h / 72h）：在 `processInterestTimers` 内与 `notified_at`、`reminded_at` 比较。
- 岗位有效期、缓存判定、审计时间戳。
- **不得**在纯 domain 状态机函数中使用 Clock；状态机接收 `now: Date` 作为**显式参数**。

---

## 15. Outbox 模式与通知队列

**禁止使用纯内存队列**（BullMQ 内存模式、EventEmitter、setInterval 异步回调等）作为通知的唯一提交路径。使用 **PostgreSQL outbox 表 + 轮询 worker**，保证业务状态与通知事件在同一事务内落地。

### 15.1 outbox 表结构（概念）

| 字段 | 用途 |
|---|---|
| `id` bigserial | PK |
| `dedupe_key` varchar | 唯一索引，见 §13 |
| `recipient_id` | 接收者 users.id |
| `type` | 枚举：INTEREST_CREATED / MATCH_CREATED / INTEREST_REMINDER_24H … |
| `payload` JSONB | 翻译参数与对象 ID，**禁止放联系方式或 PII** |
| `status` | pending / processing / succeeded / failed / dead |
| `attempts` int | 已尝试次数 |
| `last_error` text | 脱敏错误摘要（仅错误码与 ID，不含原文） |
| `available_after` timestamptz | 退避下一次可执行时间 |
| `created_at` / `processed_at` | 时间戳 |

### 15.2 Worker 流程

```text
每 N 秒（如 2s）批量 SELECT 100 条 WHERE status=pending AND available_after <= now()
  FOR UPDATE SKIP LOCKED
对每条：
  1. UPDATE status=processing
  2. 发送 Telegram 消息（adapter 层）
  3a. 成功 → UPDATE status=succeeded, processed_at=now()
  3b. 失败 → attempts++, last_error=脱敏错误码, available_after=指数退避时间；
              attempts < MAX → status=pending
              attempts >= MAX → status=dead（人工处理，禁止自动无限重试）
```

**关键不变式**：
- 发送通知**不影响业务核心状态**：Match 已经 created，通知失败只记录，不回滚 Match。
- Worker 在处理前**重新检查**删除、拉黑、关闭岗位、版本过期——若目标对象已失效，标记 `dead` 并跳过发送。

---

## 16. grammY Session 持久化

grammY 内置 `session()` 中间件，但**默认内存存储重启即丢**。必须实现基于 PostgreSQL 的 `SessionStorage<T>`，与会话表绑定。

```typescript
// infrastructure/telegram/postgres-session-storage.ts
interface PostgresSessionStorage<S> extends SessionStorage<S> {
  read(key: string): Promise<S | undefined>;
  write(key: string, value: S): Promise<void>;
  delete(key: string): Promise<void>;
}
```

### 16.1 sessions 表（概念）

| 字段 | 用途 |
|---|---|
| `session_key` varchar PK | grammY 传入的 key（telegram_user_id + 私有 salt） |
| `session_data` JSONB | 会话状态（当前步骤、草稿临时 ID、角色选择缓存……） |
| `user_id` bigint | 关联 users.id，便于清理已删除用户会话 |
| `expires_at` timestamptz | 30 天滚动过期，过期清理任务独立运行 |
| `updated_at` timestamptz | 最近写入时间 |

**存储边界**（重要）：
- Session 中**只存临时流程状态与内部 ID 引用**，绝对不存联系方式原文、完整简历、期望薪资明文。
- 真实数据存在 `candidate_profiles / jobs / contact_methods` 等业务表，Session 只存指向这些表的 `id` + `version`。

---

## 17. AI Provider 可插拔抽象

AI 只负责**字段整理草稿**，不直接发布任何业务事实。定义 Provider 接口，三种实现可替换：`OllamaProvider`（本地）、`DeepSeekProvider`、`OpenAICompatibleProvider`（OpenAI / 其他兼容端点）。阶段一**暂不绑定真实 Provider**，先提供 `MockAIProvider` 与手动建档回退路径。

### 17.1 契约接口

```typescript
// domain/trust/ai-extract-provider.ts (在 domain 定义接口)
interface AIExtractProvider {
  readonly providerId: 'ollama' | 'deepseek' | 'openai-compatible' | 'mock';

  extractCandidateDraft(raw: string): Promise<AIExtractedCandidateDraft>;
  extractJobDraft(raw: string): Promise<AIExtractedJobDraft>;
}

interface AIExtractedCandidateDraft {
  source: 'ai';
  providerId: string;
  extractedAt: Date;
  fields: {
    skills?: string[];
    industries?: string[];
    targetRoles?: string[];
    taskKeywords?: string[];
    locations?: string[];
    languages?: string[];
    salaryExpectation?: { status: 'provided' | 'not_provided' | 'negotiable'; text?: string };
  };
  fieldSources: Record<string, 'ai_extracted'>;
  warnings: string[];        // "未发现工作经验时间" 等
  degraded: boolean;         // true 时提示用户手动确认更严格
}
```

### 17.2 降级与安全边界

- **任何 Provider 调用失败**：抛 `AI_UNAVAILABLE` 或 `AI_RATE_LIMITED`，Application 层**自动降级到手动建档流程**，不得阻塞用户。
- **AI 返回值视为不可信数据**：必须经过 Zod schema 校验 + 非敏感字段白名单过滤后，才能写入 draft。
- **AI 输出不能覆盖用户已确认字段**：`confirmProfile` 时，若字段已标记为 `user_confirmed`，AI 晚到的 draft 会被丢弃对应字段。
- **MockAIProvider**：阶段一默认注入，返回空字段或基于规则的最小草案，使整个建档流程可在无网络、无 Key 情况下跑通。

---

## 18. 审计事件（audit_events）

所有改变业务状态或权限的操作必须写 `audit_events`。`action` 使用**稳定字符串枚举**；`metadata` 用 JSONB 存差异摘要；PII 绝对禁止入库。

### 18.1 action 枚举（首版覆盖，可追加但不修改旧值）

| action 枚举 | 触发场景 | 关键 metadata（非 PII） |
|---|---|---|
| `USER_CREATED` | 首次 /start 绑定 Telegram | `telegram_user_id_hash`（hash，不是明文）、`initial_language` |
| `USER_LANGUAGE_CHANGED` | 语言切换 | `from`、`to` |
| `PROFILE_DRAFT_CREATED` | 求职卡草稿生成（AI 或手动） | `role`、`draft_version`、`source`（manual/ai/mock）、`field_count` |
| `PROFILE_DRAFT_UPDATED` | 草稿修改 | `role`、`draft_version`、`changed_fields`（字段名数组，不含值） |
| `PROFILE_CONFIRMED` | 本人确认发布 | `role`、`new_version`、`confirm_count`、`changed_from_draft_fields` |
| `PROFILE_PAUSED` | 暂停求职/招聘 | `role`、`reason`（枚举值） |
| `PROFILE_RESUMED` | 恢复 | `role` |
| `PROFILE_DELETED` | 软删除资料 | `role`、`hashed_confirm_token` |
| `COMPANY_VERIFIED` | 企业入驻确认 | `company_id`、`method`（owner 声明等） |
| `JOB_DRAFT_CREATED` / `JOB_CONFIRMED` | 岗位草稿 / 发布 | `company_id`、`source_type`（claimed/external）、`new_version` |
| `JOB_CLAIMED` | 企业认领官网岗位 | `job_id`、`company_id` |
| `JOB_CLOSED` | 岗位关闭 | `job_id`、`reason`（枚举） |
| `INTEREST_RECORDED` | 表达兴趣 | `interest_id`、`actor_side`、`candidate_id`、`job_id`、`cv`、`jv` |
| `INTEREST_ACCEPTED` / `INTEREST_DECLINED` | 企业回复 | `interest_id`、`actor_side` |
| `INTEREST_WITHDRAWN` | 撤回 | `interest_id`、`actor_side` |
| `INTEREST_EXPIRED_PAUSED` | 72h 超时暂停 | `interest_id`、`affected_object`（candidate 或 job） |
| `MATCH_CREATED` | 双向兴趣成立 | `match_id`、`candidate_id`、`job_id`、`interest_pair` |
| `MATCH_ENDED` / `MATCH_BLOCKED` | 结束 / 拉黑阻断 | `match_id`、`actor_side`、`reason` |
| `CONTACT_OPENED` | 联系方式交付（仅记对象 ID） | `match_id`、`sharer_sides`（["candidate","company"]） |
| `NOTIFY_QUEUED` / `NOTIFY_SUCCEEDED` / `NOTIFY_FAILED_DEAD` | Outbox 全链路 | `notification_id`、`type`、`attempts` |
| `CRAWL_RUN_STARTED` / `CRAWL_RUN_FINISHED` | 采集批次 | `source_id`、`new_count`、`changed_count`、`error_count` |
| `TRUST_REPORT_SUBMITTED` | 举报提交 | `report_id`、`object_type`、`object_id`、`reason_code`（枚举） |
| `TRUST_BLOCK_EFFECTIVE` | 屏蔽生效 | `blocker_id`、`target_type`、`target_id`、`scope` |

### 18.2 明确禁止写入 audit_events 的内容

以下内容**即使是合法业务数据，也不能进入 audit_events**（应用层写库前强制脱敏）：

- 完整简历文本、职位详情长文原文；
- 手机号、微信号、Telegram @username 明文、邮箱、地址；
- 证件号、照片 URL、薪资具体金额（只存 `salary_status` 枚举）；
- Telegram `initData`、任何 Token、API Key、会话签名；
- AI Prompt 原文或模型原始响应全文（只存 `providerId`、`degraded`、`warnings.length`）。

如需排查字段级问题，靠 `changed_fields`（字段名数组）+ `version` 增量，不落地明文值。
