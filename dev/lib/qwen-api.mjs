/**
 * Клиент HTTP API Qwen Chat (chat.qwen.ai) — работа с аккаунтом без браузера.
 *
 * Пользовательская инструкция («промпт») живёт в настройках аккаунта, а не в
 * браузерном профиле, поэтому её можно прочитать и поменять тремя запросами:
 *   POST /api/v2/auths/signin                 {email, password: sha256(password)} -> JWT
 *   GET  /api/v2/users/user/settings          -> data.personalization.instruction
 *   POST /api/v2/users/user/settings/update   весь объект настроек, изменено только поле
 *
 * Chromium не нужен, чаты не создаются, сессия браузерного профиля не выбивается
 * (проверено: два логина подряд дают разные токены, и оба остаются валидными).
 *
 * API неофициальный: может поменяться или закрыться капчей/WAF. Запасной путь —
 * браузерный dev/qwen-chat-auto.js --set-instruction.
 *
 * ВАЖНО: пароль, JWT и текст инструкции не логируются и не попадают в тексты
 * ошибок — в промпте лежит гитхабовский токен. Наружу отдаём только размеры и хэши.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const QWEN_BASE_URL = 'https://chat.qwen.ai';
/** Лимит поля инструкции в интерфейсе Qwen (textarea maxlength). */
export const INSTRUCTION_MAX_CHARS = 40960;
/** Меньше килобайта — почти наверняка ошибка копирования, а не промпт. */
export const PROMPT_MIN_BYTES = 1024;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Ошибка с машинночитаемым кодом: auth | forbidden | endpoint | network | server | verify | prompt | credentials */
export class QwenApiError extends Error {
    constructor(message, code = 'api', status = null) {
        super(message);
        this.name = 'QwenApiError';
        this.code = code;
        this.status = status;
    }
}

