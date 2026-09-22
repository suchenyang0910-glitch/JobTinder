# JobTinder V0.1 Telegram Bot 创建清单

状态：待执行清单｜适用于阶段一开发和首次测试

## 1. BotFather 注册

- [ ] 使用项目负责人 Telegram 账号打开 `@BotFather`
- [ ] 执行 `/newbot`
- [ ] 设置显示名称，例如 `JobTinder Cambodia`
- [ ] 设置唯一用户名，必须以 `bot` 结尾
- [ ] 保存 Bot Token，仅写入本地 `.env` 或服务器密钥，不提交 Git
- [ ] 执行 `/setdescription`，填写简短介绍
- [ ] 执行 `/setabouttext`，填写 About 文案
- [ ] 执行 `/setuserpic`，上传正式头像
- [ ] 根据需要执行 `/setcommands`，配置：

About text:

```text
Free job matching in Cambodia. Match skills with real opportunities and connect when both sides are interested.
```

Description:

```text
JobTinder is a free job matching bot for Cambodia.

Jobseekers can build a profile, discover suitable jobs, review official company listings, and connect when both sides are interested.

Employers can publish jobs for free, review suitable candidates, and respond to expressions of interest.

Listings show their source. If a company has not published a salary, the salary is shown as "Negotiable" with a note that it was not disclosed on the official website. Listings from companies that have not joined JobTinder open the official application page.
```

```text
start - Start or resume
menu - Open the main menu
profile - View or edit your profile
matches - View your matches
settings - Manage language, notifications and contact details
help - Get help
cancel - Cancel the current edit
delete - Delete your profile
```

## 2. 本地环境配置

- [ ] 启动 PostgreSQL
- [ ] 启动 Docker Desktop（集成测试需要）
- [ ] 复制 `.env.example` 为 `.env`
- [ ] 填写 `DATABASE_URL`
- [ ] 填写 `TELEGRAM_BOT_TOKEN`
- [ ] 设置 `AI_DEFAULT_PROVIDER=mock`
- [ ] 暂不填写真实 AI Key，阶段一使用手动建档或 Mock Provider
- [ ] 设置随机且不公开的 `APP_HASH_PEPPER`
- [ ] 设置随机且不公开的 `TELEGRAM_SESSION_SALT`
- [ ] 执行环境校验：

```powershell
pnpm env:validate
```

## 3. 数据库初始化

- [ ] 生成 Prisma Client

```powershell
pnpm prisma:generate
```

- [ ] 创建 baseline migration

```powershell
pnpm prisma:migrate --name baseline
```

- [ ] 确认 `prisma/migrations/` 已生成 SQL
- [ ] 确认 users、candidate_profiles、companies、jobs、interests、matches、contact_methods、notifications、sessions、audit_events、crawl_runs 表已创建
- [ ] 确认候选人+岗位、兴趣、Match、通知的唯一约束已生效

## 4. Bot 启动

- [ ] 安装依赖

```powershell
pnpm install
```

- [ ] 启动 Bot：

```powershell
pnpm start:dev
```

- [ ] 如使用 Outbox Worker，另开终端启动：

```powershell
pnpm worker:outbox
```

- [ ] 确认 Bot 进程没有启动异常
- [ ] 确认数据库连接成功
- [ ] 确认 webhook/polling 模式只有一个实例在运行，避免重复处理更新

## 5. 两个 Telegram 测试账号

- [ ] 准备求职者测试账号 A
- [ ] 准备企业测试账号 B
- [ ] 两个账号都私聊 Bot，不能先在群组中测试
- [ ] 记录测试账号内部 ID，不把手机号或完整 Telegram 更新写入日志
- [ ] 测试结束后清理测试资料或标记为测试数据

## 6. 求职者流程验收

- [ ] A 执行 `/start`
- [ ] 选择中文、English、高棉文中的一种语言
- [ ] 选择“求职者”角色
- [ ] 执行 `/profile`
- [ ] 输入目标岗位
- [ ] 输入技能
- [ ] 输入行业偏好
- [ ] 看到 AI/系统草稿或手动草稿
- [ ] 修改草稿
- [ ] 确认资料后才进入 active/confirmed 状态
- [ ] 未确认的资料不进入推荐
- [ ] 缺少必需字段时不能误显示为“已满足”

