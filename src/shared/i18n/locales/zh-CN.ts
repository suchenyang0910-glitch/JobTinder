import type { Translation } from './en';

export const zh: Translation = {
  LANG: {
    name: () => '简体中文',
    pick: () => 'Choose language / ជ្រើសរើសភាសា / 选择语言：',
    set: () => '语言已切换为：简体中文。',
  },
  COMMON: {
    start: () => '开始',
    cancel: () => '取消',
    back: () => '返回',
    save: () => '保存',
    confirm: () => '确认',
    skip: () => '跳过',
    retry: () => '重试',
    loading: () => '加载中…',
    done: () => '完成',
    notProvided: () => '未提供',
    version: (v) => `版本 ${String(v)}`,
    negotiable: () => '面议',
  },
  ROLES: {
    pick: () => '我来这里的身份是：',
    candidate: () => '💼 我在找工作',
    company: () => '🏢 我要招聘',
    both: () => '🔀 两者都是',
    set: (r, nickname) => (nickname ? `${nickname}，已保存身份：${r}` : `已保存身份：${r}`),
  },
  START: {
    welcome_new: (n) =>
      `你好 ${n} 👋  欢迎来到 JobTinder——免费、诚实的工作匹配。\n\n我们绝不向企业或求职者收费。\n请选择语言开始。`,
    welcome_back: (n) => `欢迎回来，${n}。输入 /menu 进入首页，/profile 编辑个人资料。`,
    help: () =>
      `命令：
/start - 重新开始
/menu - 主菜单
/profile - 查看/编辑资料
/matches - Match 与联系方式
/settings - 设置
/help - 平台规则
/cancel - 退出当前编辑
/delete - 删除我的资料`,
  },
  MENU: {
    title: () => '主菜单',
    profileCandidate: () => '📝 我的求职资料',
    profileCompany: () => '🏢 我的企业资料',
    findJobs: () => '🔍 找工作',
    viewMatches: () => '💌 Match 与联系方式',
    settings: () => '⚙️ 设置',
    help: () => 'ℹ️ 平台说明',
  },
  CANDIDATE_ONBOARD: {
    intro: () => '我们一步步来完成你的求职资料。\n所有内容之后都能修改。',
    askTargetRoles: () => '第 1/3 步：你想找什么岗位？\n请用逗号分隔，例如：咖啡师，收银员，服务员',
    askSkills: () => '第 2/3 步：你有哪些技能？\n请用逗号分隔，例如：客户服务，英语，收银操作',
    askIndustries: () =>
      '第 3/3 步（可选）：你偏好哪些行业？\n输入 "-" 跳过，或用逗号分隔，例如：餐饮，零售，酒店',
    draft_saved: (count) => `草稿已保存。目前已填写 ${String(count)} 项。下面是预览。`,
    preview_title: () => '🔎 资料预览（草稿）',
    confirm_prompt: () => '这个版本对吗？',
    edit: () => '✏️ 继续修改',
    confirm: () => '✅ 发布求职资料',
    confirmed: () => '✅ 资料发布成功。我们马上开始匹配。随时输入 /menu。',
    missing_required: (fields) => `还差一步：缺少必填项 ${fields}`,
  },
  AI_ONBOARD: {
    mode_pick: () => '请选择建档方式：',
    button_ai: () => '🤖 AI 快速建档',
    button_manual: () => '✍️ 逐步手动填写',
    ask_candidate_prompt: () =>
      '请用几句话介绍你想找的工作，例如：\n我叫 Dara，在金边找餐饮、仓库、客服类工作。\n会高棉语和一点英语，可以立刻上岗，期望月薪 250-300 美元。',
    candidate_extract_loading: () => '🤖 AI 正在整理你的介绍，请稍等…',
    candidate_extract_failed: () =>
      'AI 暂时无法整理这段内容。\n你可以重新描述，也可以使用手动填写。',
    preview_title: () => '🤖 AI 识别到的资料',
    needs_confirm_title: () => '以下内容还需要你确认：',
    warnings_title: () => '注意事项：',
    confirm: () => '✅ 确认资料',
    edit: () => '✏️ 手动修改',
    redescribe: () => '🔄 重新描述',
    cancel: () => '❌ 取消',
  },
  COMPANY_ONBOARD: {
    intro: () => '发布新职位 — 可以用 AI 解析职位描述，也可以手动逐步填写。',
    button_job_ai: () => '🤖 AI 解析职位描述',
    button_job_manual: () => '✍️ 手动填写',
    ask_jd_prompt: () =>
      '请用自然语言粘贴职位描述，例如：\n"金边 Cafe Happy Cup 招服务员 3 名。\n高棉语 + 基础英语。月薪 220-260$ + 包餐。白班，下周上岗。"',
    extract_loading: () => '🤖 AI 正在解析职位描述，请稍等…',
    extract_failed: () => 'AI 暂时无法解析这段职位描述。请重新组织语言，或使用手动填写。',
    preview_title: () => '🤖 AI 提取到的职位信息',
  },
  ERRORS: {
    AUTH_UNAUTHORIZED: () => '没有权限进行该操作。输入 /start 重新开始。',
    PROFILE_NOT_FOUND: () => '没有找到这份资料。输入 /profile 重新建档。',
    PROFILE_NOT_CONFIRMED: (m) => `资料尚未发布：${m}`,
    PROFILE_DRAFT_STALE: () => '这份草稿已经发布过了。输入 /profile 创建新草稿。',
    VERSION_MISMATCH: () => '草稿在你修改期间有更新，我们已加载最新版本，请再试一次。',
    INTERNAL_UNKNOWN: () => '服务出现了一个小问题，请稍后重试。',
    AI_UNAVAILABLE: () => 'AI 整理暂时不可用，已切换为手动填写。',
    default: () => '发生了意外错误，请重试。',
  },
};
