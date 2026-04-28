
import type { FunctionCall, GenerateContentResponse, Part, UsageMetadata } from "@google/genai";
import {
    ChatHistoryItem,
    ThoughtSupportingPart,
    StreamMessageSender,
    NonStreamMessageSender,
    NonStreamMessageCompleteHandler,
} from '../../types';
import { logService } from "../logService";
import { getConfiguredApiClient, getEffectiveApiRequestSettings, getHttpOptionsForContents } from "./baseApi";
import { extractGemmaThoughtChannel } from "../../utils/chat/reasoning";
import { SERVER_MANAGED_API_KEY } from "../../utils/apiUtils";
import {
    buildAnthropicMessagesRequestUrl,
    buildOpenAiChatCompletionsRequestUrl,
    DEFAULT_ANTHROPIC_API_BASE_URL,
    DEFAULT_OPENAI_API_BASE_URL,
    deriveSiblingProviderProxyUrl,
} from "../../utils/apiProxyUrl";
import {
    isAnthropicCompatibleChatModel,
    isOpenAiCompatibleChatModel,
    stripModelProviderPrefix,
} from "../../utils/modelHelpers";

type CandidateWithUrlContext = {
    groundingMetadata?: unknown;
    urlContextMetadata?: unknown;
    url_context_metadata?: unknown;
};

type MetadataWithCitations = {
    citations?: Array<{ uri?: string }>;
} & Record<string, unknown>;

type OpenAiChatRole = 'system' | 'user' | 'assistant';

type OpenAiTextContentPart = {
    type: 'text';
    text: string;
};

type OpenAiImageContentPart = {
    type: 'image_url';
    image_url: {
        url: string;
    };
};

type OpenAiContentPart = OpenAiTextContentPart | OpenAiImageContentPart;

type OpenAiChatMessage = {
    role: OpenAiChatRole;
    content: string | OpenAiContentPart[];
};

type OpenAiCompatibleGenerationConfig = {
    temperature?: number;
    topP?: number;
    systemInstruction?: string;
    responseMimeType?: string;
    openAiReasoningEffort?: 'low' | 'medium' | 'high';
    openAiReasoningSplit?: boolean;
};

type OpenAiUsagePayload = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
};

type OpenAiChoiceMessage = {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    reasoning_details?: unknown;
};

type OpenAiResponsePayload = {
    choices?: Array<{
        text?: unknown;
        message?: OpenAiChoiceMessage;
    }>;
    usage?: OpenAiUsagePayload;
    error?: {
        message?: string;
    };
};

type AnthropicTextContentPart = {
    type: 'text';
    text: string;
};

type AnthropicImageContentPart = {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
};

type AnthropicContentPart = AnthropicTextContentPart | AnthropicImageContentPart;

type AnthropicMessage = {
    role: 'user' | 'assistant';
    content: string | AnthropicContentPart[];
};

type AnthropicUsagePayload = {
    input_tokens?: number;
    output_tokens?: number;
};

