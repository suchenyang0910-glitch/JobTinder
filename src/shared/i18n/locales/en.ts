export type LocaleCode = 'en' | 'zh_CN' | 'km';

export interface Translation {
  LANG: {
    name: () => string;
    pick: () => string;
    set: () => string;
  };
  COMMON: {
    start: () => string;
    cancel: () => string;
    back: () => string;
    save: () => string;
    confirm: () => string;
    skip: () => string;
    retry: () => string;
    loading: () => string;
    done: () => string;
    notProvided: () => string;
    version: (v: number | string | bigint) => string;
  };
  ROLES: {
    pick: () => string;
    candidate: () => string;
    company: () => string;
    both: () => string;
    set: (r: string) => string;
  };
  START: {
    welcome_new: (n: string) => string;
    welcome_back: (n: string) => string;
    help: () => string;
  };
  MENU: {
    title: () => string;
    profileCandidate: () => string;
    profileCompany: () => string;
    findJobs: () => string;
    viewMatches: () => string;
    settings: () => string;
    help: () => string;
  };
  CANDIDATE_ONBOARD: {
    intro: () => string;
    askTargetRoles: () => string;
    askSkills: () => string;
    askIndustries: () => string;
    draft_saved: (count: number | string) => string;
    preview_title: () => string;
    confirm_prompt: () => string;
    edit: () => string;
    confirm: () => string;
    confirmed: () => string;
    missing_required: (fields: string) => string;
  };
  ERRORS: {
    AUTH_UNAUTHORIZED: () => string;
    PROFILE_NOT_FOUND: () => string;
    PROFILE_NOT_CONFIRMED: (m: string) => string;
    PROFILE_DRAFT_STALE: () => string;
    VERSION_MISMATCH: () => string;
    INTERNAL_UNKNOWN: () => string;
    AI_UNAVAILABLE: () => string;
    default: () => string;
  };
}

export const en: Translation = {
  LANG: {
    name: () => 'English',
    pick: () => 'Choose language / ជ្រើសរើសភាសា / 选择语言：',
    set: () => 'Language set to English.',
  },
  COMMON: {
    start: () => 'Start',
    cancel: () => 'Cancel',
    back: () => 'Back',
    save: () => 'Save',
    confirm: () => 'Confirm',
    skip: () => 'Skip',
    retry: () => 'Retry',
    loading: () => 'Loading…',
    done: () => 'Done',
    notProvided: () => 'Not provided',
    version: (v) => `V${String(v)}`,
  },
  ROLES: {
    pick: () => 'I am here as…',
    candidate: () => '💼 Looking for a job',
    company: () => '🏢 Hiring',
    both: () => '🔀 Both',
    set: (r) => `Preferred role saved: ${r}`,
  },
  START: {
    welcome_new: (n) =>
      `Hi ${n} 👋  Welcome to JobTinder — free, honest job matching.\n\nWe never charge companies or applicants.\nPick your language to begin.`,
    welcome_back: (n) =>
      `Welcome back, ${n}. Use /menu to continue, /profile to edit your profile.`,
    help: () =>
      `Commands:\n/start - Restart\n/menu - Main menu\n/profile - View/edit profile\n/matches - Matches & contacts\n/settings - Preferences\n/help - Rules\n/cancel - Exit current edit\n/delete - Delete my profile`,
  },
  MENU: {
    title: () => 'Main menu',
    profileCandidate: () => '📝 My job profile',
    profileCompany: () => '🏢 My company profile',
    findJobs: () => '🔍 Find jobs',
    viewMatches: () => '💌 Matches & contacts',
    settings: () => '⚙️ Settings',
    help: () => 'ℹ️ How this works',
  },
  CANDIDATE_ONBOARD: {
    intro: () =>
      "Let's build your job profile step by step.\nAll fields can be changed later. AI drafts are OFF right now — you're in full control.",
    askTargetRoles: () =>
      'Step 1/3 - What kind of roles are you looking for?\nSend me comma-separated titles, e.g.: "Barista, Cashier, Waiter"',
    askSkills: () =>
      'Step 2/3 - What skills do you have?\nComma-separated, e.g.: "Customer service, English, Cash register"',
    askIndustries: () =>
      'Step 3/3 (optional) - Which industries do you prefer?\nSend "-" to skip, or comma-separated, e.g.: "F&B, Retail, Hotel"',
    draft_saved: (count) => `Draft saved. ${String(count)} fields so far. Preview next.`,
    preview_title: () => '🔎 Profile preview (draft)',
    confirm_prompt: () => 'Does this look right?',
    edit: () => '✏️ Edit',
    confirm: () => '✅ Publish profile',
    confirmed: () => '✅ Profile published. We will start matching soon. Use /menu anytime.',
    missing_required: (fields) => `Almost there. Still missing: ${fields}`,
  },
  ERRORS: {
    AUTH_UNAUTHORIZED: () => 'Action not allowed. Try /start to sign in again.',
    PROFILE_NOT_FOUND: () => "We couldn't find that profile. Start over with /profile.",
    PROFILE_NOT_CONFIRMED: (m) => `Profile not ready yet. ${m}`,
    PROFILE_DRAFT_STALE: () =>
      'This draft has been published already. Start a new one with /profile.',
    VERSION_MISMATCH: () =>
      "Something changed while you were editing. We'll reload the latest draft — please try again.",
    INTERNAL_UNKNOWN: () => 'Something went wrong on our side. Please retry in a moment.',
    AI_UNAVAILABLE: () =>
      'AI draft service is unavailable right now — continuing with manual entry.',
    default: () => 'Unexpected error. Please retry.',
  },
};
