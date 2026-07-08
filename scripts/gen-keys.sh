#!/usr/bin/env bash
# Генерирует JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY для .env
# Использование: bash scripts/gen-keys.sh

set -euo pipefail

JWT_SECRET=$(openssl rand -base64 64 | tr -d '\n')
POSTGRES_PASSWORD=$(openssl rand -base64 32 | tr -d '\n')
REALTIME_ENC_KEY=$(openssl rand -base64 32 | tr -d '\n')
REALTIME_SECRET_KEY_BASE=$(openssl rand -base64 64 | tr -d '\n')

# Генерация JWT токена (минимальный bash-based без внешних зависимостей)
# Использует python3 если есть, иначе выводит инструкцию
gen_jwt() {
  local role=$1
  local exp=$2

  if command -v python3 &>/dev/null; then
    python3 - <<PYEOF
import json, base64, hmac, hashlib, time

def b64url(data):
    if isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

header = b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(',', ':')))
payload = b64url(json.dumps({
    "role": "$role",
    "iss": "supabase",
    "iat": int(time.time()),
    "exp": int(time.time()) + $exp
}, separators=(',', ':')))

msg = f"{header}.{payload}".encode()
sig = hmac.new("${JWT_SECRET}".encode(), msg, hashlib.sha256).digest()
print(f"{header}.{payload}.{b64url(sig)}")
PYEOF
  else
    echo "УСТАНОВИ python3 для генерации JWT, или используй https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys"
  fi
}

echo "======================================"
echo "  Вставь эти значения в .env"
echo "======================================"
echo ""
echo "JWT_SECRET=${JWT_SECRET}"
echo ""
echo "POSTGRES_PASSWORD=${POSTGRES_PASSWORD}"
echo ""
echo "REALTIME_ENC_KEY=${REALTIME_ENC_KEY}"
echo ""
echo "REALTIME_SECRET_KEY_BASE=${REALTIME_SECRET_KEY_BASE}"
echo ""
echo "# ANON_KEY (role=anon, exp=100 лет):"
ANON=$(gen_jwt "anon" 3153600000)
echo "ANON_KEY=${ANON}"
echo ""
echo "# SERVICE_ROLE_KEY (role=service_role, exp=100 лет):"
SVC=$(gen_jwt "service_role" 3153600000)
echo "SERVICE_ROLE_KEY=${SVC}"
echo ""
echo "======================================"
echo "  ВАЖНО: не добавляй .env в git!"
echo "======================================"