type AnthropicResponsePayload = {
    content?: Array<{
        type?: string;
        text?: string;
    }>;
    usage?: AnthropicUsagePayload;
    error?: {
        message?: string;
    };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const readProviderErrorMessage = (payload: unknown): string | null => {
    if (!isRecord(payload)) {
        return null;
    }

    const error = payload.error;
    if (typeof error === 'string' && error.trim()) {
        return error.trim();
    }

    if (isRecord(error) && typeof error.message === 'string' && error.message.trim()) {
        return error.message.trim();
    }

    if (typeof payload.message === 'string' && payload.message.trim()) {
        return payload.message.trim();
    }

    return null;
};

const mergeUniqueStrings = (existing: unknown, incoming: unknown): string[] | undefined => {
    const existingValues = Array.isArray(existing) ? existing.filter((value): value is string => typeof value === 'string') : [];
    const incomingValues = Array.isArray(incoming) ? incoming.filter((value): value is string => typeof value === 'string') : [];
    if (existingValues.length === 0 && incomingValues.length === 0) {
        return undefined;
    }

    return Array.from(new Set([...existingValues, ...incomingValues]));
};

const mergeUniqueItems = <T,>(
    existing: unknown,
    incoming: unknown,
    getKey: (item: T) => string,
): T[] | undefined => {
    const existingValues = Array.isArray(existing) ? existing.filter((value): value is T => value !== null && value !== undefined) : [];
    const incomingValues = Array.isArray(incoming) ? incoming.filter((value): value is T => value !== null && value !== undefined) : [];
    if (existingValues.length === 0 && incomingValues.length === 0) {
        return undefined;
    }

    const merged = new Map<string, T>();
    for (const item of [...existingValues, ...incomingValues]) {
        merged.set(getKey(item), item);
    }

    return Array.from(merged.values());
};

const mergeGroundingMetadata = (
    existing: MetadataWithCitations | null,
    incoming: unknown,
): MetadataWithCitations | null => {
    if (!isRecord(incoming)) {
        return existing;
    }

    const merged: MetadataWithCitations = existing ? { ...existing } : {};

    for (const [key, value] of Object.entries(incoming)) {
        switch (key) {
            case 'webSearchQueries':
            case 'imageSearchQueries': {
                const mergedStrings = mergeUniqueStrings(merged[key], value);
                if (mergedStrings) {
                    merged[key] = mergedStrings;
                }
                break;
            }
            case 'groundingChunks':
            case 'groundingSupports': {
                const mergedItems = mergeUniqueItems<Record<string, unknown>>(
                    merged[key],
                    value,
                    (item) => JSON.stringify(item),
                );
                if (mergedItems) {
                    merged[key] = mergedItems;
                }
                break;
            }
            case 'citations': {
                const mergedCitations = mergeUniqueItems<Record<string, unknown>>(
                    merged.citations,
                    value,
                    (item) => {
                        const uri = typeof item.uri === 'string' ? item.uri : '';
                        return uri || JSON.stringify(item);
                    },
                ) as Array<{ uri?: string }> | undefined;
                if (mergedCitations) {
                    merged.citations = mergedCitations;
                }
                break;
            }
            default: {
                if (isRecord(value) && isRecord(merged[key])) {
                    merged[key] = { ...(merged[key] as Record<string, unknown>), ...value };
                } else {
                    merged[key] = value;
                }
            }
        }
    }

    return merged;
};

const mergeFunctionCallUrlContextMetadata = (
    finalMetadata: { citations?: Array<{ uri?: string }> },
    functionCalls?: FunctionCall[]
) => {
    if (!functionCalls?.length) return;

    for (const functionCall of functionCalls) {
        const urlContextMetadata = functionCall.args?.urlContextMetadata;
        if (!urlContextMetadata || typeof urlContextMetadata !== 'object') continue;

        const citations = Array.isArray((urlContextMetadata as { citations?: unknown[] }).citations)
            ? ((urlContextMetadata as { citations?: Array<{ uri?: string }> }).citations ?? [])
            : [];

        if (citations.length === 0) continue;

        if (!finalMetadata.citations) {
            finalMetadata.citations = [];
        }

        for (const citation of citations) {
            if (!finalMetadata.citations.some(existing => existing.uri === citation.uri)) {
                finalMetadata.citations.push(citation);
            }
        }
    }
};

/**
 * Shared helper to parse GenAI responses.
 * Extracts parts, separates thoughts, and merges metadata/citations from tool calls.
 */
const processResponse = (response: GenerateContentResponse) => {
    let thoughtsText = "";
    const responseParts: Part[] = [];

    if (response.candidates && response.candidates[0]?.content?.parts) {
        for (const part of response.candidates[0].content.parts) {
            const pAsThoughtSupporting = part as ThoughtSupportingPart;
            if (pAsThoughtSupporting.thought) {
                thoughtsText += part.text;
            } else if (typeof part.text === 'string') {
                const { content, thoughts } = extractGemmaThoughtChannel(part.text);
                if (thoughts) {
                    thoughtsText += thoughts;
                }
                if (content) {
                    responseParts.push({ ...part, text: content });
                }
            } else {
                responseParts.push(part);
            }
        }
    }

    if (responseParts.length === 0 && response.text) {
        const { content, thoughts } = extractGemmaThoughtChannel(response.text);
        if (thoughts) {
            thoughtsText += thoughts;
        }
        if (content) {
            responseParts.push({ text: content });
        }
    }
    
    const candidate = response.candidates?.[0];
    const groundingMetadata = candidate?.groundingMetadata;
    const finalMetadata: MetadataWithCitations = groundingMetadata && typeof groundingMetadata === 'object'
        ? { ...(groundingMetadata as Record<string, unknown>) }
        : {};
    
    const urlContextCandidate = candidate as CandidateWithUrlContext | undefined;
    const urlContextMetadata = urlContextCandidate?.urlContextMetadata || urlContextCandidate?.url_context_metadata;

    mergeFunctionCallUrlContextMetadata(finalMetadata, response.functionCalls);

    return {
        parts: responseParts,
        thoughts: thoughtsText || undefined,
        usage: response.usageMetadata,
        grounding: Object.keys(finalMetadata).length > 0 ? finalMetadata : undefined,
        urlContext: urlContextMetadata
    };
};

const withAbortSignal = <T extends object>(
    config: T | undefined,
    abortSignal: AbortSignal,
): T & { abortSignal: AbortSignal } => ({
    ...(config || {} as T),
    abortSignal,
});

const isImageMimeType = (mimeType: string | undefined): boolean =>
    typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/');

const appendTextPart = (contentParts: OpenAiContentPart[], text: string): void => {
    if (!text) return;
    contentParts.push({ type: 'text', text });
};

const partToOpenAiContentParts = (part: Part): OpenAiContentPart[] => {
    const contentParts: OpenAiContentPart[] = [];

    if (typeof part.text === 'string' && part.text.length > 0) {
        appendTextPart(contentParts, part.text);
    }

    const inlineData = (part as Part & { inlineData?: { mimeType?: string; data?: string } }).inlineData;
    if (inlineData?.data) {
        if (isImageMimeType(inlineData.mimeType)) {
            contentParts.push({
                type: 'image_url',
                image_url: {
                    url: `data:${inlineData.mimeType};base64,${inlineData.data}`,
                },
            });
        } else {
            appendTextPart(
                contentParts,
                `[Attachment omitted: ${inlineData.mimeType || 'unknown inline data'} is not supported by OpenAI-compatible Chat Completions.]`,
            );
        }
    }

    const fileData = (part as Part & { fileData?: { mimeType?: string; fileUri?: string } }).fileData;
    if (fileData?.fileUri) {
        const fileUri = fileData.fileUri;
        if (isImageMimeType(fileData.mimeType) && /^(https?:|data:)/i.test(fileUri)) {
            contentParts.push({
                type: 'image_url',
                image_url: { url: fileUri },
            });
        } else {
            appendTextPart(
                contentParts,
                `[Attachment omitted: ${fileData.mimeType || 'external file'} at ${fileUri} requires Gemini Files/URL context and is not directly readable by OpenAI-compatible chat APIs.]`,
            );
        }
    }

    if ((part as Part & { executableCode?: unknown }).executableCode) {
        appendTextPart(contentParts, '[Previous executable code part omitted for OpenAI-compatible chat.]');
    }

    if ((part as Part & { codeExecutionResult?: { output?: string } }).codeExecutionResult) {
        const output = (part as Part & { codeExecutionResult?: { output?: string } }).codeExecutionResult?.output;
        appendTextPart(contentParts, output ? `[Previous code execution output]\n${output}` : '[Previous code execution result omitted.]');
    }

    return contentParts;
};

const partsToOpenAiContent = (parts: Part[]): OpenAiChatMessage['content'] => {
    const contentParts = parts.flatMap(partToOpenAiContentParts);

    if (contentParts.length === 0) {
        return '';
    }

    if (contentParts.length === 1 && contentParts[0].type === 'text') {
        return contentParts[0].text;
    }

    return contentParts;
};

const toOpenAiRole = (role: 'user' | 'model'): 'user' | 'assistant' =>
    role === 'model' ? 'assistant' : 'user';

const buildOpenAiMessages = (
    history: ChatHistoryItem[],
    role: 'user' | 'model',
    parts: Part[],
    config: unknown,
): OpenAiChatMessage[] => {
    const openAiConfig = (config || {}) as OpenAiCompatibleGenerationConfig;
    const messages: OpenAiChatMessage[] = [];

    if (openAiConfig.systemInstruction?.trim()) {
        messages.push({
            role: 'system',
            content: openAiConfig.systemInstruction.trim(),
        });
    }

    for (const item of history) {
        messages.push({
            role: toOpenAiRole(item.role),
            content: partsToOpenAiContent(item.parts),
        });
    }

    messages.push({
        role: toOpenAiRole(role),
        content: partsToOpenAiContent(parts),
    });

    return messages;
};

const partToAnthropicContentParts = (part: Part): AnthropicContentPart[] => {
    const contentParts: AnthropicContentPart[] = [];

    if (typeof part.text === 'string' && part.text.length > 0) {
        contentParts.push({ type: 'text', text: part.text });
    }

    const inlineData = (part as Part & { inlineData?: { mimeType?: string; data?: string } }).inlineData;
    if (inlineData?.data) {
        if (isImageMimeType(inlineData.mimeType)) {
            contentParts.push({
                type: 'image',
                source: {
                    type: 'base64',
                    media_type: inlineData.mimeType || 'image/png',
                    data: inlineData.data,
                },
            });
        } else {
            contentParts.push({
                type: 'text',
                text: `[Attachment omitted: ${inlineData.mimeType || 'unknown inline data'} is not supported by Anthropic-compatible Messages API.]`,
            });
        }
    }

    const fileData = (part as Part & { fileData?: { mimeType?: string; fileUri?: string } }).fileData;
    if (fileData?.fileUri) {
        contentParts.push({
            type: 'text',
            text: `[Attachment omitted: ${fileData.mimeType || 'external file'} at ${fileData.fileUri} requires Gemini Files/URL context and is not directly readable by Anthropic-compatible message APIs.]`,
        });
    }

    if ((part as Part & { executableCode?: unknown }).executableCode) {
        contentParts.push({ type: 'text', text: '[Previous executable code part omitted for Anthropic-compatible chat.]' });
    }

    if ((part as Part & { codeExecutionResult?: { output?: string } }).codeExecutionResult) {
        const output = (part as Part & { codeExecutionResult?: { output?: string } }).codeExecutionResult?.output;
        contentParts.push({
            type: 'text',
            text: output ? `[Previous code execution output]\n${output}` : '[Previous code execution result omitted.]',
        });
    }

    return contentParts;
};

const partsToAnthropicContent = (parts: Part[]): AnthropicMessage['content'] => {
    const contentParts = parts.flatMap(partToAnthropicContentParts);

    if (contentParts.length === 0) {
        return '';
    }

    if (contentParts.length === 1 && contentParts[0].type === 'text') {
        return contentParts[0].text;
    }

    return contentParts;
};

const buildAnthropicMessages = (
    history: ChatHistoryItem[],
    role: 'user' | 'model',
    parts: Part[],
): AnthropicMessage[] => {
    const messages: AnthropicMessage[] = [];

    for (const item of history) {
        messages.push({
            role: item.role === 'model' ? 'assistant' : 'user',
            content: partsToAnthropicContent(item.parts),
        });
    }

    messages.push({
        role: role === 'model' ? 'assistant' : 'user',
        content: partsToAnthropicContent(parts),
    });

    return messages;
};

const resolveOpenAiChatEndpoint = async (
    apiKey: string,
): Promise<{ headers: Headers; url: string }> => {
    const settings = await getEffectiveApiRequestSettings();
    const configuredProxyUrl = settings.useCustomApiConfig && settings.useApiProxy && settings.apiProxyUrl
        ? settings.apiProxyUrl
        : null;
    const siblingProxyUrl = configuredProxyUrl
        ? deriveSiblingProviderProxyUrl(configuredProxyUrl, 'openai')
        : null;
    const directOpenAiBaseUrl = settings.openAiApiBase?.trim() || DEFAULT_OPENAI_API_BASE_URL;
    const endpointUrl = buildOpenAiChatCompletionsRequestUrl(
        siblingProxyUrl || directOpenAiBaseUrl,
    );
    const headers = new Headers({
        'content-type': 'application/json',
    });

    if (apiKey !== SERVER_MANAGED_API_KEY) {
        headers.set('authorization', `Bearer ${apiKey}`);
    }

    if (siblingProxyUrl) {
        return { headers, url: endpointUrl };
    }

    if (apiKey === SERVER_MANAGED_API_KEY) {
        throw new Error('OpenAI-compatible chat models require the server-managed API proxy. Configure `apiProxyUrl` to point at the workspace API.');
    }

    return { headers, url: endpointUrl };
};

const resolveAnthropicMessagesEndpoint = async (
    apiKey: string,
): Promise<{ headers: Headers; url: string }> => {
    const settings = await getEffectiveApiRequestSettings();
    const configuredProxyUrl = settings.useCustomApiConfig && settings.useApiProxy && settings.apiProxyUrl
        ? settings.apiProxyUrl
        : null;
    const siblingProxyUrl = configuredProxyUrl
        ? deriveSiblingProviderProxyUrl(configuredProxyUrl, 'anthropic')
        : null;
    const directAnthropicBaseUrl = settings.anthropicApiBase?.trim() || DEFAULT_ANTHROPIC_API_BASE_URL;
    const endpointUrl = buildAnthropicMessagesRequestUrl(
        siblingProxyUrl || directAnthropicBaseUrl,
    );
    const headers = new Headers({
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
    });

    if (apiKey !== SERVER_MANAGED_API_KEY) {
        headers.set('x-api-key', apiKey);
    }

    if (siblingProxyUrl) {
        return { headers, url: endpointUrl };
    }

    if (apiKey === SERVER_MANAGED_API_KEY) {
        throw new Error('Anthropic-compatible chat models require the server-managed API proxy. Configure `apiProxyUrl` to point at the workspace API.');
    }

    return { headers, url: endpointUrl };
};

const mapOpenAiUsageMetadata = (usage?: OpenAiUsagePayload): UsageMetadata | undefined => {
    if (!usage) return undefined;

    const promptTokenCount = usage.prompt_tokens ?? usage.input_tokens ?? 0;
    const candidatesTokenCount = usage.completion_tokens ?? usage.output_tokens ?? 0;
    const totalTokenCount = usage.total_tokens || promptTokenCount + candidatesTokenCount;

    return {
        promptTokenCount,
        candidatesTokenCount,
        totalTokenCount,
    } as UsageMetadata;
};

const mapAnthropicUsageMetadata = (usage?: AnthropicUsagePayload): UsageMetadata | undefined => {
    if (!usage) return undefined;

    const promptTokenCount = usage.input_tokens ?? 0;
    const candidatesTokenCount = usage.output_tokens ?? 0;

    return {
        promptTokenCount,
        candidatesTokenCount,
        totalTokenCount: promptTokenCount + candidatesTokenCount,
    } as UsageMetadata;
};

const buildOpenAiChatRequestBody = (
    modelId: string,
    messages: OpenAiChatMessage[],
    config: unknown,
    stream: boolean,
): Record<string, unknown> => {
    const openAiConfig = (config || {}) as OpenAiCompatibleGenerationConfig;
    const body: Record<string, unknown> = {
        model: stripModelProviderPrefix(modelId),
        messages,
        stream,
    };

    if (typeof openAiConfig.temperature === 'number') {
        body.temperature = openAiConfig.temperature;
    }

    if (typeof openAiConfig.topP === 'number') {
        body.top_p = openAiConfig.topP;
    }

    if (openAiConfig.responseMimeType === 'application/json') {
        body.response_format = { type: 'json_object' };
    }

    if (openAiConfig.openAiReasoningEffort) {
        body.reasoning_effort = openAiConfig.openAiReasoningEffort;
    }

    if (openAiConfig.openAiReasoningSplit) {
        body.reasoning_split = true;
    }

    return body;
};

const buildAnthropicMessagesRequestBody = (
    modelId: string,
    messages: AnthropicMessage[],
    config: unknown,
    stream: boolean,
): Record<string, unknown> => {
    const anthropicConfig = (config || {}) as OpenAiCompatibleGenerationConfig;
    const body: Record<string, unknown> = {
        model: stripModelProviderPrefix(modelId),
        messages,
        max_tokens: 4096,
        stream,
    };

    if (anthropicConfig.systemInstruction?.trim()) {
        body.system = anthropicConfig.systemInstruction.trim();
    }

    if (typeof anthropicConfig.temperature === 'number') {
        body.temperature = anthropicConfig.temperature;
    }

    if (typeof anthropicConfig.topP === 'number') {
        body.top_p = anthropicConfig.topP;
    }

    return body;
};

const getOpenAiErrorMessage = async (response: Response): Promise<string> => {
    try {
        const payload = await response.json() as OpenAiResponsePayload;
        const providerErrorMessage = readProviderErrorMessage(payload);
        if (providerErrorMessage) {
            return providerErrorMessage;
        }
    } catch {
        // Fall back to plain text response handling below.
    }

    try {
        const fallbackText = await response.text();
        if (fallbackText.trim()) {
            return fallbackText.trim();
        }
    } catch {
        // Ignore response body parse failures and fall through to the status text.
    }

    return response.statusText || `Request failed with status ${response.status}`;
};

const getAnthropicErrorMessage = async (response: Response): Promise<string> => {
    try {
        const payload = await response.json() as AnthropicResponsePayload;
        const providerErrorMessage = readProviderErrorMessage(payload);
        if (providerErrorMessage) {
            return providerErrorMessage;
        }
    } catch {
        // Fall back to plain text response handling below.
    }

    try {
        const fallbackText = await response.text();
        if (fallbackText.trim()) {
            return fallbackText.trim();
        }
    } catch {
        // Ignore response body parse failures and fall through to the status text.
    }

    return response.statusText || `Request failed with status ${response.status}`;
};

const extractOpenAiText = (content: unknown): string => {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content.map(extractOpenAiText).join('');
    }

    if (isRecord(content)) {
        const fields = [
            content.text,
            content.output_text,
            content.summary,
            content.reasoning_content,
            content.reasoning,
            content.content,
            content.delta,
        ];

        for (const field of fields) {
            const text = extractOpenAiText(field);
            if (text) {
                return text;
            }
        }
    }

    return '';
};

