# Secure OpenAI-compatible API

This is an **experimental security-review branch**, not a validated production deployment.

## Environment (Vercel server-side; do not use NEXT_PUBLIC_)

- `OAI_GATEWAY_ENABLED=1` enables the otherwise-disabled API
- `OPENAI_API_KEY` upstream OpenAI Platform key; secret
- `OAI_GATEWAY_KEYS` one or more comma-separated randomly generated independent 32+-character keys
- `OAI_GATEWAY_MODELS` comma-separated explicit model allowlist, e.g. `gpt-4.1-mini,gpt-image-1`
- `REDIS_URL` required Redis service; downtime denies access
- `OAI_GATEWAY_ALLOWED_ORIGINS` optional exact HTTPS Origin allowlist

Always keep keys in Vercel Production environment variables, never in Git, logs, browser bundles, or pull-request preview environments.
Generate different random secrets with `openssl rand -hex 32`.

## Routes

`GET /v1/models`, `POST /v1/chat/completions`, `POST /v1/responses`,
`POST /v1/images/generations`, `POST /v1/images/edits`.

OpenAI SDK: `base_url="https://your-domain.example/v1"`, `api_key="<GATEWAY_CLIENT_KEY>"`.

## Constraints

- Strict API-key auth and OpenAI model allowlist, no caller-controlled upstream URLs
- Fixed server-side upstream credential, no incoming credentials or headers forwarded
- Redis-based rate limits (10 RPM, 100/day/key, 300/day global, 20/day images)
- JSON max 384 KiB; multipart image edits max 3.5 MB
- Provider error bodies are never passed through; response cache disabled
- This branch intentionally disables gateway access until configured
- This addition does **not** modify the original Chatbot app's authentication and web billing; review those separately before going public
- No guarantee of zero vulnerability or zero secret exposure: run complete build, TypeScript check, dependency audit, integration tests and penetration testing
- Vercel location and a custom domain do not change OpenAI's supported-region restrictions.
