#!/bin/sh
set -eu

to_bool() {
  normalized="$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')"

  case "$normalized" in
    1|true|yes|on)
      printf 'true'
      ;;
    0|false|no|off)
      printf 'false'
      ;;
    *)
      printf 'false'
      ;;
  esac
}

escape_js_single_quoted() {
  printf '%s' "$1" | sed "s/\\\\/\\\\\\\\/g; s/'/'\"'\"'/g"
}

server_managed_api="$(to_bool "${RUNTIME_SERVER_MANAGED_API:-true}")"
use_custom_api_config="$(to_bool "${RUNTIME_USE_CUSTOM_API_CONFIG:-true}")"
use_api_proxy="$(to_bool "${RUNTIME_USE_API_PROXY:-true}")"
api_proxy_url_escaped="$(escape_js_single_quoted "${RUNTIME_API_PROXY_URL:-/api/gemini}")"
openai_api_base_raw="${RUNTIME_OPENAI_API_BASE:-}"
anthropic_api_base_raw="${RUNTIME_ANTHROPIC_API_BASE:-}"
live_api_ephemeral_token_endpoint_escaped="$(escape_js_single_quoted "${RUNTIME_LIVE_API_EPHEMERAL_TOKEN_ENDPOINT:-/api/live-token}")"

if [ -n "$openai_api_base_raw" ]; then
  openai_api_base_value="'$(escape_js_single_quoted "$openai_api_base_raw")'"
else
  openai_api_base_value="null"
fi

if [ -n "$anthropic_api_base_raw" ]; then
  anthropic_api_base_value="'$(escape_js_single_quoted "$anthropic_api_base_raw")'"
else
  anthropic_api_base_value="null"
fi

cat > /usr/share/nginx/html/runtime-config.js <<EOF
window.__AMC_RUNTIME_CONFIG__ = {
  ...(window.__AMC_RUNTIME_CONFIG__ || {}),
  serverManagedApi: ${server_managed_api},
  useCustomApiConfig: ${use_custom_api_config},
  useApiProxy: ${use_api_proxy},
  apiProxyUrl: '${api_proxy_url_escaped}',
  openAiApiBase: ${openai_api_base_value},
  anthropicApiBase: ${anthropic_api_base_value},
  liveApiEphemeralTokenEndpoint: '${live_api_ephemeral_token_endpoint_escaped}',
};
EOF
