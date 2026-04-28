import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Part } from '@google/genai';

const {
  mockFetch,
  mockGetAppSettings,
  mockGetConfiguredApiClient,
  mockGenerateContent,
  mockGenerateContentStream,
} = vi.hoisted(() => ({
  mockFetch: vi.fn(),
  mockGetAppSettings: vi.fn(),
  mockGetConfiguredApiClient: vi.fn(),
  mockGenerateContent: vi.fn(),
  mockGenerateContentStream: vi.fn(),
}));

vi.mock('../baseApi', async () => {
  const actual = await vi.importActual<typeof import('../baseApi')>('../baseApi');
  return {
    ...actual,
    getConfiguredApiClient: mockGetConfiguredApiClient,
  };
});

vi.mock('../../logService', () => ({
  logService: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), recordTokenUsage: vi.fn() },
}));

vi.mock('../../../utils/db', () => ({
  dbService: {
    getAppSettings: mockGetAppSettings,
  },
}));

import {
  sendStatelessMessageNonStreamApi,
  sendStatelessMessageStreamApi,
} from '../chatApi';

describe('chatApi media resolution routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete window.__AMC_RUNTIME_CONFIG__;
    mockGetAppSettings.mockResolvedValue(null);
    mockGetConfiguredApiClient.mockResolvedValue({
      models: {
        generateContent: mockGenerateContent,
        generateContentStream: mockGenerateContentStream,
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses v1alpha for streaming requests with per-part media resolution', async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'done' }],
              },
            },
          ],
        };
      })(),
    );

    await sendStatelessMessageStreamApi(
      'key',
      'gemini-3.1-pro-preview',
      [],
      [
        {
          text: 'describe this image',
          mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' },
        } as unknown as Part,
      ],
      {},
      new AbortController().signal,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );

    expect(mockGetConfiguredApiClient).toHaveBeenCalledWith('key', {
      apiVersion: 'v1alpha',
    });
  });

  it('uses v1alpha for non-stream requests when history carries per-part media resolution', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: 'done' }],
          },
        },
      ],
    });

    await sendStatelessMessageNonStreamApi(
      'key',
      'gemini-3.1-pro-preview',
      [
        {
          role: 'user',
          parts: [
            {
              fileData: {
                fileUri: 'files/123',
                mimeType: 'image/png',
              },
              mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' },
            } as unknown as Part,
          ],
        },
      ],
      [{ text: 'continue' }],
      {},
      new AbortController().signal,
      vi.fn(),
      vi.fn(),
    );

    expect(mockGetConfiguredApiClient).toHaveBeenCalledWith('key', {
      apiVersion: 'v1alpha',
    });
  });

  it('accumulates streamed grounding metadata across chunks', async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              groundingMetadata: {
                webSearchQueries: ['latest gemini release'],
                groundingChunks: [
                  {
                    web: {
                      uri: 'https://example.com/first',
                      title: 'First source',
                    },
                  },
                ],
              },
              content: {
                parts: [{ text: 'Gemini ' }],
              },
            },
          ],
        };

        yield {
          candidates: [
            {
              groundingMetadata: {
                groundingChunks: [
                  {
                    web: {
                      uri: 'https://example.com/second',
                      title: 'Second source',
                    },
                  },
                ],
                groundingSupports: [
                  {
                    segment: { endIndex: 6 },
                    groundingChunkIndices: [0, 1],
                  },
                ],
              },
              content: {
                parts: [{ text: '3.1' }],
              },
            },
          ],
        };
      })(),
    );

    const onComplete = vi.fn();

    await sendStatelessMessageStreamApi(
      'key',
      'gemini-3-flash-preview',
      [],
      [{ text: 'What is the latest Gemini release?' }],
      { tools: [{ googleSearch: {} }] },
      new AbortController().signal,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      onComplete,
    );

    expect(onComplete).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({
        webSearchQueries: ['latest gemini release'],
        groundingChunks: [
          {
            web: {
              uri: 'https://example.com/first',
              title: 'First source',
            },
          },
          {
            web: {
              uri: 'https://example.com/second',
              title: 'Second source',
            },
          },
        ],
        groundingSupports: [
          {
            segment: { endIndex: 6 },
            groundingChunkIndices: [0, 1],
          },
        ],
      }),
      null,
    );
  });

  it('preserves streamed plain-text chunk boundaries when chunks start or end with newlines', async () => {
    mockGenerateContentStream.mockResolvedValue(
      (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'Hello\n' }],
              },
            },
          ],
        };

        yield {
          candidates: [
            {
              content: {
                parts: [{ text: '\nworld' }],
              },
            },
          ],
        };
      })(),
    );

    const onPart = vi.fn();

    await sendStatelessMessageStreamApi(
      'key',
      'gemini-3-flash-preview',
      [],
      [{ text: 'Write two paragraphs.' }],
      {},
      new AbortController().signal,
      onPart,
      vi.fn(),
      vi.fn(),
      vi.fn(),
    );

    expect(onPart).toHaveBeenNthCalledWith(1, { text: 'Hello\n' });
    expect(onPart).toHaveBeenNthCalledWith(2, { text: '\nworld' });
  });

  it('extracts Gemma thought channels from official non-stream text responses', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                text: '<|channel>thought\nPlan carefully.\n<channel|>Final answer.',
              },
            ],
          },
        },
      ],
    });

    const onComplete = vi.fn();

    await sendStatelessMessageNonStreamApi(
      'key',
      'gemma-4-31b-it',
      [],
      [{ text: 'Solve this' }],
      {},
      new AbortController().signal,
      vi.fn(),
      onComplete,
    );

    expect(onComplete).toHaveBeenCalledWith(
      [{ text: 'Final answer.' }],
      'Plan carefully.',
      undefined,
      undefined,
      undefined,
    );
  });

  it('forwards abortSignal through generateContent config for non-stream requests', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [{ text: 'done' }],
          },
        },
      ],
    });

    const abortController = new AbortController();

    await sendStatelessMessageNonStreamApi(
      'key',
      'gemini-3.1-flash-image-preview',
      [],
      [{ text: 'Generate an icon.' }],
      { responseModalities: ['IMAGE', 'TEXT'] },
      abortController.signal,
      vi.fn(),
      vi.fn(),
    );

    expect(mockGenerateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          abortSignal: abortController.signal,
        }),
      }),
    );
  });

  it('keeps backward compatibility for legacy Gemma thought channel formatting', async () => {
    mockGenerateContent.mockResolvedValue({
      candidates: [
        {
          content: {
            parts: [
              {
                text: '<|channel|thought>Plan carefully.<channel|>Final answer.',
              },
            ],
          },
        },
      ],
    });

    const onComplete = vi.fn();

    await sendStatelessMessageNonStreamApi(
      'key',
      'gemma-4-31b-it',
      [],
      [{ text: 'Solve this' }],
      {},
      new AbortController().signal,
      vi.fn(),
      onComplete,
    );

    expect(onComplete).toHaveBeenCalledWith(
      [{ text: 'Final answer.' }],
      'Plan carefully.',
      undefined,
      undefined,
      undefined,
    );
  });

  it('routes OpenAI-compatible non-stream chat models through Chat Completions', async () => {
    vi.stubGlobal('fetch', mockFetch);
    window.__AMC_RUNTIME_CONFIG__ = {
      useApiProxy: false,
    };
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Hello from GPT',
              },
            },
          ],
          usage: {
            prompt_tokens: 7,
            completion_tokens: 3,
            total_tokens: 10,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    const onComplete = vi.fn();

    await sendStatelessMessageNonStreamApi(
      'openai-key',
      'openai:gemini-2.5-pro',
      [
        {
          role: 'user',
          parts: [{ text: 'Earlier message' }],
        },
      ],
      [{ text: 'Continue' }],
      {
        systemInstruction: 'You are helpful.',
        temperature: 0.2,
        topP: 0.8,
      },
      new AbortController().signal,
      vi.fn(),
      onComplete,
    );

    expect(mockGetConfiguredApiClient).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get('authorization')).toBe('Bearer openai-key');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gemini-2.5-pro',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Earlier message' },
        { role: 'user', content: 'Continue' },
      ],
      stream: false,
      temperature: 0.2,
      top_p: 0.8,
    });
    expect(onComplete).toHaveBeenCalledWith(
      [{ text: 'Hello from GPT' }],
      undefined,
      {
        promptTokenCount: 7,
        candidatesTokenCount: 3,
        totalTokenCount: 10,
      },
      undefined,
      undefined,
    );
  });

  it('forwards OpenAI-compatible reasoning effort and reasoning split options when configured', async () => {
    vi.stubGlobal('fetch', mockFetch);
    window.__AMC_RUNTIME_CONFIG__ = {
      useApiProxy: false,
    };
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Reasoned answer' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await sendStatelessMessageNonStreamApi(
      'openai-key',
      'openai:gpt-5.3-codex',
      [],
      [{ text: 'Think carefully' }],
      {
        openAiReasoningEffort: 'high',
        openAiReasoningSplit: true,
      },
      new AbortController().signal,
      vi.fn(),
      vi.fn(),
    );

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'gpt-5.3-codex',
      reasoning_effort: 'high',
      reasoning_split: true,
    });
  });

  it('extracts OpenAI-compatible reasoning details as thoughts when providers return them', async () => {
    vi.stubGlobal('fetch', mockFetch);
    window.__AMC_RUNTIME_CONFIG__ = {
      useApiProxy: false,
    };
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'Final answer',
                reasoning_details: [
                  { type: 'reasoning.summary', summary: 'Checked the constraints.' },
                ],
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    const onComplete = vi.fn();

    await sendStatelessMessageNonStreamApi(
      'openai-key',
      'openai:gpt-5.3-codex',
      [],
      [{ text: 'Answer with reasoning details' }],
      {},
      new AbortController().signal,
      vi.fn(),
      onComplete,
    );

    expect(onComplete).toHaveBeenCalledWith(
      [{ text: 'Final answer' }],
      'Checked the constraints.',
      undefined,
      undefined,
      undefined,
    );
  });

  it('streams OpenAI-compatible chat through the sibling server-managed proxy', async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockGetAppSettings.mockResolvedValue({
      useCustomApiConfig: true,
      useApiProxy: true,
      apiProxyUrl: '/api/gemini',
    });
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
          },
        },
      ),
    );

    const onPart = vi.fn();
    const onComplete = vi.fn();

    await sendStatelessMessageStreamApi(
      '__SERVER_MANAGED_API_KEY__',
      'deepseek-chat',
      [],
      [{ text: 'Say hello' }],
      {},
      new AbortController().signal,
      onPart,
      vi.fn(),
      vi.fn(),
      onComplete,
    );

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/openai/v1/chat/completions');
    expect((init.headers as Headers).get('authorization')).toBeNull();
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      messages: [{ role: 'user', content: 'Say hello' }],
    });
    expect(onPart).toHaveBeenNthCalledWith(1, { text: 'Hel' });
    expect(onPart).toHaveBeenNthCalledWith(2, { text: 'lo' });
    expect(onComplete).toHaveBeenCalledWith(undefined, undefined, undefined);
  });

  it('routes Anthropic-compatible non-stream chat models through Messages API', async () => {
    vi.stubGlobal('fetch', mockFetch);
    window.__AMC_RUNTIME_CONFIG__ = {
      useApiProxy: false,
    };
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'Hello from Claude',
            },
          ],
          usage: {
            input_tokens: 11,
            output_tokens: 4,
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    const onComplete = vi.fn();

    await sendStatelessMessageNonStreamApi(
      'anthropic-key',
      'claude-3-5-sonnet-latest',
      [
        {
          role: 'user',
          parts: [{ text: 'Earlier message' }],
        },
      ],
      [{ text: 'Continue' }],
      {
        systemInstruction: 'You are helpful.',
        temperature: 0.2,
        topP: 0.8,
      },
      new AbortController().signal,
      vi.fn(),
      onComplete,
    );

    expect(mockGetConfiguredApiClient).not.toHaveBeenCalled();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeInstanceOf(Headers);
    expect((init.headers as Headers).get('x-api-key')).toBe('anthropic-key');
    expect((init.headers as Headers).get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'claude-3-5-sonnet-latest',
      messages: [
        { role: 'user', content: 'Earlier message' },
        { role: 'user', content: 'Continue' },
      ],
      max_tokens: 4096,
      stream: false,
      system: 'You are helpful.',
      temperature: 0.2,
      top_p: 0.8,
    });
    expect(onComplete).toHaveBeenCalledWith(
      [{ text: 'Hello from Claude' }],
      undefined,
      {
        promptTokenCount: 11,
        candidatesTokenCount: 4,
        totalTokenCount: 15,
      },
      undefined,
      undefined,
    );
  });

  it('streams Anthropic-compatible chat through the sibling server-managed proxy', async () => {
    vi.stubGlobal('fetch', mockFetch);
    mockGetAppSettings.mockResolvedValue({
      useCustomApiConfig: true,
      useApiProxy: true,
      apiProxyUrl: '/api/gemini',
    });
    const encoder = new TextEncoder();
    mockFetch.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('event: content_block_delta\n'));
            controller.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n'));
            controller.enqueue(encoder.encode('event: content_block_delta\n'));
            controller.enqueue(encoder.encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n'));
            controller.enqueue(encoder.encode('event: message_delta\n'));
            controller.enqueue(encoder.encode('data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n'));
            controller.close();
          },
        }),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
          },
        },
      ),
    );

    const onPart = vi.fn();
    const onComplete = vi.fn();

    await sendStatelessMessageStreamApi(
      '__SERVER_MANAGED_API_KEY__',
      'anthropic:claude-3-5-sonnet-latest',
      [],
      [{ text: 'Say hello' }],
      {},
      new AbortController().signal,
      onPart,
      vi.fn(),
      vi.fn(),
      onComplete,
    );

    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/anthropic/v1/messages');
    expect((init.headers as Headers).get('x-api-key')).toBeNull();
    expect((init.headers as Headers).get('anthropic-version')).toBe('2023-06-01');
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'claude-3-5-sonnet-latest',
      stream: true,
      messages: [{ role: 'user', content: 'Say hello' }],
    });
    expect(onPart).toHaveBeenNthCalledWith(1, { text: 'Hel' });
    expect(onPart).toHaveBeenNthCalledWith(2, { text: 'lo' });
    expect(onComplete).toHaveBeenCalledWith(
      {
        promptTokenCount: 0,
        candidatesTokenCount: 2,
        totalTokenCount: 2,
      },
      undefined,
      undefined,
    );
  });
});