const extractFirstOpenAiText = (...contents: unknown[]): string => {
    for (const content of contents) {
        const text = extractOpenAiText(content);
        if (text) {
            return text;
        }
    }

    return '';
};

const sendOpenAiCompatibleMessageNonStream = async (
    apiKey: string,
    modelId: string,
    history: ChatHistoryItem[],
    parts: Part[],
    config: unknown,
    abortSignal: AbortSignal,
    onError: (error: Error) => void,
    onComplete: NonStreamMessageCompleteHandler,
): Promise<void> => {
    try {
        const { headers, url } = await resolveOpenAiChatEndpoint(apiKey);
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildOpenAiChatRequestBody(
                modelId,
                buildOpenAiMessages(history, 'user', parts, config),
                config,
                false,
            )),
            signal: abortSignal,
        });

        if (abortSignal.aborted) {
            onComplete([], '', undefined, undefined, undefined);
            return;
        }

        if (!response.ok) {
            throw new Error(await getOpenAiErrorMessage(response));
        }

        const payload = await response.json() as OpenAiResponsePayload;
        const message = payload.choices?.[0]?.message;
        const text = extractOpenAiText(message?.content ?? payload.choices?.[0]?.text);
        const thoughts = extractFirstOpenAiText(
            message?.reasoning_content,
            message?.reasoning,
            message?.reasoning_details,
        ) || undefined;
        const responseParts = text ? [{ text }] : [];

        onComplete(responseParts, thoughts, mapOpenAiUsageMetadata(payload.usage), undefined, undefined);
    } catch (error) {
        logService.error(`Error in OpenAI-compatible non-stream for ${modelId}:`, error);
        onError(error instanceof Error ? error : new Error(String(error) || 'Unknown OpenAI-compatible chat error.'));
    }
};

