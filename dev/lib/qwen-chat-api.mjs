/**
 * Чаты Qwen через HTTP API — без браузера. ОТДЕЛЬНЫЙ, необязательный путь:
 * по умолчанию ревьюеров зовёт headless-браузер (dev/qwen-chat-auto.js).
 *
 * Что проверено вживую:
 *   POST /api/v2/chats/new              — создаёт чат, работает;
 *   POST /api/v2/files/getstsToken      — выдаёт STS-ключи Aliyun OSS, работает;
 *   PUT  https://<bucket>.<endpoint>/<path> — загрузка картинки подписью OSS V1, работает;
 *   POST /api/v2/chat/completions       — ЗАЩИЩЁН антиботом Alibaba (baxia/x5sec):
 *        из датацентрового IP отвечает {ret:["FAIL_SYS_USER_VALIDATE","RGV587_ERROR..."]}
 *        и ссылкой на капчу. Браузер проходит, потому что у него есть cookie x5sec
 *        и заголовки bx-ua, которые рисует их JS. С домашнего IP может и не спрашивать.
 *
 * Поэтому sendMessage честно распознаёт капчу и возвращает ошибку code='captcha',
 * а вызывающая сторона решает: падать или откатиться на браузер.
 *
 * Секреты (пароль, JWT, STS-ключи) не логируются.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { QwenApiError } from './qwen-api.mjs';

/** Признаки антибота Alibaba в ответе (HTTP при этом 200). */
export function isAntiBotPayload(json) {
    if (!json || typeof json !== 'object') return false;
    const ret = Array.isArray(json.ret) ? json.ret.join(' ') : '';
    if (/FAIL_SYS_USER_VALIDATE|RGV587_ERROR|SM::/.test(ret)) return true;
    const url = json.data && typeof json.data.url === 'string' ? json.data.url : '';
    return /x5secdata|punish|captcha/i.test(url);
}

/** Признак исчерпанной квоты модели в тексте ответа ассистента. */
export function isQuotaText(text) {
    return typeof text === 'string' && /reached today's .* limit|quota|лимит.*исчерпан/i.test(text);
}

/** Создаёт новый чат. Возвращает его id. */
export async function createChat(session, { model, title = 'New chat', chatType = 't2t' } = {}) {
    const json = await session.request('/api/v2/chats/new', {
        method: 'POST',
        body: { title, models: [model], chat_type: chatType, chat_mode: 'normal', project_id: '', timestamp: Math.floor(Date.now() / 1000) },
    });
    if (isAntiBotPayload(json)) throw new QwenApiError('антибот Qwen требует капчу на создании чата', 'captcha');
    const id = json && json.data && json.data.id;
    if (!id) throw new QwenApiError('чат не создан: сервер не вернул id', 'endpoint');
    return id;
}

/** Тот же feature_config, как у сообщений, отправленных браузером (снят с реального чата). */
export function defaultFeatureConfig() {
    return {
        thinking_enabled: true, output_schema: 'phase', instructions: null, research_mode: 'normal',
        auto_thinking: true, thinking_mode: 'Auto', thinking_format: 'summary', auto_search: true,
    };
}

/**
 * Отправляет сообщение в чат и читает поток ответа.
 * @param {object} o - chatId, text, model, files (массив описаний картинок), waitMs, onDelta
 * @returns {{antiBot: boolean, finished: boolean, answer: string, quotaHit: boolean}}
 */
