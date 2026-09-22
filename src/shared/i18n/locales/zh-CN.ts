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
  },
  ROLES: {
    pick: () => '我来这里的身份是：',
    candidate: () => '💼 我在找工作',
    company: () => '🏢 我要招聘',
    both: () => '🔀 两者都是',
    set: (r) => `已保存身份：${r}`,
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
    intro: () =>
      '我们一步步来完成你的求职资料。\n所有内容之后都能修改。目前 AI 整理已关闭，全程由你手动控制。',
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