const sendOpenAiCompatibleMessageStream = async (
    apiKey: string,
    modelId: string,
    history: ChatHistoryItem[],
    parts: Part[],
    config: unknown,
    abortSignal: AbortSignal,
    onPart: (part: Part) => void,
    onThoughtChunk: (chunk: string) => void,
    onError: (error: Error) => void,
    onComplete: (usageMetadata?: UsageMetadata, groundingMetadata?: unknown, urlContextMetadata?: unknown) => void,
    role: 'user' | 'model',
): Promise<void> => {
    let finalUsageMetadata: UsageMetadata | undefined;

    try {
        const { headers, url } = await resolveOpenAiChatEndpoint(apiKey);
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildOpenAiChatRequestBody(
                modelId,
                buildOpenAiMessages(history, role, parts, config),
                config,
                true,
            )),
            signal: abortSignal,
        });

        if (!response.ok) {
            throw new Error(await getOpenAiErrorMessage(response));
        }

        if (!response.body) {
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let isDone = false;

        while (!isDone) {
            const { done, value } = await reader.read();
            if (done) break;
            if (abortSignal.aborted) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) continue;

                const data = line.slice('data:'.length).trim();
                if (!data) continue;
                if (data === '[DONE]') {
                    isDone = true;
                    break;
                }

                let payload: OpenAiResponsePayload & {
                    choices?: Array<{
                        text?: unknown;
                        delta?: OpenAiChoiceMessage;
                    }>;
                };
                try {
                    payload = JSON.parse(data) as typeof payload;
                } catch (error) {
                    logService.warn('Skipping malformed OpenAI-compatible stream chunk.', { error, data });
                    continue;
                }

                if (payload.usage) {
                    finalUsageMetadata = mapOpenAiUsageMetadata(payload.usage);
                }

                const choice = payload.choices?.[0];
                const text = extractOpenAiText(choice?.delta?.content ?? choice?.text);
                const thoughts = extractFirstOpenAiText(
                    choice?.delta?.reasoning_content,
                    choice?.delta?.reasoning,
                    choice?.delta?.reasoning_details,
                );

                if (thoughts) {
                    onThoughtChunk(thoughts);
                }
                if (text) {
                    onPart({ text });
                }
            }
        }
    } catch (error) {
        logService.error(`Error in OpenAI-compatible stream for ${modelId}:`, error);
        onError(error instanceof Error ? error : new Error(String(error) || 'Unknown OpenAI-compatible streaming error.'));
    } finally {
        onComplete(finalUsageMetadata, undefined, undefined);
    }
};

