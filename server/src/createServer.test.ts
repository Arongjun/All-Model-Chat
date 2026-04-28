// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, createLiveTokenWithGemini } from './createServer';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const genAiMock = vi.hoisted(() => ({
  authTokensCreate: vi.fn(),
  constructorArgs: [] as unknown[],
}));

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(function GoogleGenAIMock(this: unknown, options: unknown) {
    genAiMock.constructorArgs.push(options);
    return {
      authTokens: {
        create: genAiMock.authTokensCreate,
      },
    };
  }),
}));

async function startHttpServer(server: http.Server): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

const cleanupCallbacks: Array<() => Promise<void>> = [];

async function createWorkspaceDataFilePath(): Promise<string> {
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'arong-workspace-test-'));
  cleanupCallbacks.push(async () => {
    await rm(tempDirectory, { recursive: true, force: true });
  });
  return path.join(tempDirectory, 'workspace.sqlite');
}

afterEach(async () => {
  genAiMock.authTokensCreate.mockReset();
  genAiMock.constructorArgs.length = 0;

  while (cleanupCallbacks.length) {
    const close = cleanupCallbacks.pop();
    if (close) {
      await close();
    }
  }
});

describe('createServer', () => {
  it('creates a single-use Live API token with the server-side Gemini client', async () => {
    genAiMock.authTokensCreate.mockResolvedValue({ name: 'tokens/mock-token' });

    const token = await createLiveTokenWithGemini('server-key');

    expect(token).toEqual({ name: 'tokens/mock-token' });
    expect(genAiMock.constructorArgs).toEqual([
      {
        apiKey: 'server-key',
        httpOptions: { apiVersion: 'v1alpha' },
      },
    ]);
    expect(genAiMock.authTokensCreate).toHaveBeenCalledWith({ config: { uses: 1 } });
  });

  it('returns health details from GET /health', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const app = createServer({
      geminiApiBase: 'https://generativelanguage.googleapis.com',
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: 'openai-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await fetch(`${started.baseUrl}/health`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
  });

  it('migrates a legacy JSON workspace snapshot into the SQLite workspace database', async () => {
    const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'arong-workspace-migration-test-'));
    cleanupCallbacks.push(async () => {
      await rm(tempDirectory, { recursive: true, force: true });
    });
    const workspaceDatabaseFilePath = path.join(tempDirectory, 'workspace.sqlite');
    const workspaceLegacyJsonFilePath = path.join(tempDirectory, 'workspace.json');
    const createdAt = new Date().toISOString();
    await writeFile(
      workspaceLegacyJsonFilePath,
      JSON.stringify({
        workspace: {
          name: 'Legacy Workspace',
          createdAt,
        },
        users: [],
        sessions: [],
        modelPolicies: [],
        redeemCodes: [],
        redemptions: [],
        rechargeOrders: [],
        usageRecords: [],
      }),
      'utf8',
    );

    const app = createServer({
      geminiApiBase: 'https://generativelanguage.googleapis.com',
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: 'openai-key',
      workspaceDatabaseFilePath,
      workspaceLegacyJsonFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await fetch(`${started.baseUrl}/api/workspace/bootstrap`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.workspaceName).toBe('Legacy Workspace');
    const databaseStats = await stat(workspaceDatabaseFilePath);
    expect(databaseStats.isFile()).toBe(true);
  });

  it('allows admins to create invite codes for self-service registration', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const app = createServer({
      geminiApiBase: 'https://generativelanguage.googleapis.com',
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: 'openai-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie') || '';
    expect(bootstrapResponse.status).toBe(200);
    expect(adminCookie).toContain('arong_workspace_session=');

    const createInviteResponse = await fetch(`${started.baseUrl}/api/workspace/admin/invite-codes`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        code: 'BETA-ONE',
        description: 'Beta invite',
        credits: 42,
        maxRedemptions: 1,
        modelAllowances: {
          'gpt-image-*': 2,
        },
      }),
    });
    const createInviteBody = (await createInviteResponse.json()) as {
      inviteCodes: Array<{
        code: string;
        credits: number;
        maxRedemptions: number;
        redeemedCount: number;
        modelAllowances: Record<string, number>;
      }>;
    };
    expect(createInviteResponse.status).toBe(200);
    expect(createInviteBody.inviteCodes).toEqual([
      expect.objectContaining({
        code: 'BETA-ONE',
        credits: 42,
        maxRedemptions: 1,
        redeemedCount: 0,
        modelAllowances: { 'gpt-image-*': 2 },
      }),
    ]);

    const registerResponse = await fetch(`${started.baseUrl}/api/workspace/session/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Invited Member',
        email: 'invited@example.com',
        password: 'member123',
        inviteCode: 'beta-one',
      }),
    });
    const memberCookie = registerResponse.headers.get('set-cookie') || '';
    const registerBody = (await registerResponse.json()) as {
      currentUser: {
        email: string;
        role: string;
        credits: number;
        modelAllowances: Record<string, number>;
      };
    };
    expect(registerResponse.status).toBe(200);
    expect(memberCookie).toContain('arong_workspace_session=');
    expect(registerBody.currentUser).toEqual(expect.objectContaining({
      email: 'invited@example.com',
      role: 'member',
      credits: 42,
      modelAllowances: { 'gpt-image-*': 2 },
    }));

    const sessionResponse = await fetch(`${started.baseUrl}/api/workspace/session`, {
      headers: { cookie: memberCookie },
    });
    const sessionBody = (await sessionResponse.json()) as { currentUser: { email: string } | null };
    expect(sessionResponse.status).toBe(200);
    expect(sessionBody.currentUser?.email).toBe('invited@example.com');

    const exhaustedResponse = await fetch(`${started.baseUrl}/api/workspace/session/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Second Member',
        email: 'second@example.com',
        password: 'member123',
        inviteCode: 'BETA-ONE',
      }),
    });
    expect(exhaustedResponse.status).toBe(400);

    const usageResponse = await fetch(
      `${started.baseUrl}/api/workspace/admin/usage?operationType=invite_registration`,
      { headers: { cookie: adminCookie } },
    );
    const usageBody = (await usageResponse.json()) as {
      items: Array<{ operationType: string; modelId: string; creditsDelta: number }>;
    };
    expect(usageResponse.status).toBe(200);
    expect(usageBody.items).toEqual([
      expect.objectContaining({
        operationType: 'invite_registration',
        modelId: 'invite:BETA-ONE',
        creditsDelta: 42,
      }),
    ]);
  });

  it('returns a Live API token payload from GET /api/live-token', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const createLiveToken = vi.fn(async (apiKey: string) => ({ name: `tokens/${apiKey}` }));
    const app = createServer(
      {
        geminiApiBase: 'https://generativelanguage.googleapis.com',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://api.openai.com/v1',
        openaiApiKey: 'openai-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { createLiveToken },
    );

    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await fetch(`${started.baseUrl}/api/live-token`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual({ name: 'tokens/server-key' });
    expect(createLiveToken).toHaveBeenCalledWith('server-key');
  });

  it('proxies /api/gemini/* preserving method/path/query/body and streaming response', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const upstreamRequests: Array<{
      method: string;
      url: string;
      body: string;
      headers: http.IncomingHttpHeaders;
    }> = [];

    const upstream = http.createServer((request, response) => {
      const bodyChunks: Buffer[] = [];
      request.on('data', (chunk) => bodyChunks.push(Buffer.from(chunk)));
      request.on('end', () => {
        upstreamRequests.push({
          method: request.method ?? '',
          url: request.url ?? '',
          body: Buffer.concat(bodyChunks).toString('utf8'),
          headers: request.headers,
        });

        response.writeHead(201, {
          'content-type': 'text/event-stream',
          'x-upstream': 'yes',
        });
        response.write('chunk-1\n');
        setTimeout(() => {
          response.write('chunk-2\n');
          response.end();
        }, 25);
      });
    });

    const upstreamStarted = await startHttpServer(upstream);
    cleanupCallbacks.push(upstreamStarted.close);

    const app = createServer({
      geminiApiBase: upstreamStarted.baseUrl,
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: 'openai-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const appStarted = await startHttpServer(app);
    cleanupCallbacks.push(appStarted.close);

    const proxyResponse = await fetch(
      `${appStarted.baseUrl}/api/gemini/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-client-header': 'present',
        },
        body: JSON.stringify({ prompt: 'hello' }),
      },
    );

    const proxyBody = await proxyResponse.text();

    expect(proxyResponse.status).toBe(201);
    expect(proxyResponse.headers.get('content-type')).toContain('text/event-stream');
    expect(proxyResponse.headers.get('x-upstream')).toBe('yes');
    expect(proxyBody).toContain('chunk-1');
    expect(proxyBody).toContain('chunk-2');

    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].method).toBe('POST');
    expect(upstreamRequests[0].url).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(upstreamRequests[0].body).toBe(JSON.stringify({ prompt: 'hello' }));
    expect(upstreamRequests[0].headers['x-goog-api-key']).toBe('server-key');
    expect(upstreamRequests[0].headers['x-client-header']).toBe('present');
  });

  it('filters hop-by-hop and sensitive request headers before proxying', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response('proxied', { status: 202 });
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://api.openai.com/v1',
        openaiApiKey: 'openai-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const request = http.request(`${started.baseUrl}/api/gemini/v1beta/models`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'keep-alive',
          te: 'trailers',
          authorization: 'Bearer user-token',
          cookie: 'session=abc',
          'accept-encoding': 'gzip',
          'x-client-header': 'present',
        },
      });

      request.on('response', (proxyResponse) => {
        proxyResponse.resume();
        proxyResponse.on('end', () => {
          resolve({ statusCode: proxyResponse.statusCode ?? 0 });
        });
      });
      request.on('error', reject);
      request.end(JSON.stringify({ prompt: 'hello' }));
    });

    expect(response.statusCode).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected fetchImpl to be called once');
    }

    const init = firstCall[1];
    expect(init).toBeDefined();
    if (!init) {
      throw new Error('Expected fetchImpl to receive RequestInit');
    }

    const headers = init.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error('Expected proxy request headers to be a Headers instance');
    }

    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-client-header')).toBe('present');
    expect(headers.get('x-goog-api-key')).toBe('server-key');
    expect(headers.get('connection')).toBeNull();
    expect(headers.get('te')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('accept-encoding')).toBeNull();
  });

  it('returns a 502 JSON error when Gemini upstream fetch fails', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://api.openai.com/v1',
        openaiApiKey: 'openai-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await fetch(`${started.baseUrl}/api/gemini/v1beta/models`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(502);
    expect(body).toEqual({
      error: 'Gemini upstream request failed: network down',
    });
  });

  it('proxies OpenAI image generation requests with server-side auth and preserved JSON body', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          data: [{ b64_json: 'base64-image' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-openai-upstream': 'yes',
          },
        },
      );
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://api.openai.com/v1',
        openaiApiKey: 'openai-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await fetch(`${started.baseUrl}/api/openai/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-header': 'present',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'draw a robot',
        size: '2048x1152',
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-openai-upstream')).toBe('yes');
    expect(body).toEqual({
      data: [{ b64_json: 'base64-image' }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected fetchImpl to be called once');
    }

    const [upstreamUrl, init] = firstCall as [string, RequestInit];
    expect(upstreamUrl).toBe('https://api.openai.com/v1/images/generations');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeInstanceOf(Headers);

    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer openai-key');
    expect(headers.get('x-client-header')).toBe('present');
    expect(headers.get('cookie')).toBeNull();

    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'draw a robot',
      size: '2048x1152',
    });
  });

  it('proxies OpenAI-compatible chat completion requests with server-side auth and preserved JSON body', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: 'hello',
              },
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-openai-upstream': 'yes',
          },
        },
      );
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://gateway.example.test/v1',
        openaiApiKey: 'openai-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await fetch(`${started.baseUrl}/api/openai/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-header': 'present',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-openai-upstream')).toBe('yes');
    expect(body).toEqual({
      choices: [
        {
          message: {
            content: 'hello',
          },
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected fetchImpl to be called once');
    }

    const [upstreamUrl, init] = firstCall as [string, RequestInit];
    expect(upstreamUrl).toBe('https://gateway.example.test/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeInstanceOf(Headers);

    const headers = init.headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer openai-key');
    expect(headers.get('x-client-header')).toBe('present');
    expect(headers.get('cookie')).toBeNull();

    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
  });

  it('uses admin-saved API settings before environment variables for proxied requests', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello from workspace config' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://env-openai.example.test/v1',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie');
    expect(adminCookie).toContain('arong_workspace_session=');

    const settingsResponse = await fetch(`${started.baseUrl}/api/workspace/admin/api-settings`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie || '',
      },
      body: JSON.stringify({
        providers: {
          openai: {
            apiKey: 'workspace-openai-key',
            apiBase: 'https://workspace-openai.example.test/v1',
          },
        },
      }),
    });
    const settingsBody = (await settingsResponse.json()) as {
      providers: Array<{
        provider: string;
        apiKeySource: string;
        apiBaseSource: string;
        apiKeyConfigured: boolean;
      }>;
    };
    const openaiSetting = settingsBody.providers.find((provider) => provider.provider === 'openai');
    expect(settingsResponse.status).toBe(200);
    expect(openaiSetting).toMatchObject({
      apiKeySource: 'workspace',
      apiBaseSource: 'workspace',
      apiKeyConfigured: true,
    });

    const chatResponse = await fetch(`${started.baseUrl}/api/openai/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie || '',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(chatResponse.status).toBe(200);

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected fetchImpl to be called once');
    }

    const [upstreamUrl, init] = firstCall as [string, RequestInit];
    expect(upstreamUrl).toBe('https://workspace-openai.example.test/v1/chat/completions');
    expect((init.headers as Headers).get('authorization')).toBe('Bearer workspace-openai-key');

    const diagnosticsResponse = await fetch(`${started.baseUrl}/api/workspace/admin/diagnostics`, {
      headers: { cookie: adminCookie || '' },
    });
    const diagnostics = (await diagnosticsResponse.json()) as {
      server: {
        openaiApiConfigured: boolean;
        openaiApiBase: string;
        apiSettings: Array<{ provider: string; apiKeySource: string; apiBaseSource: string }>;
      };
    };
    const diagnosticsOpenAiSetting = diagnostics.server.apiSettings.find((provider) => provider.provider === 'openai');
    expect(diagnostics.server.openaiApiConfigured).toBe(true);
    expect(diagnostics.server.openaiApiBase).toBe('https://workspace-openai.example.test/v1');
    expect(diagnosticsOpenAiSetting).toMatchObject({
      apiKeySource: 'workspace',
      apiBaseSource: 'workspace',
    });
  });

  it('imports environment API settings into the workspace without exposing raw keys', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const app = createServer({
      geminiApiBase: 'https://env-gemini.example.test',
      geminiApiKey: 'env-gemini-key',
      openaiApiBase: 'https://env-openai.example.test/v1',
      openaiApiKey: 'env-openai-key',
      anthropicApiBase: 'https://env-anthropic.example.test',
      anthropicApiKey: 'env-anthropic-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie');
    expect(adminCookie).toContain('arong_workspace_session=');

    const importResponse = await fetch(`${started.baseUrl}/api/workspace/admin/api-settings/import-environment`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie || '',
      },
      body: JSON.stringify({}),
    });
    const body = (await importResponse.json()) as {
      providers: Array<{
        provider: string;
        apiKeyPreview: string | null;
        apiKeySource: string;
        apiBaseSource: string;
      }>;
    };

    expect(importResponse.status).toBe(200);
    expect(body.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'gemini',
          apiKeyPreview: 'env-...-key',
          apiKeySource: 'workspace',
          apiBaseSource: 'workspace',
        }),
        expect.objectContaining({
          provider: 'openai',
          apiKeyPreview: 'env-...-key',
          apiKeySource: 'workspace',
          apiBaseSource: 'workspace',
        }),
        expect.objectContaining({
          provider: 'anthropic',
          apiKeyPreview: 'env-...-key',
          apiKeySource: 'workspace',
          apiBaseSource: 'workspace',
        }),
      ]),
    );
    expect(JSON.stringify(body)).not.toContain('env-openai-key');
    expect(JSON.stringify(body)).not.toContain('env-anthropic-key');
  });

  it('proxies Anthropic-compatible messages requests with server-side auth and preserved JSON body', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          content: [
            {
              type: 'text',
              text: 'hello',
            },
          ],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-anthropic-upstream': 'yes',
          },
        },
      );
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://gateway.example.test/v1',
        openaiApiKey: 'openai-key',
        anthropicApiBase: 'https://anthropic-gateway.example.test/v1',
        anthropicApiKey: 'anthropic-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const response = await fetch(`${started.baseUrl}/api/anthropic/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-client-header': 'present',
        cookie: 'should-not-forward=true',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
        stream: false,
      }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('x-anthropic-upstream')).toBe('yes');
    expect(body).toEqual({
      content: [
        {
          type: 'text',
          text: 'hello',
        },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const firstCall = fetchImpl.mock.calls[0];
    expect(firstCall).toBeDefined();
    if (!firstCall) {
      throw new Error('Expected fetchImpl to be called once');
    }

    const [upstreamUrl, init] = firstCall as [string, RequestInit];
    expect(upstreamUrl).toBe('https://anthropic-gateway.example.test/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeInstanceOf(Headers);

    const headers = init.headers as Headers;
    expect(headers.get('x-api-key')).toBe('anthropic-key');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('x-client-header')).toBe('present');
    expect(headers.get('cookie')).toBeNull();

    expect(JSON.parse(String(init.body))).toEqual({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    });
  });

  it('enforces workspace login and consumes image allowances for proxied model requests', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const upstream = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    const upstreamStarted = await startHttpServer(upstream);
    cleanupCallbacks.push(upstreamStarted.close);

    const app = createServer({
      geminiApiBase: upstreamStarted.baseUrl,
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: 'openai-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie');
    expect(bootstrapResponse.status).toBe(200);
    expect(adminCookie).toContain('arong_workspace_session=');

    const createUserResponse = await fetch(`${started.baseUrl}/api/workspace/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie || '',
      },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.com',
        password: 'member123',
        role: 'member',
        credits: 0,
        modelAllowances: {
          'gemini-3.1-flash-image-preview': 1,
        },
      }),
    });
    expect(createUserResponse.status).toBe(200);

    const unauthorizedResponse = await fetch(
      `${started.baseUrl}/api/gemini/v1beta/models/gemini-3.1-flash-image-preview:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      },
    );
    const unauthorizedBody = (await unauthorizedResponse.json()) as Record<string, unknown>;
    expect(unauthorizedResponse.status).toBe(401);
    expect(String(unauthorizedBody.error)).toContain('登录');
    expect(String(unauthorizedBody.error)).toContain('设置');

    const memberLoginResponse = await fetch(`${started.baseUrl}/api/workspace/session/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'member@example.com',
        password: 'member123',
      }),
    });
    const memberCookie = memberLoginResponse.headers.get('set-cookie');
    expect(memberLoginResponse.status).toBe(200);
    expect(memberCookie).toContain('arong_workspace_session=');

    const firstModelRequest = await fetch(
      `${started.baseUrl}/api/gemini/v1beta/models/gemini-3.1-flash-image-preview:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: memberCookie || '',
        },
        body: JSON.stringify({ prompt: 'hello' }),
      },
    );
    expect(firstModelRequest.status).toBe(200);

    const secondModelRequest = await fetch(
      `${started.baseUrl}/api/gemini/v1beta/models/gemini-3.1-flash-image-preview:generateContent`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: memberCookie || '',
        },
        body: JSON.stringify({ prompt: 'hello again' }),
      },
    );
    const secondBody = (await secondModelRequest.json()) as Record<string, unknown>;
    expect(secondModelRequest.status).toBe(402);
    expect(String(secondBody.error)).toContain('额度不足');
  });
  it('enforces workspace login and consumes OpenAI image allowances for proxied image generation', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ b64_json: 'base64-image' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://api.openai.com/v1',
        openaiApiKey: 'openai-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie');
    expect(adminCookie).toContain('arong_workspace_session=');

    const createUserResponse = await fetch(`${started.baseUrl}/api/workspace/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie || '',
      },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.com',
        password: 'member123',
        role: 'member',
        credits: 0,
        modelAllowances: {
          'gpt-image-*': 1,
        },
      }),
    });
    expect(createUserResponse.status).toBe(200);

    const unauthorizedResponse = await fetch(`${started.baseUrl}/api/openai/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'draw a robot',
      }),
    });
    expect(unauthorizedResponse.status).toBe(401);

    const memberLoginResponse = await fetch(`${started.baseUrl}/api/workspace/session/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'member@example.com',
        password: 'member123',
      }),
    });
    const memberCookie = memberLoginResponse.headers.get('set-cookie');
    expect(memberCookie).toContain('arong_workspace_session=');

    const firstImageRequest = await fetch(`${started.baseUrl}/api/openai/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie || '',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'draw a robot',
      }),
    });
    expect(firstImageRequest.status).toBe(200);

    const secondImageRequest = await fetch(`${started.baseUrl}/api/openai/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie || '',
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: 'draw another robot',
      }),
    });
    const secondBody = (await secondImageRequest.json()) as Record<string, unknown>;
    expect(secondImageRequest.status).toBe(402);
    expect(typeof secondBody.error).toBe('string');
  });

  it('enforces workspace login and consumes OpenAI-compatible chat allowances for proxied chat completions', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'hello' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://api.openai.com/v1',
        openaiApiKey: 'openai-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie');
    expect(adminCookie).toContain('arong_workspace_session=');

    const createUserResponse = await fetch(`${started.baseUrl}/api/workspace/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie || '',
      },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.com',
        password: 'member123',
        role: 'member',
        credits: 0,
        modelAllowances: {
          'gpt-*': 1,
        },
      }),
    });
    expect(createUserResponse.status).toBe(200);

    const unauthorizedResponse = await fetch(`${started.baseUrl}/api/openai/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(unauthorizedResponse.status).toBe(401);

    const memberLoginResponse = await fetch(`${started.baseUrl}/api/workspace/session/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'member@example.com',
        password: 'member123',
      }),
    });
    const memberCookie = memberLoginResponse.headers.get('set-cookie');
    expect(memberCookie).toContain('arong_workspace_session=');

    const firstChatRequest = await fetch(`${started.baseUrl}/api/openai/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie || '',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(firstChatRequest.status).toBe(200);

    const secondChatRequest = await fetch(`${started.baseUrl}/api/openai/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie || '',
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello again' }],
      }),
    });
    const secondBody = (await secondChatRequest.json()) as Record<string, unknown>;
    expect(secondChatRequest.status).toBe(402);
    expect(typeof secondBody.error).toBe('string');
  });

  it('enforces workspace login and consumes Anthropic-compatible chat allowances for proxied messages', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'hello' }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
          },
        },
      );
    });
    const app = createServer(
      {
        geminiApiBase: 'https://example.test',
        geminiApiKey: 'server-key',
        openaiApiBase: 'https://api.openai.com/v1',
        openaiApiKey: 'openai-key',
        anthropicApiBase: 'https://api.anthropic.com',
        anthropicApiKey: 'anthropic-key',
        workspaceDataFilePath,
        workspaceSessionTtlHours: 24,
      },
      { fetchImpl },
    );
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie');
    expect(adminCookie).toContain('arong_workspace_session=');

    const createUserResponse = await fetch(`${started.baseUrl}/api/workspace/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie || '',
      },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.com',
        password: 'member123',
        role: 'member',
        credits: 0,
        modelAllowances: {
          'claude-*': 1,
        },
      }),
    });
    expect(createUserResponse.status).toBe(200);

    const unauthorizedResponse = await fetch(`${started.baseUrl}/api/anthropic/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(unauthorizedResponse.status).toBe(401);

    const memberLoginResponse = await fetch(`${started.baseUrl}/api/workspace/session/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'member@example.com',
        password: 'member123',
      }),
    });
    const memberCookie = memberLoginResponse.headers.get('set-cookie');
    expect(memberCookie).toContain('arong_workspace_session=');

    const firstChatRequest = await fetch(`${started.baseUrl}/api/anthropic/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie || '',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(firstChatRequest.status).toBe(200);

    const secondChatRequest = await fetch(`${started.baseUrl}/api/anthropic/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: memberCookie || '',
      },
      body: JSON.stringify({
        model: 'claude-3-5-sonnet-latest',
        max_tokens: 1024,
        messages: [{ role: 'user', content: 'hello again' }],
      }),
    });
    const secondBody = (await secondChatRequest.json()) as Record<string, unknown>;
    expect(secondChatRequest.status).toBe(402);
    expect(typeof secondBody.error).toBe('string');
  });

  it('records manual balance adjustments and exports filtered usage audit CSV', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const app = createServer({
      geminiApiBase: 'https://example.test',
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: 'openai-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie') || '';
    expect(bootstrapResponse.status).toBe(200);

    const createUserResponse = await fetch(`${started.baseUrl}/api/workspace/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.com',
        password: 'member123',
        role: 'member',
        credits: 10,
        modelAllowances: {},
      }),
    });
    const createUserBody = (await createUserResponse.json()) as {
      users: Array<{ id: string; email: string; credits: number; modelAllowances: Record<string, number> }>;
    };
    const member = createUserBody.users.find((user) => user.email === 'member@example.com');
    expect(member).toBeDefined();
    if (!member) {
      throw new Error('Expected member to be created');
    }

    const adjustResponse = await fetch(
      `${started.baseUrl}/api/workspace/admin/users/${encodeURIComponent(member.id)}/adjust-balance`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: adminCookie,
        },
        body: JSON.stringify({
          creditsDelta: 25,
          modelAllowanceDeltas: {
            'gpt-image-*': 3,
          },
          reason: 'offline recharge',
        }),
      },
    );
    const adjustBody = (await adjustResponse.json()) as {
      users: Array<{ id: string; credits: number; modelAllowances: Record<string, number> }>;
    };
    expect(adjustResponse.status).toBe(200);
    const adjustedMember = adjustBody.users.find((user) => user.id === member.id);
    expect(adjustedMember?.credits).toBe(35);
    expect(adjustedMember?.modelAllowances['gpt-image-*']).toBe(3);

    const usageResponse = await fetch(
      `${started.baseUrl}/api/workspace/admin/usage?userId=${encodeURIComponent(member.id)}&operationType=admin_adjustment`,
      {
        headers: {
          cookie: adminCookie,
        },
      },
    );
    const usageBody = (await usageResponse.json()) as {
      total: number;
      items: Array<{
        operationType: string;
        source: string;
        status: string;
        creditsDelta: number;
        allowanceChanges: Record<string, number>;
        note: string;
      }>;
    };
    expect(usageResponse.status).toBe(200);
    expect(usageBody.total).toBe(1);
    expect(usageBody.items[0]).toMatchObject({
      operationType: 'admin_adjustment',
      source: 'admin',
      status: 'adjusted',
      creditsDelta: 25,
      allowanceChanges: {
        'gpt-image-*': 3,
      },
      note: 'offline recharge',
    });

    const csvResponse = await fetch(
      `${started.baseUrl}/api/workspace/admin/usage.csv?operationType=admin_adjustment`,
      {
        headers: {
          cookie: adminCookie,
        },
      },
    );
    const csv = await csvResponse.text();
    expect(csvResponse.status).toBe(200);
    expect(csvResponse.headers.get('content-type')).toContain('text/csv');
    expect(csv).toContain('offline recharge');
    expect(csv).toContain('gpt-image-*');
  });

  it('creates recharge orders, confirms payment, and records order recharge audit usage', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const app = createServer({
      geminiApiBase: 'https://example.test',
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://api.openai.com/v1',
      openaiApiKey: 'openai-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie') || '';
    expect(bootstrapResponse.status).toBe(200);

    const createUserResponse = await fetch(`${started.baseUrl}/api/workspace/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.com',
        password: 'member123',
        role: 'member',
        credits: 10,
        modelAllowances: {},
      }),
    });
    const createUserBody = (await createUserResponse.json()) as {
      users: Array<{ id: string; email: string; credits: number; modelAllowances: Record<string, number> }>;
    };
    const member = createUserBody.users.find((user) => user.email === 'member@example.com');
    expect(member).toBeDefined();
    if (!member) {
      throw new Error('Expected member to be created');
    }

    const createOrderResponse = await fetch(`${started.baseUrl}/api/workspace/admin/recharge-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        userId: member.id,
        amountCents: 9900,
        currency: 'CNY',
        credits: 120,
        modelAllowances: {
          'gpt-image-*': 2,
        },
        paymentMethod: 'wechat',
        externalReference: 'wx-pay-123',
        note: 'pro image pack',
      }),
    });
    const createOrderBody = (await createOrderResponse.json()) as {
      users: Array<{ id: string; credits: number; modelAllowances: Record<string, number> }>;
      rechargeOrders: Array<{
        id: string;
        userId: string;
        status: string;
        amountCents: number;
        credits: number;
        modelAllowances: Record<string, number>;
        externalReference: string | null;
      }>;
    };
    expect(createOrderResponse.status).toBe(200);
    const pendingOrder = createOrderBody.rechargeOrders.find((order) => order.userId === member.id);
    expect(pendingOrder).toMatchObject({
      status: 'pending',
      amountCents: 9900,
      credits: 120,
      externalReference: 'wx-pay-123',
      modelAllowances: {
        'gpt-image-*': 2,
      },
    });
    expect(createOrderBody.users.find((user) => user.id === member.id)?.credits).toBe(10);
    if (!pendingOrder) {
      throw new Error('Expected recharge order to be created');
    }

    const paidResponse = await fetch(
      `${started.baseUrl}/api/workspace/admin/recharge-orders/${encodeURIComponent(pendingOrder.id)}/mark-paid`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
        },
      },
    );
    const paidBody = (await paidResponse.json()) as {
      users: Array<{ id: string; credits: number; modelAllowances: Record<string, number> }>;
      rechargeOrders: Array<{ id: string; status: string; confirmedByName: string | null }>;
    };
    expect(paidResponse.status).toBe(200);
    const paidMember = paidBody.users.find((user) => user.id === member.id);
    expect(paidMember?.credits).toBe(130);
    expect(paidMember?.modelAllowances['gpt-image-*']).toBe(2);
    expect(paidBody.rechargeOrders.find((order) => order.id === pendingOrder.id)).toMatchObject({
      status: 'paid',
      confirmedByName: 'Admin',
    });

    const usageResponse = await fetch(
      `${started.baseUrl}/api/workspace/admin/usage?userId=${encodeURIComponent(member.id)}&operationType=order_recharge`,
      {
        headers: {
          cookie: adminCookie,
        },
      },
    );
    const usageBody = (await usageResponse.json()) as {
      total: number;
      items: Array<{
        operationType: string;
        source: string;
        status: string;
        creditsDelta: number;
        allowanceChanges: Record<string, number>;
        modelId: string;
      }>;
    };
    expect(usageResponse.status).toBe(200);
    expect(usageBody.total).toBe(1);
    expect(usageBody.items[0]).toMatchObject({
      operationType: 'order_recharge',
      source: 'order',
      status: 'success',
      creditsDelta: 120,
      allowanceChanges: {
        'gpt-image-*': 2,
      },
    });
    expect(usageBody.items[0].modelId).toContain('order:');

    const cancelOrderResponse = await fetch(`${started.baseUrl}/api/workspace/admin/recharge-orders`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        userId: member.id,
        amountCents: 1000,
        currency: 'CNY',
        credits: 10,
        modelAllowances: {},
        paymentMethod: 'manual',
      }),
    });
    const cancelOrderBody = (await cancelOrderResponse.json()) as {
      rechargeOrders: Array<{ id: string; status: string }>;
    };
    expect(cancelOrderResponse.status).toBe(200);
    const orderToCancel = cancelOrderBody.rechargeOrders.find((order) => order.status === 'pending');
    expect(orderToCancel).toBeDefined();
    if (!orderToCancel) {
      throw new Error('Expected pending order to cancel');
    }

    const cancelledResponse = await fetch(
      `${started.baseUrl}/api/workspace/admin/recharge-orders/${encodeURIComponent(orderToCancel.id)}/cancel`,
      {
        method: 'POST',
        headers: {
          cookie: adminCookie,
        },
      },
    );
    const cancelledBody = (await cancelledResponse.json()) as {
      users: Array<{ id: string; credits: number }>;
      rechargeOrders: Array<{ id: string; status: string }>;
    };
    expect(cancelledResponse.status).toBe(200);
    expect(cancelledBody.rechargeOrders.find((order) => order.id === orderToCancel.id)?.status).toBe('cancelled');
    expect(cancelledBody.users.find((user) => user.id === member.id)?.credits).toBe(130);
  });

  it('returns admin diagnostics and exports a session-free workspace backup', async () => {
    const workspaceDataFilePath = await createWorkspaceDataFilePath();
    const app = createServer({
      geminiApiBase: 'https://example.test/gemini',
      geminiApiKey: 'server-key',
      openaiApiBase: 'https://gateway.example.test/v1',
      openaiApiKey: 'openai-key',
      anthropicApiBase: 'https://anthropic-gateway.example.test/v1',
      anthropicApiKey: 'anthropic-key',
      workspaceDataFilePath,
      workspaceSessionTtlHours: 24,
    });
    const started = await startHttpServer(app);
    cleanupCallbacks.push(started.close);

    const bootstrapResponse = await fetch(`${started.baseUrl}/api/workspace/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'admin123',
      }),
    });
    const adminCookie = bootstrapResponse.headers.get('set-cookie') || '';
    expect(bootstrapResponse.status).toBe(200);

    const createUserResponse = await fetch(`${started.baseUrl}/api/workspace/admin/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: adminCookie,
      },
      body: JSON.stringify({
        name: 'Member',
        email: 'member@example.com',
        password: 'member123',
        role: 'member',
        credits: 10,
        modelAllowances: {
          'gpt-image-*': 1,
        },
      }),
    });
    expect(createUserResponse.status).toBe(200);

    const diagnosticsResponse = await fetch(`${started.baseUrl}/api/workspace/admin/diagnostics`, {
      headers: {
        cookie: adminCookie,
      },
    });
    const diagnostics = (await diagnosticsResponse.json()) as {
      counts: {
        users: number;
        admins: number;
        members: number;
        activeSessions: number;
      };
      storage: {
        database: {
          exists: boolean;
          sizeBytes: number;
          filePath: string | null;
        };
      };
      server: {
        geminiApiConfigured: boolean;
        openaiApiConfigured: boolean;
        anthropicApiConfigured: boolean;
        geminiApiBase: string;
        openaiApiBase: string;
        anthropicApiBase: string;
      };
    };
    expect(diagnosticsResponse.status).toBe(200);
    expect(diagnostics.counts.users).toBe(2);
    expect(diagnostics.counts.admins).toBe(1);
    expect(diagnostics.counts.members).toBe(1);
    expect(diagnostics.counts.activeSessions).toBeGreaterThanOrEqual(1);
    expect(diagnostics.storage.database.exists).toBe(true);
    expect(diagnostics.storage.database.sizeBytes).toBeGreaterThan(0);
    expect(diagnostics.storage.database.filePath).toContain('workspace.sqlite');
    expect(diagnostics.server).toMatchObject({
      geminiApiConfigured: true,
      openaiApiConfigured: true,
      anthropicApiConfigured: true,
      geminiApiBase: 'https://example.test/gemini',
      openaiApiBase: 'https://gateway.example.test/v1',
      anthropicApiBase: 'https://anthropic-gateway.example.test/v1',
    });

    const backupResponse = await fetch(`${started.baseUrl}/api/workspace/admin/backup.json`, {
      headers: {
        cookie: adminCookie,
      },
    });
    const backup = (await backupResponse.json()) as {
      kind: string;
      schemaVersion: number;
      containsSensitiveAuthData: boolean;
      sessionsExported: boolean;
      data: {
        users: Array<{
          email: string;
          passwordHash?: string;
          passwordSalt?: string;
        }>;
        sessions: unknown[];
      };
    };
    expect(backupResponse.status).toBe(200);
    expect(backupResponse.headers.get('cache-control')).toBe('no-store');
    expect(backupResponse.headers.get('content-disposition')).toContain('arong-workspace-backup-');
    expect(backup.kind).toBe('arong-workspace-backup');
    expect(backup.schemaVersion).toBe(1);
    expect(backup.containsSensitiveAuthData).toBe(true);
    expect(backup.sessionsExported).toBe(false);
    expect(backup.data.sessions).toEqual([]);
    expect(backup.data.users.some((user) => user.email === 'member@example.com')).toBe(true);
    expect(backup.data.users[0].passwordHash).toBeTruthy();
    expect(backup.data.users[0].passwordSalt).toBeTruthy();

    const memberLoginResponse = await fetch(`${started.baseUrl}/api/workspace/session/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'member@example.com',
        password: 'member123',
      }),
    });
    const memberCookie = memberLoginResponse.headers.get('set-cookie') || '';
    expect(memberLoginResponse.status).toBe(200);

    const forbiddenDiagnosticsResponse = await fetch(`${started.baseUrl}/api/workspace/admin/diagnostics`, {
      headers: {
        cookie: memberCookie,
      },
    });
    expect(forbiddenDiagnosticsResponse.status).toBe(403);
  });
});
