/**
 * Thin REST client for the Tyrekick worker management surface
 * (CONTRACT.md — "MCP loop" addendum):
 *
 *   GET   /feedback?status=&route=&since=&limit=
 *   GET   /feedback/:id
 *   PATCH /feedback/:id  { status, note? }
 *
 * All management calls carry `Authorization: Bearer <TYREKICK_TOKEN>`.
 * Every failure is thrown as TyrekickApiError with a human-readable
 * message — callers turn it into an MCP tool error; nothing crashes.
 */

export const UNAUTHORIZED_MESSAGE =
  "Unauthorized — check TYREKICK_TOKEN and that `wrangler secret put TYREKICK_TOKEN` was run";

export class TyrekickApiError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TyrekickApiError";
    this.status = status;
  }
}

/** A stored feedback record: the FeedbackPayload plus the worker's server fields. */
export interface FeedbackRecord {
  schema?: number;
  id: string;
  created_at?: string;
  project_name?: string;
  app_version?: string;
  route?: string;
  url?: string;
  body?: string;
  reviewer_name?: string | null;
  session_id?: string;
  anchor?: {
    x_pct?: number;
    y_pct?: number;
    selector?: string | null;
    viewport?: { w: number; h: number };
    /** schema v2: element identity/text under the click (absent in v1). */
    element?: {
      tag?: string;
      id?: string | null;
      testid?: string | null;
      role?: string | null;
      text?: string | null;
      label?: string | null;
      rect?: { x: number; y: number; w: number; h: number };
    } | null;
    /** schema v2: nearest heading + landmark path (absent in v1). */
    context?: {
      heading?: string | null;
      landmark?: string | null;
    } | null;
  };
  env?: { user_agent?: string; language?: string; [key: string]: unknown };
  /** schema v2: last ≤5 uncaught page errors at submit time (absent in v1). */
  page_errors?: string[];
  status?: string;
  received_at?: string;
  resolved_at?: string | null;
  resolution_note?: string | null;
  [key: string]: unknown;
}

export interface ListFeedbackParams {
  status?: "open" | "resolved";
  route?: string;
  since?: string;
  limit?: number;
}

export interface TyrekickClientConfig {
  baseUrl: string;
  token: string;
}

function isRecordObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The contract fixes the routes and the `{"ok":true,...}` envelope but not the
 * key that carries the data, so accept the obvious shapes defensively.
 */
export function extractList(json: unknown): FeedbackRecord[] {
  if (Array.isArray(json)) return json as FeedbackRecord[];
  if (isRecordObject(json)) {
    for (const key of ["items", "records", "feedback", "results", "data", "list"]) {
      const v = json[key];
      if (Array.isArray(v)) return v as FeedbackRecord[];
    }
  }
  return [];
}

export function extractRecord(json: unknown): FeedbackRecord | null {
  if (!isRecordObject(json)) return null;
  for (const key of ["record", "item", "feedback", "result", "data"]) {
    const v = json[key];
    if (isRecordObject(v) && typeof v.id === "string") return v as FeedbackRecord;
  }
  if (typeof json.id === "string") {
    const { ok: _ok, ...rest } = json;
    return rest as FeedbackRecord;
  }
  return null;
}

export class TyrekickClient {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: TyrekickClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.token = config.token;
  }

  private async request(
    path: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const url = this.baseUrl + path;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    const fetchInit: RequestInit = { method: init.method ?? "GET", headers };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      fetchInit.body = JSON.stringify(init.body);
    }

    let res: Response;
    try {
      res = await fetch(url, fetchInit);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new TyrekickApiError(
        `Network error calling ${url}: ${detail}. Is TYREKICK_URL correct and the worker deployed?`,
      );
    }

    if (res.status === 401) {
      throw new TyrekickApiError(UNAUTHORIZED_MESSAGE, 401);
    }

    let text = "";
    try {
      text = await res.text();
    } catch {
      /* body unreadable — fall through with empty text */
    }

    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!res.ok) {
      let detail = text.slice(0, 300);
      if (isRecordObject(json) && typeof json.error === "string") detail = json.error;
      throw new TyrekickApiError(
        `Tyrekick worker returned HTTP ${res.status} for ${init.method ?? "GET"} ${path}${
          detail ? `: ${detail}` : ""
        }`,
        res.status,
      );
    }

    if (isRecordObject(json) && json.ok === false) {
      const detail = typeof json.error === "string" ? json.error : "unknown error";
      throw new TyrekickApiError(`Tyrekick worker reported an error: ${detail}`, res.status);
    }

    return json;
  }

  async listFeedback(params: ListFeedbackParams = {}): Promise<FeedbackRecord[]> {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.route) qs.set("route", params.route);
    if (params.since) qs.set("since", params.since);
    if (params.limit !== undefined) qs.set("limit", String(params.limit));
    const query = qs.toString();
    const json = await this.request(`/feedback${query ? `?${query}` : ""}`);
    return extractList(json);
  }

  async getFeedback(id: string): Promise<FeedbackRecord> {
    const json = await this.request(`/feedback/${encodeURIComponent(id)}`);
    const record = extractRecord(json);
    if (!record) {
      throw new TyrekickApiError(`Feedback ${id}: worker response did not contain a record`);
    }
    return record;
  }

  async resolveFeedback(id: string, note?: string): Promise<FeedbackRecord> {
    const body: { status: "resolved"; note?: string } = { status: "resolved" };
    if (note !== undefined) body.note = note;
    const json = await this.request(`/feedback/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    });
    const record = extractRecord(json);
    if (!record) {
      throw new TyrekickApiError(`Feedback ${id}: worker response did not contain a record`);
    }
    return record;
  }
}