const sendAnthropicCompatibleMessageNonStream = async (
    apiKey: string,
    modelId: string,
    history: ChatHistoryItem[],
    parts: Part[],
    config: unknown,
    abortSignal: AbortSignal,
    onError: (error: Error) => void,
    onComplete: NonStreamMessageCompleteHandler,
): Promise<void> => {
    try {
        const { headers, url } = await resolveAnthropicMessagesEndpoint(apiKey);
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildAnthropicMessagesRequestBody(
                modelId,
                buildAnthropicMessages(history, 'user', parts),
                config,
                false,
            )),
            signal: abortSignal,
        });

        if (abortSignal.aborted) {
            onComplete([], '', undefined, undefined, undefined);
            return;
        }

        if (!response.ok) {
            throw new Error(await getAnthropicErrorMessage(response));
        }

        const payload = await response.json() as AnthropicResponsePayload;
        const text = (payload.content ?? [])
            .filter((item) => item.type === 'text' && typeof item.text === 'string')
            .map((item) => item.text)
            .join('');

        onComplete(text ? [{ text }] : [], undefined, mapAnthropicUsageMetadata(payload.usage), undefined, undefined);
    } catch (error) {
        logService.error(`Error in Anthropic-compatible non-stream for ${modelId}:`, error);
        onError(error instanceof Error ? error : new Error(String(error) || 'Unknown Anthropic-compatible chat error.'));
    }
};

