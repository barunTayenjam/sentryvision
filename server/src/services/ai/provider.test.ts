/**
 * GenAI provider abstraction tests — Jest test suite.
 *
 * Tests env-driven role resolution (AI_ROLE_SCENE|AI_ROLE_CHAT) and
 * LocalProvider chat (OpenAI-compatible fetch) paths.
 */

import { AIProviderRegistry, LocalProvider } from './provider';

describe('AIProviderRegistry', () => {
  afterEach(() => {
    delete process.env.AI_ROLE_SCENE;
    delete process.env.AI_ROLE_CHAT;
    delete process.env.LOCAL_AI_BASE_URL;
    delete process.env.LOCAL_AI_MODEL;
    delete process.env.NVIDIA_API_KEY;
  });

  describe('role resolution', () => {
    it('defaults scene role to nvidia when env not set', () => {
      expect(AIProviderRegistry.providerForRole('scene')).toBe('nvidia');
    });

    it('honours AI_ROLE_SCENE override', () => {
      process.env.AI_ROLE_SCENE = 'local';
      expect(AIProviderRegistry.providerForRole('scene')).toBe('local');
    });

    it('falls back to configured local when chat role names unconfigured nvidia', () => {
      process.env.AI_ROLE_CHAT = 'nvidia';
      process.env.LOCAL_AI_BASE_URL = 'http://localhost:11434/v1';
      process.env.LOCAL_AI_MODEL = 'qwen2.5:7b';
      // nvidia is valid but unconfigured (no API key) → fall back to local
      expect(AIProviderRegistry.providerForRole('chat')).toBe('local');
    });
  });

  describe('provider availability', () => {
    it('nvidia unavailable without API key', () => {
      expect(AIProviderRegistry.isConfigured('nvidia')).toBe(false);
    });

    it('nvidia available with API key', () => {
      process.env.NVIDIA_API_KEY = 'nvapi-test';
      expect(AIProviderRegistry.isConfigured('nvidia')).toBe(true);
    });

    it('local unavailable without base URL', () => {
      expect(AIProviderRegistry.isConfigured('local')).toBe(false);
    });

    it('local available with base URL + model', () => {
      process.env.LOCAL_AI_BASE_URL = 'http://localhost:11434/v1';
      process.env.LOCAL_AI_MODEL = 'qwen2.5:7b';
      expect(AIProviderRegistry.isConfigured('local')).toBe(true);
    });
  });

  describe('provider selection', () => {
    it('returns null when requested provider not configured', () => {
      const p = AIProviderRegistry.get('nvidia');
      expect(p).toBeNull();
    });

    it('returns nvidia provider when configured', () => {
      process.env.NVIDIA_API_KEY = 'nvapi-test';
      const p = AIProviderRegistry.get('nvidia');
      expect(p).not.toBeNull();
      expect(p!.name).toBe('nvidia');
    });

    it('returns local provider when configured', () => {
      process.env.LOCAL_AI_BASE_URL = 'http://localhost:11434/v1';
      process.env.LOCAL_AI_MODEL = 'qwen2.5:7b';
      const p = AIProviderRegistry.get('local');
      expect(p).not.toBeNull();
      expect(p!.name).toBe('local');
    });

    it('returns null when local config incomplete', () => {
      process.env.LOCAL_AI_BASE_URL = 'http://localhost:11434/v1';
      const p = AIProviderRegistry.get('local');
      expect(p).toBeNull();
    });
  });
});

describe('LocalProvider.chat', () => {
  afterEach(() => {
    delete global.fetch;
  });

  it('sends OpenAI-compatible chat completion to base URL', async () => {
    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      expect(url.toString()).toBe('http://localhost:11434/v1/chat/completions');
      expect(init!.method).toBe('POST');
      const body = JSON.parse(init!.body as string);
      expect(body.model).toBe('qwen2.5:7b');
      return {
        ok: true,
        json: () =>
          Promise.resolve({
            choices: [{ message: { content: 'A person at the door' } }],
          }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new LocalProvider('http://localhost:11434/v1', 'qwen2.5:7b');
    const result = await provider.chat([{ role: 'user', content: 'who is there?' }]);

    expect(result).toBe('A person at the door');
  });

  it('throws on non-ok response with status', async () => {
    global.fetch = (async () => {
      return {
        ok: false,
        status: 503,
        text: () => Promise.resolve('model loading'),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const provider = new LocalProvider('http://localhost:11434/v1', 'qwen2.5:7b');
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/503/);
  });
});
