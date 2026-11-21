/**
 * Общий кэш токенов Qwen: чтобы не логиниться на каждый чих.
 *
 * Файл: dev/.qwen-tokens.cache — JSON, права 0600. Маска *.cache уже в .gitignore,
 * так что секрет не уедет в репозиторий. Ключ — baseUrl|login (токен с одного
 * хоста на другом бесполезен), значение:
 *   { token, expiresAt, savedAt, source: "api"|"browser", userAgent }
 *
 * userAgent пишем затем, чтобы безбраузерный клиент говорил ровно тем же голосом,
 * что и настоящий Chromium из профиля — не придётся угадывать «свежую» версию.
 *
 * Запись атомарная (tmp + rename) и с перечитыванием файла: параллельный писатель
 * не затрёт чужие ключи и не оставит полуфайл. В логи наружу не отдаём ничего,
 * кроме количества записей: внутри лежат JWT.
 *
 * Модуль намеренно не зависит от qwen-api.mjs — его подключает и браузерный
 * dev/qwen-chat-auto.js (CommonJS, через await import()).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..', '..');
export const DEFAULT_CACHE_FILE = path.join(PROJECT_ROOT, 'dev', '.qwen-tokens.cache');
/** Запас до истечения токена: меньше пяти минут — считаем, что пора перелогиниться. */
export const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export function cacheKey(login, baseUrl) {
    return `${baseUrl}|${String(login).trim().toLowerCase()}`;
}

/** Приводит expires_at к миллисекундам: API отдаёт секунды, браузер может отдать и мс. */
export function normalizeExpiry(value) {
    if (!value) return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function readAll(file) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && typeof j === 'object' && j.entries && typeof j.entries === 'object') return j;
    } catch (e) { /* нет файла, битый json — считаем кэш пустым */ }
    return { version: 1, entries: {} };
}

function writeAll(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (e) { /* на не-POSIX не страшно */ }
    fs.renameSync(tmp, file);
}

/**
 * Достаёт годный токен из кэша. Ничего не проверяет по сети: протухший на практике
 * токен отсеется первым же запросом (401/403), и клиент перелогинится сам.
 * @returns {{token: string, expiresAt: number|null, userAgent: string|null, source: string}|null}
 */
export function readToken({ login, baseUrl, file = DEFAULT_CACHE_FILE, now = Date.now(), marginMs = EXPIRY_MARGIN_MS }) {
    if (!login || !baseUrl) return null;
    const e = readAll(file).entries[cacheKey(login, baseUrl)];
    if (!e || !e.token) return null;
    if (e.expiresAt && e.expiresAt - now < marginMs) return null;
    return {
        token: e.token,
        expiresAt: e.expiresAt || null,
        userAgent: e.userAgent || null,
        source: e.source || 'api',
        savedAt: e.savedAt || null,
    };
}

/** Кладёт токен в кэш. Возвращает true, если записали. */
export function writeToken({ login, baseUrl, token, expiresAt = null, userAgent = null, source = 'api', file = DEFAULT_CACHE_FILE }) {
    if (!login || !baseUrl || !token) return false;
    const data = readAll(file);
    const key = cacheKey(login, baseUrl);
    const prev = data.entries[key] || {};
    data.entries[key] = {
        token,
        expiresAt: normalizeExpiry(expiresAt),
        userAgent: userAgent || prev.userAgent || null,
        source,
        savedAt: Date.now(),
    };
    writeAll(file, data);
    return true;
}

/** Выкидывает запись (протухла, отказ API). */
export function dropToken({ login, baseUrl, file = DEFAULT_CACHE_FILE }) {
    if (!login || !baseUrl) return false;
    const data = readAll(file);
    const key = cacheKey(login, baseUrl);
    if (!(key in data.entries)) return false;
    delete data.entries[key];
    writeAll(file, data);
    return true;
}

/** Сколько записей в кэше — единственное, что можно показать в логе. */
export function cacheStats(file = DEFAULT_CACHE_FILE) {
    const entries = readAll(file).entries;
    return { file, count: Object.keys(entries).length };
}
