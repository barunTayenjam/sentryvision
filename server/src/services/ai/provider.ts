/**
 * GenAI provider abstraction for SentryVision.
 *
 * Design after Frigate 0.18's multi-provider GenAI system. Selection is
 * driven entirely by environment variables, making provider swap a config
 * change rather than a code change. Solves the fragility documented in
 * CLAUDE.md: "model IDs are volatile — a model that resolves today can
 * 404 or time out tomorrow".
 *
 * Two providers:
 *   - `nvidia`: existing nvidiaAnalysisService (NVIDIA_API_KEY)
 *   - `local`: OpenAI-compatible endpoint (llama.cpp / Ollama)
 *
 * Config env vars (see CLAUDE.md, ENVIRONMENT.md reference):
 *   AI_ROLE_SCENE          = which provider for scene analysis (default: nvidia)
 *   AI_ROLE_CHAT           = which provider for AskPage/chat (default: nvidia)
 *   LOCAL_AI_BASE_URL      = OpenAI-compatible base URL (required for local)
 *   LOCAL_AI_MODEL         = model name/alias (required for local)
 *   NVIDIA_API_KEY         = key for nvidia provider
 */

const PROVIDER_NAMES = new Set(["nvidia", "local"]);

/** Registry: role resolution + provider factory. Env read per call so
 * runtime config changes take effect without restart. */
export const AIProviderRegistry = {
  /** Map role ("scene"|"chat") → provider name. Unknown names fall back
   * to "nvidia"; a valid name whose required config is missing falls back
   * to the other provider so a dead endpoint can never disable a role. */
  providerForRole(role: string): string {
    const env = role === "scene" ? process.env.AI_ROLE_SCENE : process.env.AI_ROLE_CHAT;
    const chosen = env ?? "nvidia";
    if (!PROVIDER_NAMES.has(chosen)) return "nvidia";
    if (!AIProviderRegistry.isConfigured(chosen)) {
      const other = chosen === "nvidia" ? "local" : "nvidia";
      if (AIProviderRegistry.isConfigured(other)) return other;
    }
    return chosen;
  },

  /** True when the named provider has the minimal config it needs. */
  isConfigured(provider: string): boolean {
    if (provider === "nvidia") return !!process.env.NVIDIA_API_KEY;
    if (provider === "local")
      return !!(process.env.LOCAL_AI_BASE_URL && process.env.LOCAL_AI_MODEL);
    return false;
  },

  /** Factory: return a provider handle by name, or null when unknown or
   * missing required config (e.g. nvidia without NVIDIA_API_KEY). */
  get(provider: string): { name: string; chat: ChatFn } | null {
    if (!AIProviderRegistry.isConfigured(provider)) return null;
    if (provider === "nvidia") {
      // Vision-capable chat via the existing nvidia client; wired into
      // nvidiaAnalysisService at the call-site (kept lazy here to avoid
      // adding a dependency on circuit-breaker/fetch plumbing until the
      // nvidia call-site is migrated to the registry).
      return {
        name: "nvidia",
        chat: async () => {
          throw new Error("nvidia provider chat not yet wired into registry");
        },
      };
    }
    if (provider === "local") {
      const base = process.env.LOCAL_AI_BASE_URL;
      const model = process.env.LOCAL_AI_MODEL;
      if (!base || !model) return null;
      const provider_ = new LocalProvider(base, model);
      return { name: "local", chat: (m) => provider_.chat(m) };
    }
    return null;
  },
};

export type ChatFn = (messages: Array<{ role: string; content: string }>) => Promise<string>;

/**
 * OpenAI-compatible local provider (llama.cpp / Ollama / anything
 * speaking the chat/completions API).
 */
export class LocalProvider {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.model = model;
  }

  /** Send a chat completion request and return the content string. */
  async chat(messages: Array<{ role: string; content: string }>): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, messages, temperature: 0.7, stream: false }),
    });

    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Local AI ${resp.status}: ${txt}`);
    }

    const data = await resp.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
}
