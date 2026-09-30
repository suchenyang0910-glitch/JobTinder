# Trae 开发任务：免费 AI 简历生成（Word）

## 目标
在 JobTinder Telegram Bot 增加免费 AI 简历功能：
- 每个 Telegram 用户只生成 1 份免费简历；
- 输出 DOCX Word；
- 输出语言跟随用户输入：中文、高棉语或英语；
- AI 只整理用户提供的信息，不编造经历、技能、薪资、学历、证书；
- 用户确认后才生成；
- 已生成简历可编辑、重复下载和重新导出，但不能创建第二份免费简历。

## 业务规则
1. 失败、超时、取消、文件写入失败不消耗额度。
2. 成功持久化 DOCX 后才记为已使用。
3. 服务端以 users.id + resume_documents.user_id UNIQUE 强制限额，不能只依赖 Telegram 前端。
4. 简历默认只发送给本人，不公开给企业、不自动投递。
5. Telegram Session 只存流程状态和 resume_document_id，不存完整正文。
6. 未提供字段显示“未提供”，不能猜测。

## Telegram 流程
新增命令：/resume、/myresume、/deleteresume；菜单按钮“📝 免费制作简历”。

首次流程：
输入自然语言或粘贴旧简历 → AI 结构化草稿 → 语言识别 → Telegram 预览 → 用户修改/确认 → 生成 DOCX → 发送文件。

语言：
- 高棉语：km
- 英语：en
- 简体中文：zh_CN
- 混合或低置信度：让用户选择，不能自动猜。

已有简历：
- 显示当前简历；
- 允许编辑当前文档、重新导出、再次下载；
- 禁止创建第二份免费简历。

Callback：
resume:start
resume:confirm:<id>
resume:edit:<id>
resume:download:<id>
resume:delete:<id>

每个 callback 和下载操作必须再次校验 Telegram 用户拥有该简历。

## Prisma 数据模型
新增 resume_documents：

- id BigInt primary key
- user_id BigInt UNIQUE
- status：DRAFT、GENERATING、READY、FAILED、DELETED
- input_language、output_language
- title
- structured_json Json
- source_text_hash
- raw_input（仅在语言待确认或 AI 解析失败重试期间暂存；成功解析或删除时清空）
- file_path、file_sha256、file_size_bytes
- generation_version
- generated_at、created_at、updated_at

关联 users，用户删除时级联删除。增加 status 索引。
不单独建立免费次数表；未来付费套餐再抽象 quota 表。

## Application 层
新增：
- ResumeService.createDraft(userId, input)
- ResumeService.updateDraft(userId, fields)
- ResumeService.confirmAndGenerate(userId)
- ResumeService.download(userId)
- ResumeService.delete(userId)
- ResumeLanguageService.detect(text)
- ResumeDocxRenderer.render(data, outputLanguage)

状态机：
DRAFT → GENERATING → READY 或 FAILED。
只有 DRAFT 可开始生成；READY 只能编辑同一份文档。
用事务、唯一索引和幂等键防止并发生成重复文件。

## AI 契约
新增独立 ResumeDraft Zod schema，字段至少包括：
fullName、headline、summary、phone、email、location、targetRoles、
experiences(company/title/start/end/responsibilities)、education、
skills、languages、certificates、warnings、sourceLanguage。

AI 要求：
- 仅使用用户输入；
- 缺失字段为空；
- 不虚构公司、日期、成就、证书、联系方式；
- 只返回 JSON；
- AI 失败回退手动编辑；
- AI 迟到结果不能覆盖用户已确认字段。

## DOCX
使用 docx npm 包，封装在 infrastructure 层：
- A4、标准标题/经历/教育/技能/语言区块；
- 输出语言为用户确认语言；
- 文件名 JobTinder-Resume-<userId>-v<version>.docx；
- 临时文件完成后计算 SHA-256，再原子 rename；
- 不把正文写入日志；
- 生产目录挂载持久卷，容器重建后文件仍可下载。

## 审计与隐私
新增事件：
RESUME_DRAFT_CREATED、RESUME_DRAFT_UPDATED、
RESUME_GENERATION_STARTED、RESUME_GENERATED、
RESUME_GENERATION_FAILED、RESUME_DOWNLOADED、RESUME_DELETED。

metadata 只能记录 user_id、语言、版本、字段数量、provider、warning 数量、文件大小、错误码。
禁止记录完整简历正文、手机号、邮箱、Telegram username、Prompt、AI 原始响应。

## 验收与测试
必须验证：
1. 同一用户只能有一条 resume_documents。
2. 并发生成只成功一次。
3. 中英高棉输入分别生成对应语言 DOCX。
4. 混合语言要求确认。
5. 失败不扣额度。
6. READY 可编辑和下载，不能新建第二份。
7. 非本人不能读取。
8. 容器重建后仍可下载。
9. 真实 Telegram 流程可完成。

测试：
- ResumeService 状态机、额度、并发、失败回滚；
- Zod 空字段、超长字段、HTML/Markdown；
- DOCX 非零大小、可打开、hash；
- Telegram callback 所有权；
- VPS 重启后的下载。

## 开发顺序
1. migration、enum、状态机；
2. ResumeDraft schema、AI adapter、语言检测；
3. DOCX renderer、持久卷；
4. Telegram 命令和 callback；
5. 审计、错误提示、测试；
6. VPS migration/build/deploy；
7. 真人 Telegram 验收。

## Trae 交付物
提交修改文件清单、migration 名称、测试结果、Word 样例、真人 Telegram 流程证据、未完成项和风险。
