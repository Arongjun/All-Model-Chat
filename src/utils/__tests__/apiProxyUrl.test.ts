import { describe, expect, it } from 'vitest';
import { normalizeGeminiApiBaseUrl, resolveApiBaseUrlForSdk } from '../apiProxyUrl';

describe('apiProxyUrl', () => {
  it('resolves relative Gemini proxy URLs to absolute URLs for the Google SDK', () => {
    const resolved = resolveApiBaseUrlForSdk('/api/gemini');

    expect(new URL(resolved).pathname).toBe('/api/gemini');
  });

  it('normalizes relative Gemini proxy URLs and strips API version suffixes', () => {
    const normalized = normalizeGeminiApiBaseUrl('/api/gemini/v1beta/');

    const parsed = new URL(normalized);
    expect(parsed.pathname).toBe('/api/gemini');
  });

  it('keeps absolute Gemini API bases absolute while stripping version suffixes', () => {
    expect(normalizeGeminiApiBaseUrl('https://proxy.example.com/gemini/v1beta/')).toBe(
      'https://proxy.example.com/gemini',
    );
  });
});
