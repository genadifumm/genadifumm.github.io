// Google Calendar + Google Sheets, through a Google service account.
// The owner shares their calendar (and sheets) with the service account's email.
import type { Env } from "./env";

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
].join(" ");

let cached: { token: string; exp: number } | null = null;

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function googleReady(env: Env): boolean {
  return Boolean(env.GOOGLE_SA_KEY);
}

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  if (!env.GOOGLE_SA_KEY) throw new Error("Google access is not set up yet (GOOGLE_SA_KEY is missing).");
  const key = JSON.parse(env.GOOGLE_SA_KEY) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: key.client_email, scope: SCOPES, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  }));
  const pem = key.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const signKey = await crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signKey, new TextEncoder().encode(`${header}.${claim}`));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google sign-in failed: ${res.status} ${await res.text()}`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function api(env: Env, url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, "Content-Type": "application/json" },
  });
  const text = await res.text();
  if (res.status === 404) throw new Error("Not found. Probably not shared with the assistant yet.");
  if (!res.ok) throw new Error(`Google API ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

// ---------- Calendar ----------
function calendarUrl(env: Env): string {
  if (!env.GOOGLE_CALENDAR_ID) throw new Error("GOOGLE_CALENDAR_ID is missing.");
  return `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(env.GOOGLE_CALENDAR_ID)}/events`;
}

export async function listEvents(env: Env, from: string, to: string, query?: string): Promise<string> {
  const p = new URLSearchParams({
    timeMin: new Date(from).toISOString(),
    timeMax: new Date(to).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "100",
    timeZone: env.TIMEZONE,
  });
  if (query) p.set("q", query);
  const data = await api(env, `${calendarUrl(env)}?${p}`);
  const items = (data.items ?? []).map((e: any) => ({
    title: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    all_day: Boolean(e.start?.date),
    location: e.location || undefined,
    notes: e.description ? String(e.description).slice(0, 300) : undefined,
  }));
  return items.length ? JSON.stringify(items) : "No events in that range.";
}

export interface NewEvent {
  title: string;
  start: string; // ISO date-time with offset, or YYYY-MM-DD for all-day
  end: string;
  location: string;
  notes: string;
}

export async function addEvent(env: Env, ev: NewEvent): Promise<string> {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(ev.start);
  const when = (v: string) => (allDay ? { date: v } : { dateTime: v, timeZone: env.TIMEZONE });
  const body = {
    summary: ev.title,
    start: when(ev.start),
    end: when(ev.end),
    location: ev.location || undefined,
    description: ev.notes || undefined,
  };
  const created = await api(env, calendarUrl(env), { method: "POST", body: JSON.stringify(body) });
  return `Added to the calendar: ${created.summary} (${created.start?.dateTime ?? created.start?.date}).`;
}

// ---------- Sheets (read only) ----------
const SHEETS: Record<string, { id: (env: Env) => string; columns: string }> = {
  // "עבודה": couples and income. Column W holds ID numbers and is never read.
  work: { id: (env) => env.WORK_SHEET_ID, columns: "A:V" },
  // "ניהול משימות – גנאדי": tasks and fixed expenses.
  tasks: { id: (env) => env.TASKS_SHEET_ID, columns: "A:Z" },
};

export async function readSheet(env: Env, sheet: string, tab?: string): Promise<string> {
  const s = SHEETS[sheet];
  if (!s) throw new Error(`Unknown sheet: ${sheet}`);
  const id = s.id(env);
  if (!id) throw new Error(`Sheet id for '${sheet}' is missing.`);
  const base = `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
  if (!tab) {
    const meta = await api(env, `${base}?fields=sheets.properties.title`);
    return `Tabs: ${JSON.stringify((meta.sheets ?? []).map((x: any) => x.properties.title))}`;
  }
  const range = `'${tab.replace(/'/g, "''")}'!${s.columns}`;
  const data = await api(env, `${base}/values/${encodeURIComponent(range)}`);
  const rows: string[][] = data.values ?? [];
  if (!rows.length) return "The tab is empty.";
  let out = "";
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].some((c) => c && c.trim())) continue;
    const line = `${i + 1}: ${rows[i].join(" | ")}\n`;
    if (out.length + line.length > 40_000) {
      out += `(cut off at row ${i}; ${rows.length} rows in all)`;
      break;
    }
    out += line;
  }
  return out;
}
