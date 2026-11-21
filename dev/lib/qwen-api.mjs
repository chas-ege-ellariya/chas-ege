/**
 * Клиент HTTP API Qwen Chat (chat.qwen.ai) — работа с аккаунтом без браузера.
 *
 * Настройки аккаунта (промпт, модель по умолчанию) лежат на сервере, а не в
 * браузерном профиле, поэтому всё делается тремя запросами:
 *   POST /api/v2/auths/signin                 {email, password: sha256(password)} -> JWT
 *   GET  /api/v2/users/user/settings          -> data.personalization.instruction, data.ui.models
 *   POST /api/v2/users/user/settings/update   весь объект настроек, изменены только нужные поля
 *
 * Chromium не нужен, чаты не создаются, сессия браузерного профиля не выбивается
 * (проверено: два логина подряд дают разные токены, и оба остаются валидными).
 *
 * Токены кэшируются в dev/.qwen-tokens.cache (см. qwen-token-cache.mjs): повторно
 * не логинимся, а при 401/403 выкидываем запись и перелогиниваемся ровно один раз.
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
import { readToken, writeToken, dropToken, normalizeExpiry, DEFAULT_CACHE_FILE } from './qwen-token-cache.mjs';

export const QWEN_BASE_URL = 'https://chat.qwen.ai';
/** Лимит поля инструкции в интерфейсе Qwen (textarea maxlength). */
export const INSTRUCTION_MAX_CHARS = 40960;
/** Меньше килобайта — почти наверняка ошибка копирования, а не промпт. */
export const PROMPT_MIN_BYTES = 1024;
/**
 * Свежий Chromium на Linux, reduced UA (минорные версии у Chrome заморожены нулями).
 * Мажор здесь — запасной вариант: браузерный скрипт кладёт в кэш свой настоящий
 * navigator.userAgent, и клиент автоматически берёт его. Плюс есть --user-agent.
 */
export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

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
    let raw;
    try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(p));
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

