export interface Env {
  DB: D1Database;
  AI: Ai;

  // secrets
  ANTHROPIC_API_KEY: string;
  WA_TOKEN: string;
  WA_PHONE_NUMBER_ID: string;
  WA_APP_SECRET: string;
  WA_VERIFY_TOKEN: string;
  OWNER_PHONE: string; // digits only, e.g. 972521234567
  GOOGLE_SA_KEY?: string; // service account JSON key (whole file)
  GOOGLE_CALENDAR_ID?: string; // the owner's calendar id (usually their Gmail address)

  // plain settings (wrangler.toml [vars])
  CLAUDE_MODEL: string;
  CLAUDE_EFFORT: "low" | "medium" | "high";
  TIMEZONE: string;
  DAILY_BRIEF_HOUR: string; // "" = off
  HISTORY_LIMIT: string;
  WA_API_VERSION: string;
  WA_TEMPLATE_NAME: string;
  WA_TEMPLATE_LANG: string;
  WORK_SHEET_ID: string;
  TASKS_SHEET_ID: string;
}