## 7. 企业流程验收

- [ ] B 执行 `/start`
- [ ] 选择“企业”角色
- [ ] 创建或填写企业资料
- [ ] 创建岗位草稿
- [ ] 填写岗位、行业、工作内容和必需技能
- [ ] 未公开薪资的岗位显示“面议”，并注明“官网未公开薪资”
- [ ] 确认岗位后才进入 active 状态
- [ ] 未确认岗位不能进入正常推荐

## 8. 匹配流程验收

- [ ] A 看到符合条件的入驻企业岗位
- [ ] 明确硬条件冲突的岗位不展示
- [ ] 非必须字段未知时可以展示，并显示“未提供”
- [ ] 官网未入驻岗位只显示官网来源和官网申请入口
- [ ] 官网岗位不能产生站内 Match
- [ ] A 对具体 `job_id` 表达兴趣
- [ ] B 收到待处理兴趣
- [ ] B 接受兴趣
- [ ] 双向兴趣只创建一个 Match
- [ ] Match 创建后立即开放双方预先选择的联系方式
- [ ] Match 后不再增加第二次联系方式授权步骤

## 9. 24/72 小时处理验收

- [ ] 记录兴趣成功通知时间
- [ ] 使用 FakeClock 或测试时间推进到 24 小时
- [ ] 确认只发送一次提醒
- [ ] 推进到超过 72 小时
- [ ] 确认正确的求职者或岗位被暂停推荐
- [ ] 已接受、已拒绝、已撤回的兴趣不会被误暂停
- [ ] 通知失败不会被当作用户未回复
- [ ] 官网申请不进入该计时规则
- [ ] Match 后的 Telegram 私聊不进入该计时规则

## 10. 安全检查

- [ ] Bot Token 未出现在 Git、日志、截图和错误消息中
- [ ] callback 在服务端重新检查用户身份、角色、对象 ID 和版本
- [ ] 不能通过修改 callback_data 访问其他企业或候选人
- [ ] AI 不能直接发布资料、发送兴趣或开放联系方式
- [ ] 审计日志不记录完整简历、手机号、证件号、Token 或 API Key
- [ ] 删除、拉黑、关闭岗位后，异步通知发送前会重新检查状态
- [ ] Bot 私聊之外不展示候选人资料和联系方式

## 11. 代码质量门禁

```powershell
pnpm exec tsc --noEmit
pnpm exec eslint "{src,test}/**/*.ts"
pnpm test:unit
```

- [ ] TypeScript 0 errors
- [ ] ESLint 0 errors
- [ ] Domain 单元测试全部通过
- [ ] 启动 PostgreSQL 后执行集成测试：

```powershell
$env:RUN_INTEGRATION='1'
pnpm test:integration
```

- [ ] 集成测试确认草稿、确认版本、审计事件和 Outbox 通知同时落库

## 12. 上线前检查

- [ ] 使用正式 Bot 头像、简介和命令
- [ ] 中文、英文、高棉文文案已人工审校
- [ ] 生产 `.env` 不从开发 `.env` 复制敏感值
- [ ] PostgreSQL migration 已提交并可重复部署
- [ ] Outbox Worker 有独立进程或受控进程管理
- [ ] 只运行一个 Bot polling 实例，或已正确配置 webhook
- [ ] 配置日志脱敏、错误告警和进程重启策略
- [ ] 备份数据库并确认恢复方式
- [ ] 明确当前没有真实 AI Provider、官网爬虫和真实企业库存时，不对外宣称这些能力已经可用
- [ ] 完成两个测试账号的端到端记录后，才开始小范围真实试点

## 13. 当前阶段不做

- [ ] 不接入真实 AI Provider 作为阶段一上线前置条件
- [ ] 不向官网未入驻企业发送求职者资料
- [ ] 不把官网申请算作平台 Match
- [ ] 不收取企业或求职者费用
- [ ] 不读取双方 Telegram 私聊内容
- [ ] 不把 `/start` 能回复当作招聘闭环完成
