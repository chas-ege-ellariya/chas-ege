#!/bin/bash
# Общий движок вызова ассистента-ревьюера: кидает в Qwen-чат ссылку на пуллреквест.
#
# Использование (запускать из корня репозитория):
#   bash dev/lib/ask_to_review.sh <Имя> <префикс-профилей> <номер PR>
# например:
#   bash dev/lib/ask_to_review.sh Kira kira-auto 3677
#
# Профили Chromium ищутся в ../chas-ege-chromium-profiles/<префикс>-*,
# из них выбирается случайный. Логин и пароль берутся из credentials.json
# внутри папки профиля; если файла нет — полагаемся на сохранённую сессию.
#
# Тонкие обёртки над этим скриптом: dev/ask_Yuliya_to_review.sh, dev/ask_Kira_to_review.sh, ...
#
# Безбраузерный путь (необязательный, по умолчанию выключен):
#   bash dev/lib/ask_to_review.sh Kira kira-auto 3612 --api
#   CHAS_EGE_ASK_VIA_API=1 bash dev/ask_Kira_to_review.sh 3612
# Сколько секунд читать поток ответа: CHAS_EGE_API_WAIT (по умолчанию 30).
# Запретить откат на браузер при неудаче API: CHAS_EGE_ASK_API_STRICT=1.

if [ $# -lt 3 ] || [ -z "$3" ]; then
    echo "Usage: bash dev/lib/ask_to_review.sh <Name> <profile-prefix> <PR number>" >&2
    exit 1
fi

NAME="$1"
PROFILE_PREFIX="$2"
PR_NUMBER="$3"

echo "Asking $NAME to review PR#$PR_NUMBER ..."

PROFILE_DIR="../chas-ege-chromium-profiles"

# Выбираем случайный профиль из существующих папок <префикс>-*
profile=$(ls "$PROFILE_DIR" 2>/dev/null | grep "^${PROFILE_PREFIX}-" | shuf -n 1)

if [ -z "$profile" ]; then
    echo "ERROR: No ${PROFILE_PREFIX}-* profiles found in $PROFILE_DIR"
    exit 1
fi

echo "Using profile: $profile"

# Путь к профилю
PROFILE_PATH="$PROFILE_DIR/$profile"

# Читаем credentials из файла в папке профиля (если существует)
CREDENTIALS_FILE="$PROFILE_PATH/credentials.json"
QWEN_LOGIN=""
JQ_PASSWORD=""
if [ -f "$CREDENTIALS_FILE" ]; then
    QWEN_LOGIN=$(jq -r '.login // empty' "$CREDENTIALS_FILE")
    JQ_PASSWORD=$(jq -r '.password // empty' "$CREDENTIALS_FILE")
else
    echo "WARNING: Credentials file not found at $CREDENTIALS_FILE"
    echo "Using environment variables or expecting manual login"
fi

# --- Необязательный безбраузерный путь. ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН. ---
# Включается четвёртым аргументом --api или переменной CHAS_EGE_ASK_VIA_API=1.
# По умолчанию зовём headless-браузером: /api/v2/chat/completions защищён антиботом
# Alibaba (x5sec/bx-ua), и из датацентрового IP требует капчу. Если API не сработал,
# молча откатываемся на браузер; CHAS_EGE_ASK_API_STRICT=1 запрещает откат.
VIA_API="${CHAS_EGE_ASK_VIA_API:-0}"
if [ "${4:-}" = "--api" ]; then
    VIA_API=1
fi
if [ "$VIA_API" = "1" ]; then
    echo "Пробую безбраузерный путь (API)..."
    /usr/local/bin/node dev/ask_reviewer_via_api.mjs "$PR_NUMBER" \
        --credentials "$PROFILE_PATH" --wait="${CHAS_EGE_API_WAIT:-30}"
    api_rc=$?
    if [ $api_rc -eq 0 ]; then
        exit 0
    fi
    if [ "${CHAS_EGE_ASK_API_STRICT:-0}" = "1" ]; then
        echo "API-путь не сработал (код $api_rc), строгий режим - браузер не запускаю."
        exit $api_rc
    fi
    echo "API-путь не сработал (код $api_rc) - откатываюсь на headless-браузер."
fi

# Формируем текст сообщения
MESSAGE="https://github.com/nickkolok/chas-ege/pull/$PR_NUMBER"

# Запускаем новый обработчик
# --no-sandbox добавляется автоматически при запуске от root
if [ -n "$JQ_PASSWORD" ]; then
    echo "$JQ_PASSWORD" | /usr/local/bin/node dev/qwen-chat-auto.js \
      --user-data-dir="$PROFILE_PATH" \
      --login="$QWEN_LOGIN" \
      --password-stdin \
      --text="$MESSAGE" \
      --post-wait=30 \
      --headless \
      --executable-path=/snap/bin/chromium
else
    # Без credentials - полагаемся на существующую сессию в профиле
    /usr/local/bin/node dev/qwen-chat-auto.js \
      --user-data-dir="$PROFILE_PATH" \
      --text="$MESSAGE" \
      --post-wait=30 \
      --headless \
      --executable-path=/snap/bin/chromium
fi
