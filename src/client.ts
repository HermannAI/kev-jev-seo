// Raw HTTP client for the Jev (TypeSafe) System One endpoint. No vendor SDK.
// Wire format taken from @typesafe-ai/sdk v0.6.0: POST /v1/systemone { model, state, questions }.

export type Question =
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> | null }
  | { type: "score"; instructions: unknown; criteria: unknown[] }
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };

export interface SystemOneRequest {
  state: unknown;
  questions: Record<string, Question>;
  model?: string;
}

const BASE_URL = process.env.TYPESAFE_BASE_URL ?? "https://api.typesafe.ai";
// Pinned on purpose: every threshold in questions.ts was measured on this version (jev/tools/jev-eval/REPORT.md).
// To move to a newer Jev, set TYPESAFE_DEFAULT_MODEL, rerun the evaluation suite, and only then change this default.
export const PINNED_MODEL = "jev-1.13.0";
const MODEL = process.env.TYPESAFE_DEFAULT_MODEL ?? PINNED_MODEL;
const TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

export class JevError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function systemOne(req: SystemOneRequest): Promise<unknown> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new JevError("TYPESAFE_API_KEY is not set in the MCP server environment.");
  if (Object.keys(req.questions).length === 0) throw new JevError("At least one question is required.");

  const body = JSON.stringify({ ...req, model: req.model ?? MODEL });

  for (let attempt = 0; ; attempt++) {
    let res: Response | undefined;
    let failure: string | undefined;
    try {
      res = await fetch(`${BASE_URL}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }

    if (res?.ok) return res.json();

    const retryable = failure !== undefined || [408, 429].includes(res!.status) || res!.status >= 500;
    if (!retryable || attempt >= MAX_RETRIES) {
      const detail = res ? `HTTP ${res.status}: ${(await res.text()).slice(0, 500)}` : failure;
      throw new JevError(`Jev request failed (${detail})`, res?.status);
    }
    const retryAfter = Number(res?.headers.get("retry-after")) * 1000;
    const backoff = Math.min(500 * 2 ** attempt, 5000) * (0.75 + Math.random() * 0.5);
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60_000) : backoff);
  }
}