const sendAnthropicCompatibleMessageStream = async (
    apiKey: string,
    modelId: string,
    history: ChatHistoryItem[],
    parts: Part[],
    config: unknown,
    abortSignal: AbortSignal,
    onPart: (part: Part) => void,
    onError: (error: Error) => void,
    onComplete: (usageMetadata?: UsageMetadata, groundingMetadata?: unknown, urlContextMetadata?: unknown) => void,
    role: 'user' | 'model',
): Promise<void> => {
    let finalUsageMetadata: UsageMetadata | undefined;

    try {
        const { headers, url } = await resolveAnthropicMessagesEndpoint(apiKey);
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(buildAnthropicMessagesRequestBody(
                modelId,
                buildAnthropicMessages(history, role, parts),
                config,
                true,
            )),
            signal: abortSignal,
        });

        if (!response.ok) {
            throw new Error(await getAnthropicErrorMessage(response));
        }

        if (!response.body) {
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let isDone = false;

        while (!isDone) {
            const { done, value } = await reader.read();
            if (done) break;
            if (abortSignal.aborted) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';

            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line.startsWith('data:')) continue;

                const data = line.slice('data:'.length).trim();
                if (!data) continue;
                if (data === '[DONE]') {
                    isDone = true;
                    break;
                }

                let payload: {
                    type?: string;
                    delta?: {
                        type?: string;
                        text?: string;
                    };
                    usage?: AnthropicUsagePayload;
                    message?: {
                        usage?: AnthropicUsagePayload;
                    };
                    error?: {
                        message?: string;
                    };
                };
                try {
                    payload = JSON.parse(data) as typeof payload;
                } catch (error) {
                    logService.warn('Skipping malformed Anthropic-compatible stream chunk.', { error, data });
                    continue;
                }

                if (payload.type === 'error') {
                    throw new Error(payload.error?.message || 'Anthropic-compatible stream returned an error.');
                }

                if (payload.message?.usage) {
                    finalUsageMetadata = mapAnthropicUsageMetadata(payload.message.usage);
                }

                if (payload.usage) {
                    finalUsageMetadata = mapAnthropicUsageMetadata(payload.usage);
                }

                if (
                    payload.type === 'content_block_delta'
                    && payload.delta?.type === 'text_delta'
                    && payload.delta.text
                ) {
                    onPart({ text: payload.delta.text });
                }
            }
        }
    } catch (error) {
        logService.error(`Error in Anthropic-compatible stream for ${modelId}:`, error);
        onError(error instanceof Error ? error : new Error(String(error) || 'Unknown Anthropic-compatible streaming error.'));
    } finally {
        onComplete(finalUsageMetadata, undefined, undefined);
    }
};