export function sha256hex(text) {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** То, что не стыдно показать в логе вместо самого текста. */
export function fingerprint(text) {
    if (typeof text !== 'string') return { chars: 0, bytes: 0, sha256: null };
    return { chars: Array.from(text).length, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha256hex(text) };
}

/** Нормализация ровно как в dev/qwen-chat-auto.js: CRLF -> LF, хвостовые переводы строк долой. */
export function normalizePromptText(raw) {
    return raw.replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/**
 * Читает и проверяет файл промпта.
 * Брак: не файл/каталог, меньше килобайта, бинарный мусор, пустой, длиннее лимита поля.
 * @returns {{text: string, file: string, size: number}}
 */
export function readPromptFile(file) {
    const p = path.resolve(file);
    let stat;
    try {
        stat = fs.statSync(p);
    } catch (e) {
        throw new QwenApiError(`файл промпта не найден: ${p}`, 'prompt');
    }
    if (!stat.isFile()) throw new QwenApiError(`это не обычный файл: ${p}`, 'prompt');
    if (stat.size < PROMPT_MIN_BYTES) {
        throw new QwenApiError(`файл промпта меньше ${PROMPT_MIN_BYTES} байт (${stat.size}) — похоже на ошибку копирования: ${p}`, 'prompt');
    }
    const buf = fs.readFileSync(p);
    let raw;
    try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch (e) {
        throw new QwenApiError(`файл промпта не является текстом в UTF-8 (бинарный мусор?): ${p}`, 'prompt');
    }
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(raw)) {
        throw new QwenApiError(`в файле промпта управляющие символы (бинарный мусор?): ${p}`, 'prompt');
    }
    const text = normalizePromptText(raw);
    if (!text.trim()) throw new QwenApiError(`файл промпта пуст: ${p}`, 'prompt');
    if (Array.from(text).length > INSTRUCTION_MAX_CHARS) {
        throw new QwenApiError(`промпт длиннее лимита поля инструкции (${INSTRUCTION_MAX_CHARS} симв.): ${Array.from(text).length}`, 'prompt');
    }
    return { text, file: p, size: stat.size };
}

/** Достаёт логин/пароль из credentials.json профиля (или из прямо указанного json-файла). */
export function readProfileCredentials(profilePath) {
    const p = path.resolve(profilePath);
    let file = p;
    try {
        if (fs.statSync(p).isDirectory()) file = path.join(p, 'credentials.json');
    } catch (e) {
        throw new QwenApiError(`профиль не найден: ${p}`, 'credentials');
    }
    let data;
    try {
        data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
        throw new QwenApiError(`не читается ${file} (${e.code || e.name})`, 'credentials');
    }
    const login = data.login || data.email;
    const password = data.password;
    if (!login || !password) throw new QwenApiError(`в ${file} нет login/password`, 'credentials');
    return { login, password, file };
}

/** Короткая выжимка из ответа — без тел настроек, где лежит промпт. */
function brief(json, status) {
    const d = (json && typeof json === 'object' && json.data) || {};
    const code = typeof d.code === 'string' ? d.code : '';
    const details = typeof d.details === 'string' ? d.details.slice(0, 160) : '';
    return [`HTTP ${status}`, code, details].filter(Boolean).join(' / ');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function apiCall(apiPath, { method = 'GET', body, token, baseUrl = QWEN_BASE_URL, timeoutMs = 20000, attempts = 3 } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const headers = {
            'User-Agent': UA,
            'Accept': 'application/json, text/plain, */*',
            'Referer': baseUrl + '/',
            'x-request-id': crypto.randomUUID(),
            'source': 'web',
        };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            headers['Origin'] = baseUrl;
        }
        if (token) {
            headers['Authorization'] = 'Bearer ' + token;
            headers['Cookie'] = 'token=' + token;
        }
        let res, raw;
        try {
            res = await fetch(baseUrl + apiPath, {
                method,
                headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
            raw = await res.text();
        } catch (e) {
            lastErr = new QwenApiError(`сеть/таймаут на ${method} ${apiPath}: ${e.name}`, 'network');
            if (attempt < attempts) { await sleep(1000 * attempt); continue; }
            throw lastErr;
        }
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* не json — разберём ниже по статусу */ }

        if (res.status >= 500) {
            lastErr = new QwenApiError(`сервер Qwen ошибся: ${brief(json, res.status)}`, 'server', res.status);
            if (attempt < attempts) { await sleep(1000 * attempt); continue; }
            throw lastErr;
        }
        if (res.status === 401 || res.status === 403) {
            throw new QwenApiError(`доступ запрещён (капча/WAF/протухший токен?): ${brief(json, res.status)}`, 'forbidden', res.status);
        }
        if (!res.ok) {
            throw new QwenApiError(`неожиданный ответ: ${brief(json, res.status)}`, 'api', res.status);
        }
        if (!json || typeof json !== 'object') {
            throw new QwenApiError(`ответ не JSON на ${method} ${apiPath} (API поменялся?)`, 'endpoint', res.status);
        }
        if (json.success === false) {
            const d = json.data || {};
            const code = String(d.code || '').toLowerCase();
            if (code.includes('password') || code.includes('credential') || code.includes('auth') || code.includes('login')) {
                throw new QwenApiError(`логин не удался: ${brief(json, res.status)}`, 'auth', res.status);
            }
            if (code.includes('not allowed') || code.includes('not found')) {
                throw new QwenApiError(`эндпоинт не принимает запрос (API поменялся?): ${brief(json, res.status)}`, 'endpoint', res.status);
            }
            throw new QwenApiError(`отказ API: ${brief(json, res.status)}`, 'api', res.status);
        }
        return json;
    }
    throw lastErr || new QwenApiError('неизвестная ошибка запроса', 'api');
}

/** Логин по email и паролю. Пароль уходит как SHA-256 — ровно так же это делает веб-морда. */
export async function signIn({ login, password, baseUrl = QWEN_BASE_URL, timeoutMs = 20000 }) {
    if (!login || !password) throw new QwenApiError('пустой логин или пароль', 'credentials');
    const json = await apiCall('/api/v2/auths/signin', {
        method: 'POST',
        body: { email: login, password: sha256hex(password) },
        baseUrl, timeoutMs,
    });
    const d = json.data || {};
    if (!d.token) throw new QwenApiError('логин не удался: сервер не выдал токен', 'auth');
    return { token: d.token, email: d.email || login, id: d.id };
}

/** Все настройки аккаунта. В ответе лежит промпт — целиком его не логируем. */
export async function getSettings(token, { baseUrl = QWEN_BASE_URL, timeoutMs = 20000 } = {}) {
    const json = await apiCall('/api/v2/users/user/settings', { token, baseUrl, timeoutMs });
    if (!json.data || typeof json.data !== 'object') throw new QwenApiError('в ответе настроек нет data', 'endpoint');
    return json.data;
}

export function extractInstruction(settings) {
    const p = settings && settings.personalization;
    return p && typeof p.instruction === 'string' ? p.instruction : null;
}

/** Только прочитать и сравнить. Ничего не пишет. */
export async function checkInstruction(token, text, opts = {}) {
    const actual = extractInstruction(await getSettings(token, opts));
    return { matches: actual === text, actual };
}

/**
 * Ставит инструкцию: читает настройки, меняет ровно одно поле, пишет весь объект
 * обратно (иначе есть риск затереть соседние разделы), затем перечитывает и сверяет.
 * @returns {{changed: boolean, before: string|null, after: string|null}}
 */
export async function setInstruction(token, text, opts = {}) {
    const settings = await getSettings(token, opts);
    const before = extractInstruction(settings);
    if (before === text) return { changed: false, before, after: before };

    const payload = JSON.parse(JSON.stringify(settings));
    payload.personalization = Object.assign(
        { name: '', description: '', style: null, enable_for_new_chat: true },
        settings.personalization || {},
        { instruction: text },
    );
    await apiCall('/api/v2/users/user/settings/update', { method: 'POST', body: payload, token, ...opts });

    const after = extractInstruction(await getSettings(token, opts));
    if (after !== text) {
        const want = fingerprint(text), got = fingerprint(after || '');
        throw new QwenApiError(
            `проверка после записи не прошла: ожидался sha256 ${want.sha256} (${want.chars} симв.), ` +
            `в аккаунте ${got.sha256} (${got.chars} симв.)`, 'verify');
    }
    return { changed: true, before, after };
}