export async function sendMessage(session, { chatId, text, model, files = [], waitMs = 30000, onDelta = null, chatType = 't2t' } = {}) {
    const message = {
        role: 'user', content: text, chat_type: chatType, sub_chat_type: chatType,
        extra: { meta: { subChatType: chatType } }, feature_config: defaultFeatureConfig(),
        files, user_action: 'chat', timestamp: Math.floor(Date.now() / 1000),
    };
    const body = {
        stream: true, incremental_output: true, chat_id: chatId, chat_type: chatType,
        model, messages: [message], version: '2.1', timestamp: Math.floor(Date.now() / 1000),
    };
    await session.ensureToken();
    const headers = {
        'User-Agent': session.userAgent,
        'Accept': 'text/event-stream',
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + session.token,
        'Cookie': 'token=' + session.token,
        'Origin': session.baseUrl,
        'Referer': session.baseUrl + '/c/' + chatId,
        'x-request-id': crypto.randomUUID(),
        'source': 'web',
    };
    let res;
    try {
        res = await fetch(`${session.baseUrl}/api/v2/chat/completions?chat_id=${chatId}`, {
            method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(waitMs + 15000),
        });
    } catch (e) {
        throw new QwenApiError(`сеть/таймаут при отправке сообщения: ${e.name}`, 'network');
    }
    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('event-stream')) {
        // обычный JSON: либо отказ, либо капча
        const raw = await res.text();
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* не json */ }
        if (isAntiBotPayload(json)) throw new QwenApiError('антибот Qwen требует капчу (x5sec/bx-ua). Без браузера сообщение не отправить.', 'captcha');
        if (json && json.success === false) throw new QwenApiError(`отказ отправки: ${(json.data && json.data.code) || 'неизвестно'}`, 'api', res.status);
        throw new QwenApiError(`неожиданный ответ на отправку (HTTP ${res.status}, ${ctype || 'без типа'})`, 'endpoint', res.status);
    }

    let answer = '';
    let finished = false;
    const deadline = Date.now() + waitMs;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
        while (Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) { finished = true; break; }
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const payload = line.slice(5).trim();
                if (!payload || payload === '[DONE]') { if (payload === '[DONE]') finished = true; continue; }
                let ev = null;
                try { ev = JSON.parse(payload); } catch (e) { continue; }
                if (isAntiBotPayload(ev)) throw new QwenApiError('антибот Qwen требует капчу посреди потока', 'captcha');
                const choices = ev.choices || (ev.data && ev.data.choices);
                if (Array.isArray(choices)) {
                    for (const c of choices) {
                        const d = c.delta || {};
                        if (typeof d.content === 'string' && d.content) {
                            answer += d.content;
                            if (typeof onDelta === 'function') onDelta(d.content);
                        }
                        if (d.status === 'finished' || c.finish_reason) finished = true;
                    }
                }
            }
        }
    } finally {
        try { await reader.cancel(); } catch (e) { /* уже закрыт */ }
    }
    return { antiBot: false, finished, answer, quotaHit: isQuotaText(answer) };
}

/**
 * Загружает картинку без браузера: STS-ключи у Qwen, сами байты — прямо в Aliyun OSS
 * (подпись OSS V1, HMAC-SHA1, без всяких SDK). Возвращает описание для messages[].files.
 * Проверено вживую: PUT отдаёт 200 и ETag.
 */
export async function uploadImage(session, filePath, { contentType = null } = {}) {
    const p = path.resolve(filePath);
    const data = fs.readFileSync(p);
    const name = path.basename(p);
    const ct = contentType || ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }[path.extname(p).toLowerCase()] || 'application/octet-stream');
    const json = await session.request('/api/v2/files/getstsToken', {
        method: 'POST', body: { filename: name, filesize: data.length, filetype: 'image' },
    });
    const d = json && json.data;
    if (!d || !d.access_key_id || !d.file_path) throw new QwenApiError('не выданы STS-ключи для загрузки файла', 'endpoint');
    const date = new Date().toUTCString();
    const resource = `/${d.bucketname}/${d.file_path}`;
    const signStr = `PUT\n\n${ct}\n${date}\nx-oss-security-token:${d.security_token}\n${resource}`;
    const signature = crypto.createHmac('sha1', d.access_key_secret).update(signStr, 'utf8').digest('base64');
    const url = `https://${d.bucketname}.${d.endpoint}/${d.file_path}`;
    let res;
    try {
        res = await fetch(url, {
            method: 'PUT',
            headers: {
                'Date': date, 'Content-Type': ct, 'x-oss-security-token': d.security_token,
                'Authorization': `OSS ${d.access_key_id}:${signature}`, 'User-Agent': session.userAgent,
            },
            body: data, signal: AbortSignal.timeout(60000),
        });
    } catch (e) {
        throw new QwenApiError(`загрузка в OSS не удалась: ${e.name}`, 'network');
    }
    if (!res.ok) throw new QwenApiError(`OSS отказал в загрузке: HTTP ${res.status}`, 'api', res.status);
    return {
        type: 'image', file: { id: d.file_id, url: d.file_url, name, size: data.length, type: ct },
        id: d.file_id, url: d.file_url, name, size: data.length,
    };
}