async function apiCall(apiPath, { method = 'GET', body, token, baseUrl = QWEN_BASE_URL, timeoutMs = 20000, userAgent = DEFAULT_USER_AGENT, attempts = 3 } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const headers = {
            'User-Agent': userAgent,
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
            throw new QwenApiError(`доступ запрещён (протухший токен/капча/WAF?): ${brief(json, res.status)}`, 'forbidden', res.status);
        }
        if (!res.ok) throw new QwenApiError(`неожиданный ответ: ${brief(json, res.status)}`, 'api', res.status);
        if (!json || typeof json !== 'object') {
            throw new QwenApiError(`ответ не JSON на ${method} ${apiPath} (API поменялся?)`, 'endpoint', res.status);
        }
        // бывает HTTP 200 с {code, details} вообще без success — это тоже отказ
        if (json.success === undefined && typeof json.code === 'string' && json.details) {
            throw new QwenApiError(`отказ API: HTTP ${res.status} / ${json.code} / ${String(json.details).slice(0, 160)}`, 'api', res.status);
        }
        if (json.success === false) {
            const d = json.data || {};
            const code = String(d.code || '').toLowerCase();
            if (code.includes('password') || code.includes('credential') || code.includes('auth') || code.includes('login') || code.includes('token')) {
                throw new QwenApiError(`отказ авторизации: ${brief(json, res.status)}`, 'auth', res.status);
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
export async function signIn({ login, password, baseUrl = QWEN_BASE_URL, timeoutMs = 20000, userAgent = DEFAULT_USER_AGENT }) {
    if (!login || !password) throw new QwenApiError('пустой логин или пароль', 'credentials');
    const json = await apiCall('/api/v2/auths/signin', {
        method: 'POST',
        body: { email: login, password: sha256hex(password) },
        baseUrl, timeoutMs, userAgent,
    });
    const d = json.data || {};
    if (!d.token) throw new QwenApiError('логин не удался: сервер не выдал токен', 'auth');
    return { token: d.token, email: d.email || login, id: d.id, expiresAt: normalizeExpiry(d.expires_at) };
}

/**
 * Сессия с кэшем токенов: берёт токен из dev/.qwen-tokens.cache, а если его нет,
 * он истёк или сервер ответил 401/403 — логинится и обновляет кэш. Перелогин
 * ровно один раз на запрос: 403 может означать капчу, и долбиться бессмысленно.
 *
 * @param {object} o - login, password, baseUrl, timeoutMs, userAgent, useCache, cacheFile, onEvent
 */
export function openSession({ login, password, baseUrl = QWEN_BASE_URL, timeoutMs = 20000, userAgent = null, useCache = true, cacheFile = DEFAULT_CACHE_FILE, onEvent = null }) {
    if (!login) throw new QwenApiError('не задан логин', 'credentials');
    const say = (msg) => { if (typeof onEvent === 'function') onEvent(msg); };
    const cached = useCache ? readToken({ login, baseUrl, file: cacheFile }) : null;
    let token = cached ? cached.token : null;
    let expiresAt = cached ? cached.expiresAt : null;
    let email = login;
    const ua = userAgent || (cached && cached.userAgent) || DEFAULT_USER_AGENT;
    if (cached) say(`токен взят из кэша (${cached.source}), логин не нужен`);

    const session = {
        login, baseUrl, userAgent: ua,
        get email() { return email; },
        // токен наружу нужен потоковым запросам (SSE), которые не проходят через request()
        get token() { return token; },
        async ensureToken() { if (!token) await session.refresh(); return token; },
        get tokenSource() { return token ? (cached && token === cached.token ? 'cache' : 'fresh') : 'none'; },
        async refresh() {
            const s = await signIn({ login, password, baseUrl, timeoutMs, userAgent: ua });
            token = s.token; expiresAt = s.expiresAt; email = s.email;
            if (useCache) {
                try { writeToken({ login, baseUrl, token, expiresAt, userAgent: ua, source: 'api', file: cacheFile }); }
                catch (e) { say(`кэш токенов не записался: ${e.code || e.name}`); }
            }
            say('получен свежий токен, кэш обновлён');
            return token;
        },
        async request(apiPath, { method = 'GET', body } = {}) {
            if (!token) await session.refresh();
            const opts = { method, body, token, baseUrl, timeoutMs, userAgent: ua };
            try {
                return await apiCall(apiPath, opts);
            } catch (e) {
                const authTrouble = e instanceof QwenApiError && (e.code === 'forbidden' || e.code === 'auth');
                if (!authTrouble || !password) throw e;
                say('токен не принят — выкидываю из кэша и перелогиниваюсь один раз');
                if (useCache) { try { dropToken({ login, baseUrl, file: cacheFile }); } catch (err) { /* не страшно */ } }
                token = null;
                await session.refresh();
                return await apiCall(apiPath, { ...opts, token });
            }
        },
    };
    return session;
}

/** Все настройки аккаунта. В ответе лежит промпт — целиком его не логируем. */
export async function getSettings(session) {
    const json = await session.request('/api/v2/users/user/settings');
    if (!json.data || typeof json.data !== 'object') throw new QwenApiError('в ответе настроек нет data', 'endpoint');
    return json.data;
}

export function extractInstruction(settings) {
    const p = settings && settings.personalization;
    return p && typeof p.instruction === 'string' ? p.instruction : null;
}

/** Модель по умолчанию: ui.models — массив id, для наших целей ровно один. */
export function extractModels(settings) {
    const ui = settings && settings.ui;
    return ui && Array.isArray(ui.models) ? ui.models.slice() : [];
}

/** Каталог моделей: id берём отсюда, чтобы опечатка не ушла в настройки молча. */
export async function listModels(session) {
    const json = await session.request('/api/v2/models/');
    const list = (json.data && Array.isArray(json.data.data)) ? json.data.data : (Array.isArray(json.data) ? json.data : []);
    return list.map(m => ({ id: m.id, name: (m.info && m.info.name) || m.name || m.id })).filter(m => m.id);
}

/**
 * Общая запись настроек: читаем текущие, отправляем ТОЛЬКО изменённые разделы,
 * перечитываем и отдаём «до/после».
 *
 * ВАЖНО (грабли, найденные вживую): если отправить обратно весь объект настроек,
 * Qwen для части аккаунтов молча игнорирует запрос целиком — отвечает
 * {success:true} и старыми значениями. Виноват раздел manage_cookies: стоит ему
 * попасть в payload (у аккаунтов с записанным согласием на куки он непустой),
 * как не применяется НИЧЕГО. Поэтому шлём только то, что реально меняем:
 * это и работает, и не затирает соседние разделы.
 *
 * @param {Function} mutate - получает (payload, before); кладёт в payload разделы для записи
 * @returns {{before: object, after: object}}
 */
export async function updateSettings(session, mutate) {
    const before = await getSettings(session);
    const payload = {};
    mutate(payload, JSON.parse(JSON.stringify(before)));
    if (!Object.keys(payload).length) return { before, after: before };
    await session.request('/api/v2/users/user/settings/update', { method: 'POST', body: payload });
    const after = await getSettings(session);
    return { before, after };
}

/**
 * Промпт и модель по умолчанию одним заходом: один read-modify-write, одна сверка.
 * @param {object} want - {instruction?: string, model?: string}
 * @returns {{changed: boolean, instructionChanged: boolean, modelChanged: boolean, before: object, after: object}}
 */
export async function applyAccountConfig(session, want) {
    const before = await getSettings(session);
    const curInstruction = extractInstruction(before);
    const curModels = extractModels(before);
    const needInstruction = want.instruction !== undefined && want.instruction !== null && curInstruction !== want.instruction;
    const needModel = !!want.model && !(curModels.length === 1 && curModels[0] === want.model);
    if (!needInstruction && !needModel) {
        return { changed: false, instructionChanged: false, modelChanged: false,
                 before: { instruction: curInstruction, models: curModels }, after: { instruction: curInstruction, models: curModels } };
    }

    // только изменённые разделы: весь объект целиком Qwen местами молча игнорирует
    // (см. комментарий к updateSettings — виноват manage_cookies)
    const payload = {};
    if (needInstruction) {
        payload.personalization = Object.assign(
            { name: '', description: '', style: null, enable_for_new_chat: true },
            before.personalization || {},
            { instruction: want.instruction },
        );
    }
    if (needModel) {
        payload.ui = Object.assign({}, before.ui || {}, { models: [want.model] });
    }
    const resp = await session.request('/api/v2/users/user/settings/update', { method: 'POST', body: payload });

    // сервер возвращает применённые настройки: если в эхе старое — запрос проигнорирован
    const echo = resp && resp.data;
    if (echo && typeof echo === 'object') {
        if (needInstruction && extractInstruction(echo) !== want.instruction) {
            throw new QwenApiError('сервер ответил success, но промпт не применил (в эхе старое значение). Похоже, запрос проигнорирован целиком.', 'verify');
        }
        const em = extractModels(echo);
        if (needModel && !(em.length === 1 && em[0] === want.model)) {
            throw new QwenApiError(`сервер ответил success, но модель не применил (в эхе [${em.join(', ')}]). Похоже, запрос проигнорирован целиком.`, 'verify');
        }
    }

    const after = await getSettings(session);
    const gotInstruction = extractInstruction(after);
    const gotModels = extractModels(after);
    if (needInstruction && gotInstruction !== want.instruction) {
        const w = fingerprint(want.instruction), g = fingerprint(gotInstruction || '');
        throw new QwenApiError(`проверка после записи не прошла (промпт): ожидался sha256 ${w.sha256} (${w.chars} симв.), в аккаунте ${g.sha256} (${g.chars} симв.)`, 'verify');
    }
    if (needModel && !(gotModels.length === 1 && gotModels[0] === want.model)) {
        throw new QwenApiError(`проверка после записи не прошла (модель): ожидалась [${want.model}], в аккаунте [${gotModels.join(', ')}]`, 'verify');
    }
    return { changed: true, instructionChanged: needInstruction, modelChanged: needModel,
             before: { instruction: curInstruction, models: curModels }, after: { instruction: gotInstruction, models: gotModels } };
}

/** Только прочитать и сравнить. Ничего не пишет. */
export async function checkAccountConfig(session, want) {
    const settings = await getSettings(session);
    const instruction = extractInstruction(settings);
    const models = extractModels(settings);
    return {
        instruction, models,
        instructionMatches: want.instruction === undefined || want.instruction === null ? null : instruction === want.instruction,
        modelMatches: !want.model ? null : (models.length === 1 && models[0] === want.model),
    };
}
