import { createHash, createHmac } from 'node:crypto';

export interface ObjectStorageEnvConfig {
  enabled?: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string | null;
  prefix?: string;
}

export interface ObjectStorageRuntimeSettings {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBaseUrl: string | null;
  prefix: string;
}

export interface ObjectStoragePersistedSettings {
  enabled?: boolean;
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
  publicBaseUrl?: string | null;
  prefix?: string;
}

export interface ObjectStorageSettingsSummary {
  enabled: boolean;
  configured: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeyPreview: string | null;
  secretKeyConfigured: boolean;
  secretKeyPreview: string | null;
  forcePathStyle: boolean;
  publicBaseUrl: string | null;
  prefix: string;
  source: 'admin' | 'environment' | 'none';
}

export interface ObjectStorageObject {
  body: Buffer;
  contentType: string;
  contentLength: number;
}

type HeaderMap = Record<string, string>;

const DEFAULT_REGION = 'auto';
const DEFAULT_PREFIX = 'arong-ai-workstation/cloud-chat';

function sha256Hex(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function hmacHex(key: Buffer | string, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

function getSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

function formatAmzDate(date = new Date()): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeS3Path(pathname: string): string {
  return pathname
    .split('/')
    .map((segment) => encodePathSegment(segment))
    .join('/')
    .replace(/%2F/g, '/');
}

function joinPath(...parts: string[]): string {
  const cleaned = parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.replace(/^\/+|\/+$/g, ''));
  return `/${cleaned.join('/')}`;
}

function normalizePrefix(prefix: string | undefined): string {
  const normalized = (prefix || DEFAULT_PREFIX).trim().replace(/^\/+|\/+$/g, '');
  return normalized || DEFAULT_PREFIX;
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return '';
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function chooseText(
  persistedValue: string | null | undefined,
  envValue: string | null | undefined,
  fallback = '',
): string {
  const persistedText = typeof persistedValue === 'string' ? persistedValue.trim() : '';
  if (persistedText) {
    return persistedText;
  }

  const envText = typeof envValue === 'string' ? envValue.trim() : '';
  return envText || fallback;
}

export function maskSecret(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value.length <= 8) {
    return `${value.slice(0, 2)}...${value.slice(-2)}`;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function mergeObjectStorageSettings(
  envConfig: ObjectStorageEnvConfig,
  persisted: ObjectStoragePersistedSettings | null,
): ObjectStorageRuntimeSettings {
  return {
    enabled: persisted?.enabled ?? envConfig.enabled ?? false,
    endpoint: normalizeEndpoint(chooseText(persisted?.endpoint, envConfig.endpoint)),
    region: chooseText(persisted?.region, envConfig.region, DEFAULT_REGION),
    bucket: chooseText(persisted?.bucket, envConfig.bucket),
    accessKeyId: chooseText(persisted?.accessKeyId, envConfig.accessKeyId),
    secretAccessKey: chooseText(persisted?.secretAccessKey, envConfig.secretAccessKey),
    forcePathStyle: persisted?.forcePathStyle ?? envConfig.forcePathStyle ?? true,
    publicBaseUrl: normalizeEndpoint(chooseText(persisted?.publicBaseUrl, envConfig.publicBaseUrl)) || null,
    prefix: normalizePrefix(chooseText(persisted?.prefix, envConfig.prefix, DEFAULT_PREFIX)),
  };
}

export function summarizeObjectStorageSettings(
  settings: ObjectStorageRuntimeSettings,
  source: ObjectStorageSettingsSummary['source'],
): ObjectStorageSettingsSummary {
  const configured = Boolean(
    settings.enabled
    && settings.endpoint
    && settings.bucket
    && settings.accessKeyId
    && settings.secretAccessKey,
  );

  return {
    enabled: settings.enabled,
    configured,
    endpoint: settings.endpoint,
    region: settings.region,
    bucket: settings.bucket,
    accessKeyId: settings.accessKeyId,
    accessKeyPreview: maskSecret(settings.accessKeyId),
    secretKeyConfigured: Boolean(settings.secretAccessKey),
    secretKeyPreview: maskSecret(settings.secretAccessKey),
    forcePathStyle: settings.forcePathStyle,
    publicBaseUrl: settings.publicBaseUrl,
    prefix: settings.prefix,
    source,
  };
}

export function isObjectStorageConfigured(settings: ObjectStorageRuntimeSettings): boolean {
  return summarizeObjectStorageSettings(settings, 'none').configured;
}

export class S3CompatibleObjectStorageClient {
  constructor(
    private readonly settings: ObjectStorageRuntimeSettings,
    private readonly fetchImpl: typeof fetch,
  ) {}

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    const response = await this.fetchImpl(this.buildObjectUrl(key), {
      method: 'PUT',
      headers: this.buildSignedHeaders('PUT', key, body, {
        'content-type': contentType || 'application/octet-stream',
        'content-length': String(body.length),
      }),
      body: body as unknown as BodyInit,
    });

    if (!response.ok) {
      throw new Error(`Object storage upload failed with HTTP ${response.status}: ${await response.text()}`);
    }
  }

  async getObject(key: string): Promise<ObjectStorageObject> {
    const emptyBody = Buffer.alloc(0);
    const response = await this.fetchImpl(this.buildObjectUrl(key), {
      method: 'GET',
      headers: this.buildSignedHeaders('GET', key, emptyBody),
    });

    if (!response.ok) {
      throw new Error(`Object storage download failed with HTTP ${response.status}: ${await response.text()}`);
    }

    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      contentType: response.headers.get('content-type') || 'application/octet-stream',
      contentLength: body.length,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const emptyBody = Buffer.alloc(0);
    const response = await this.fetchImpl(this.buildObjectUrl(key), {
      method: 'DELETE',
      headers: this.buildSignedHeaders('DELETE', key, emptyBody),
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`Object storage delete failed with HTTP ${response.status}: ${await response.text()}`);
    }
  }

  private buildObjectUrl(key: string): URL {
    const endpoint = new URL(this.settings.endpoint);
    const normalizedKey = key.replace(/^\/+/, '');

    if (this.settings.forcePathStyle) {
      endpoint.pathname = joinPath(endpoint.pathname, this.settings.bucket, normalizedKey);
      return endpoint;
    }

    endpoint.hostname = `${this.settings.bucket}.${endpoint.hostname}`;
    endpoint.pathname = joinPath(endpoint.pathname, normalizedKey);
    return endpoint;
  }

  private buildSignedHeaders(
    method: string,
    key: string,
    body: Buffer,
    extraHeaders: HeaderMap = {},
  ): HeaderMap {
    const url = this.buildObjectUrl(key);
    const payloadHash = sha256Hex(body);
    const amzDate = formatAmzDate();
    const dateStamp = amzDate.slice(0, 8);
    const baseHeaders: HeaderMap = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(
        Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), value.trim()]),
      ),
    };
    const sortedHeaderNames = Object.keys(baseHeaders).sort();
    const canonicalHeaders = sortedHeaderNames
      .map((name) => `${name}:${baseHeaders[name].replace(/\s+/g, ' ')}`)
      .join('\n');
    const signedHeaders = sortedHeaderNames.join(';');
    const canonicalRequest = [
      method.toUpperCase(),
      encodeS3Path(url.pathname || '/'),
      url.searchParams.toString(),
      `${canonicalHeaders}\n`,
      signedHeaders,
      payloadHash,
    ].join('\n');
    const credentialScope = `${dateStamp}/${this.settings.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join('\n');
    const signature = hmacHex(
      getSigningKey(this.settings.secretAccessKey, dateStamp, this.settings.region),
      stringToSign,
    );

    return {
      ...baseHeaders,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.settings.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
}