export const generateContentTurnApi = async (
    apiKey: string,
    modelId: string,
    contents: ChatHistoryItem[],
    config: unknown,
    abortSignal: AbortSignal,
) => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    if (abortSignal.aborted) {
        throw abortError;
    }

    if (isOpenAiCompatibleChatModel(modelId) || isAnthropicCompatibleChatModel(modelId)) {
        throw new Error('OpenAI/Anthropic-compatible chat models do not support Gemini tool-loop requests yet. Disable Gemini/server-side tools or choose a Gemini model for tool calls.');
    }

    const ai = await getConfiguredApiClient(apiKey, getHttpOptionsForContents(contents));
    const response = await ai.models.generateContent({
        model: modelId,
        contents,
        config: withAbortSignal(
            config as Parameters<typeof ai.models.generateContent>[0]['config'],
            abortSignal,
        ),
    });

    if (abortSignal.aborted) {
        throw abortError;
    }

    const { parts, thoughts, usage, grounding, urlContext } = processResponse(response);
    const candidateContent = response.candidates?.[0]?.content;

    return {
        modelContent: {
            role: 'model' as const,
            parts: candidateContent?.parts ?? parts,
        },
        parts,
        thoughts,
        usage,
        grounding,
        urlContext,
        functionCalls: response.functionCalls ?? [],
    };
};

