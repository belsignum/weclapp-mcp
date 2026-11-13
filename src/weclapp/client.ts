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

/** weclapp-IDs sind numerische Strings. Alles andere könnte den URL-Pfad verändern ("..", "/"). */
export const ID_PATTERN = /^[0-9]{1,24}$/;
const ENTITY_PATTERN = /^[a-z][A-Za-z]{1,60}$/;
/** Zeichen, die in einem API-Token vorkommen dürfen (weclapp-Tokens sind UUIDs). */
export const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{8,512}$/;

function entityPath(entity: string, id?: string): string {
  if (!ENTITY_PATTERN.test(entity)) throw new Error(`Ungültiger weclapp-Datentyp "${entity}".`);
  if (id === undefined) return `/${entity}`;
  if (!ID_PATTERN.test(id)) throw new Error(`Ungültige weclapp-ID "${id.slice(0, 40)}": erwartet wird eine Zahl.`);
  return `/${entity}/id/${id}`;
}

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

  constructor(baseUrl: string, token: string, options: { fetch?: typeof fetch; timeoutMs?: number; currentUser?: Entity } = {}) {
    if (!token) throw new Error('Kein weclapp-API-Token angegeben.');
    if (!TOKEN_PATTERN.test(token)) throw new Error('Der weclapp-API-Token enthält unzulässige Zeichen.');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.#token = token;
    this.#fetch = options.fetch ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.currentUser) this.#currentUser = Promise.resolve(options.currentUser);
  }

  async request<T>(method: string, path: string, options: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    // Schutz gegen Pfad-Manipulation: die fertige URL muss unterhalb der Basis-URL bleiben
    if (url.origin !== new URL(this.baseUrl).origin || !url.pathname.startsWith(new URL(this.baseUrl).pathname + '/') || url.pathname.endsWith('/')) {
      throw new Error(`Ungültiger weclapp-Pfad "${path.slice(0, 80)}".`);
    }
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
        // Weiterleitungen nie folgen: der Token-Header würde sonst an das Ziel mitgeschickt
        redirect: 'error',
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

  async list<T = Entity>(entity: string, options: ListOptions = {}): Promise<ListResult<T>> {
    return this.request<ListResult<T>>('GET', entityPath(entity), {
      query: {
        ...options.extra,
        ...options.filters,
        page: options.page,
        pageSize: options.pageSize,
        sort: options.sort,
        properties: options.properties,
      },
    });
  }

  async get<T = Entity>(entity: string, id: string): Promise<T> {
    return this.request<T>('GET', entityPath(entity, id));
  }

  async create<T = Entity>(entity: string, body: Record<string, unknown>, dryRun = false): Promise<T> {
    return this.request<T>('POST', entityPath(entity), { query: { dryRun: dryRun || undefined }, body });
  }

  /**
   * Teil-Update: nur die übergebenen Felder werden geändert.
   * Mit `version` lehnt weclapp die Änderung ab, wenn der Datensatz inzwischen geändert wurde.
   */
  async update<T = Entity>(entity: string, id: string, fields: Record<string, unknown>, options: { version?: string; dryRun?: boolean } = {}): Promise<T> {
    return this.request<T>('PUT', entityPath(entity, id), {
      query: { ignoreMissingProperties: true, dryRun: options.dryRun || undefined },
      body: { ...fields, ...(options.version ? { version: options.version } : {}) },
    });
  }

  /** Löscht einen Datensatz. Wird nur intern zum Rückgängigmachen einer Anlage verwendet. */
  async delete(entity: string, id: string): Promise<void> {
    return this.request<void>('DELETE', entityPath(entity, id));
  }

  /**
   * Der weclapp-Nutzer, dem der Token gehört (pro Client-Instanz gecacht).
   * Anders als bei /<datentyp>/id/<id> verpackt weclapp diese Antwort in { result: … }.
   */
  currentUser(): Promise<Entity> {
    this.#currentUser ??= this.request<{ result: Entity }>('GET', '/user/currentUser')
      .then((response) => response.result)
      .catch((error: unknown) => {
        this.#currentUser = undefined;
        throw error;
      });
    return this.#currentUser;
  }
}
