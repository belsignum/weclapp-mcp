export type Query = Record<string, string | number | boolean | undefined>;

export interface ListOptions {
  page?: number;
  pageSize?: number;
  sort?: string;
  /** Kommagetrennte Feldliste; leer = alle Felder. */
  properties?: string;
  /** weclapp-Filter als Query-Parameter, z. B. { 'name-ilike': '%foo%' }. */
  filters?: Record<string, string>;
  /** Weitere Query-Parameter, die nicht als Filter gelten (z. B. entityName bei /comment). */
  extra?: Query;
}

export interface ListResult<T> {
  result: T[];
}

export interface Entity {
  id: string;
  version?: string;
  [key: string]: unknown;
}

interface ApiProblem {
  title?: string;
  detail?: string;
  status?: number;
  messages?: Array<{ message?: string; field?: string } | string>;
  validationErrors?: Array<{ detail?: string; title?: string; location?: string; [key: string]: unknown }>;
  error?: string;
}

export class WeclappError extends Error {
  readonly status: number;
  readonly problem: ApiProblem | undefined;

  constructor(status: number, message: string, problem?: ApiProblem) {
    super(message);
    this.name = 'WeclappError';
    this.status = status;
    this.problem = problem;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;

function describeProblem(status: number, problem: ApiProblem | undefined, fallback: string): string {
  if (status === 401) {
    return 'weclapp hat den API-Token abgelehnt (401). Ist der Token gültig und gehört er zu diesem Mandanten?';
  }
  if (status === 403) {
    return `Keine Berechtigung in weclapp (403): ${problem?.detail ?? problem?.title ?? 'dem Nutzer des Tokens fehlt das Recht dafür.'}`;
  }
  if (!problem) return `weclapp antwortete mit HTTP ${status}: ${fallback}`;

  const parts: string[] = [];
  if (problem.title) parts.push(problem.title);
  if (problem.detail && problem.detail !== problem.title) parts.push(problem.detail);
  for (const v of problem.validationErrors ?? []) {
    const text = [v.location, v.detail ?? v.title].filter(Boolean).join(': ');
    if (text) parts.push(text);
  }
  if (parts.length === 0) {
    for (const m of problem.messages ?? []) {
      parts.push(typeof m === 'string' ? m : [m.field, m.message].filter(Boolean).join(': '));
    }
  }
  if (parts.length === 0 && problem.error) parts.push(problem.error);
  return `weclapp antwortete mit HTTP ${status}: ${parts.join(' | ') || fallback}`;
}

/**
 * Schlanker Client für die weclapp-REST-API v2.
 * Eine Instanz gehört zu genau einem API-Token.
 */
export class WeclappClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  #currentUser: Promise<Entity> | undefined;

  constructor(baseUrl: string, token: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    if (!token) throw new Error('Kein weclapp-API-Token angegeben.');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#token = token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      AuthenticationToken: this.#token,
      Accept: 'application/json',
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new WeclappError(0, `weclapp ist nicht erreichbar (${method} ${path}): ${reason}`);
    }

    const text = await response.text();
    if (!response.ok) {
      let problem: ApiProblem | undefined;
      try {
        problem = text ? (JSON.parse(text) as ApiProblem) : undefined;
      } catch {
        problem = undefined;
      }
      throw new WeclappError(response.status, describeProblem(response.status, problem, text.slice(0, 300) || response.statusText), problem);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  list<T = Entity>(entity: string, options: ListOptions = {}): Promise<ListResult<T>> {
    return this.request<ListResult<T>>('GET', `/${entity}`, {
      query: {
        page: options.page,
        pageSize: options.pageSize,
        sort: options.sort,
        properties: options.properties,
        ...options.extra,
        ...options.filters,
      },
    });
  }

  get<T = Entity>(entity: string, id: string): Promise<T> {
    return this.request<T>('GET', `/${entity}/id/${encodeURIComponent(id)}`);
  }

  create<T = Entity>(entity: string, body: Record<string, unknown>, dryRun = false): Promise<T> {
    return this.request<T>('POST', `/${entity}`, { query: { dryRun: dryRun || undefined }, body });
  }

  /**
   * Teil-Update: nur die übergebenen Felder werden geändert.
   * Mit `version` lehnt weclapp die Änderung ab, wenn der Datensatz inzwischen geändert wurde.
   */
  update<T = Entity>(entity: string, id: string, fields: Record<string, unknown>, options: { version?: string; dryRun?: boolean } = {}): Promise<T> {
    return this.request<T>('PUT', `/${entity}/id/${encodeURIComponent(id)}`, {
      query: { ignoreMissingProperties: true, dryRun: options.dryRun || undefined },
      body: { ...fields, ...(options.version ? { version: options.version } : {}) },
    });
  }

  /** Der weclapp-Nutzer, dem der Token gehört (pro Client-Instanz gecacht). */
  currentUser(): Promise<Entity> {
    this.#currentUser ??= this.request<Entity>('GET', '/user/currentUser').catch((error: unknown) => {
      this.#currentUser = undefined;
      throw error;
    });
    return this.#currentUser;
  }
}