export const sendStatelessMessageStreamApi: StreamMessageSender = async (
    apiKey,
    modelId,
    history,
    parts,
    config,
    abortSignal,
    onPart,
    onThoughtChunk,
    onError,
    onComplete,
    role = 'user'
) => {
    if (isAnthropicCompatibleChatModel(modelId)) {
        logService.info(`Sending message via Anthropic-compatible Messages stream for ${modelId} (Role: ${role})`);
        await sendAnthropicCompatibleMessageStream(
            apiKey,
            modelId,
            history,
            parts,
            config,
            abortSignal,
            onPart,
            onError,
            onComplete,
            role,
        );
        return;
    }

    if (isOpenAiCompatibleChatModel(modelId)) {
        logService.info(`Sending message via OpenAI-compatible Chat Completions stream for ${modelId} (Role: ${role})`);
        await sendOpenAiCompatibleMessageStream(
            apiKey,
            modelId,
            history,
            parts,
            config,
            abortSignal,
            onPart,
            onThoughtChunk,
            onError,
            onComplete,
            role,
        );
        return;
    }

    logService.info(`Sending message via stateless generateContentStream for ${modelId} (Role: ${role})`);
    let finalUsageMetadata: UsageMetadata | undefined = undefined;
    let finalGroundingMetadata: MetadataWithCitations | null = null;
    let finalUrlContextMetadata: unknown = null;
    const contents = [...history, { role: role, parts }];

    try {
        const ai = await getConfiguredApiClient(apiKey, getHttpOptionsForContents(contents));
        
        if (abortSignal.aborted) {
            logService.warn("Streaming aborted by signal before start.");
            return;
        }

        const result = await ai.models.generateContentStream({
            model: modelId,
            contents,
            config: withAbortSignal(
                config as Parameters<typeof ai.models.generateContentStream>[0]['config'],
                abortSignal,
            ),
        });

        for await (const chunkResponse of result) {
            if (abortSignal.aborted) {
                logService.warn("Streaming aborted by signal.");
                break;
            }
            if (chunkResponse.usageMetadata) {
                finalUsageMetadata = chunkResponse.usageMetadata;
            }
            const candidate = chunkResponse.candidates?.[0];
            
            if (candidate) {
                const metadataFromChunk = candidate.groundingMetadata;
                finalGroundingMetadata = mergeGroundingMetadata(finalGroundingMetadata, metadataFromChunk);
                
                const urlContextCandidate = candidate as CandidateWithUrlContext;
                const urlMetadata = urlContextCandidate.urlContextMetadata || urlContextCandidate.url_context_metadata;
                if (urlMetadata) {
                    finalUrlContextMetadata = urlMetadata;
                }

                if (chunkResponse.functionCalls?.length) {
                    if (!finalGroundingMetadata) finalGroundingMetadata = {};
                    mergeFunctionCallUrlContextMetadata(finalGroundingMetadata, chunkResponse.functionCalls);
                }
                
                if (candidate.content?.parts?.length) {
                    for (const part of candidate.content.parts) {
                        const pAsThoughtSupporting = part as ThoughtSupportingPart;

                        if (pAsThoughtSupporting.thought) {
                            onThoughtChunk(part.text || '');
                        } else if (typeof part.text === 'string') {
                            const { content, thoughts } = extractGemmaThoughtChannel(part.text);
                            if (thoughts) {
                                onThoughtChunk(thoughts);
                            }
                            if (content) {
                                onPart({ ...part, text: content });
                            }
                        } else {
                            onPart(part);
                        }
                    }
                }
            }
        }
    } catch (error) {
        logService.error("Error sending message (stream):", error);
        onError(error instanceof Error ? error : new Error(String(error) || "Unknown error during streaming."));
    } finally {
        logService.info("Streaming complete.", { usage: finalUsageMetadata, hasGrounding: !!finalGroundingMetadata });
        onComplete(finalUsageMetadata, finalGroundingMetadata, finalUrlContextMetadata);
    }
};

export const sendStatelessMessageNonStreamApi: NonStreamMessageSender = async (
    apiKey,
    modelId,
    history,
    parts,
    config,
    abortSignal,
    onError,
    onComplete
) => {
    if (isAnthropicCompatibleChatModel(modelId)) {
        logService.info(`Sending message via Anthropic-compatible Messages for ${modelId}`);
        await sendAnthropicCompatibleMessageNonStream(
            apiKey,
            modelId,
            history,
            parts,
            config,
            abortSignal,
            onError,
            onComplete,
        );
        return;
    }

    if (isOpenAiCompatibleChatModel(modelId)) {
        logService.info(`Sending message via OpenAI-compatible Chat Completions for ${modelId}`);
        await sendOpenAiCompatibleMessageNonStream(
            apiKey,
            modelId,
            history,
            parts,
            config,
            abortSignal,
            onError,
            onComplete,
        );
        return;
    }

    logService.info(`Sending message via stateless generateContent (non-stream) for model ${modelId}`);
    const contents = [...history, { role: 'user', parts }];
    
    try {
        const ai = await getConfiguredApiClient(apiKey, getHttpOptionsForContents(contents));

        if (abortSignal.aborted) { onComplete([], "", undefined, undefined, undefined); return; }

        const response = await ai.models.generateContent({
            model: modelId,
            contents,
            config: withAbortSignal(
                config as Parameters<typeof ai.models.generateContent>[0]['config'],
                abortSignal,
            ),
        });

        if (abortSignal.aborted) { onComplete([], "", undefined, undefined, undefined); return; }

        const { parts: responseParts, thoughts, usage, grounding, urlContext } = processResponse(response);

        logService.info(`Stateless non-stream complete for ${modelId}.`, { usage, hasGrounding: !!grounding, hasUrlContext: !!urlContext });
        onComplete(responseParts, thoughts, usage, grounding, urlContext);
    } catch (error) {
        logService.error(`Error in stateless non-stream for ${modelId}:`, error);
        onError(error instanceof Error ? error : new Error(String(error) || "Unknown error during stateless non-streaming call."));
    }
};
