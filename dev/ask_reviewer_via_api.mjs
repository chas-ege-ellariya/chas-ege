#!/usr/bin/env node
/**
 * ask_reviewer_via_api.mjs — позвать ассистента-ревьюера БЕЗ браузера:
 * создать чат через API и отправить в него ссылку на пуллреквест.
 *
 * Это НЕОБЯЗАТЕЛЬНЫЙ путь. По умолчанию ревьюеров зовёт headless-браузер
 * (dev/qwen-chat-auto.js); включается флагом --api в dev/lib/ask_to_review.sh
 * или переменной CHAS_EGE_ASK_VIA_API=1.
 *
 *   node dev/ask_reviewer_via_api.mjs 3612 --credentials ../chas-ege-chromium-profiles/kira-auto-3
 *   node dev/ask_reviewer_via_api.mjs https://github.com/nickkolok/chas-ege/pull/3612 --login … --password …
 *   node dev/ask_reviewer_via_api.mjs 3612 --credentials … --image=чертёж.png --image=ещё.png
 *
 * ВНИМАНИЕ: /api/v2/chat/completions защищён антиботом Alibaba. Из датацентрового IP
 * он требует капчу (x5sec/bx-ua умеет рисовать только их JS в браузере). С домашнего
 * IP может пройти. При капче скрипт выходит с кодом 9, и обёртка откатывается на браузер.
 *
 * Коды возврата: 0 — отправлено; 2 — аргументы; 4 — доступы; 5 — логин;
 *                6 — ошибка API; 9 — антибот/капча; 10 — квота модели исчерпана.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { QwenApiError, QWEN_BASE_URL, readProfileCredentials, openSession, getSettings, extractModels } from './lib/qwen-api.mjs';
import { DEFAULT_CACHE_FILE } from './lib/qwen-token-cache.mjs';
import { createChat, sendMessage, uploadImage } from './lib/qwen-chat-api.mjs';

const EXIT = { OK: 0, BAD_ARGS: 2, BAD_CREDENTIALS: 4, LOGIN_FAILED: 5, API: 6, CAPTCHA: 9, QUOTA: 10 };
const SPEC = {
    credentials: { type: 'string' }, login: { type: 'string' }, password: { type: 'string' },
    model: { type: 'string' }, wait: { type: 'string', default: '30' },
    image: { type: 'string', multiple: true },
    'base-url': { type: 'string', default: QWEN_BASE_URL }, timeout: { type: 'string', default: '20000' },
    'token-cache': { type: 'string', default: DEFAULT_CACHE_FILE }, 'no-token-cache': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};
const redact = (t) => String(t).replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***').replace(/STS\.[A-Za-z0-9]+/g, 'STS.***');

function usage(s = process.stdout) {
    s.write('Использование: node dev/ask_reviewer_via_api.mjs <PR-номер|URL> --credentials ПРОФИЛЬ\n' +
            '               node dev/ask_reviewer_via_api.mjs <PR> --login EMAIL --password PAROL\n' +
            'Ключи: --model ID, --wait СЕК (сколько читать поток, по умолчанию 30), --image=ФАЙЛ (можно несколько),\n' +
            '       --base-url, --timeout, --token-cache, --no-token-cache, --help\n');
}
function die(m, c) { console.error(m); process.exit(c); }

async function main() {
    let v, pos;
    try { ({ values: v, positionals: pos } = parseArgs({ args: process.argv.slice(2), options: SPEC, allowPositionals: true, strict: true })); }
    catch (e) { console.error(`Аргументы: ${e.message}`); usage(process.stderr); process.exit(EXIT.BAD_ARGS); }
    if (v.help) { usage(); process.exit(EXIT.OK); }
    if (pos.length !== 1) { console.error('Нужен ровно один аргумент: номер PR или ссылка на него.'); usage(process.stderr); process.exit(EXIT.BAD_ARGS); }
    const target = /^\d+$/.test(pos[0]) ? `https://github.com/nickkolok/chas-ege/pull/${pos[0]}` : pos[0];
    if (!/^https:\/\/github\.com\//.test(target)) die(`Не похоже на ссылку GitHub: ${target}`, EXIT.BAD_ARGS);
    const waitMs = Number(v.wait) * 1000;
    if (!Number.isFinite(waitMs) || waitMs < 0) die('--wait: нужно неотрицательное число секунд', EXIT.BAD_ARGS);

    let creds, source;
    try {
        if (v.login && v.password) { creds = { login: v.login, password: v.password }; source = 'логин и пароль из аргументов'; }
        else if (v.credentials) { creds = readProfileCredentials(v.credentials); source = `профиль ${creds.file}`; }
        else die('Не заданы доступы: --credentials или --login/--password.', EXIT.BAD_ARGS);
    } catch (e) { die(`Доступ: ${e.message}`, EXIT.BAD_CREDENTIALS); }

    const images = (v.image || []);
    for (const f of images) if (!fs.existsSync(f)) die(`Картинка не найдена: ${f}`, EXIT.BAD_ARGS);

    console.log(`Зову через API (без браузера): ${target}`);
    console.log(`Доступ: ${source}`);
    const session = openSession({
        login: creds.login, password: creds.password, baseUrl: v['base-url'].replace(/\/+$/, ''),
        timeoutMs: Number(v.timeout), useCache: !v['no-token-cache'], cacheFile: v['token-cache'],
        onEvent: (m) => console.log(`Токен: ${m}`),
    });

    try {
        let model = v.model;
        if (!model) {
            const models = extractModels(await getSettings(session));
            model = models[0];
            if (!model) die('Не определена модель: задай --model.', EXIT.API);
            console.log(`Модель аккаунта: ${model}`);
        }
        const files = [];
        for (const f of images) {
            const d = await uploadImage(session, f);
            files.push(d);
            console.log(`Картинка загружена: ${d.name} (${d.size} байт)`);
        }
        const chatId = await createChat(session, { model });
        console.log(`Чат создан: ${session.baseUrl}/c/${chatId}`);
        const res = await sendMessage(session, { chatId, text: target, model, files, waitMs });
        console.log(`Ответ: ${res.answer.length} симв., ${res.finished ? 'поток завершён' : 'чтение остановлено по --wait, генерация продолжается на сервере'}`);
        if (res.answer) console.log(`Начало ответа: ${redact(res.answer.slice(0, 300))}`);
        if (res.quotaHit) { console.error('Квота модели исчерпана — ревью, скорее всего, не будет.'); process.exit(EXIT.QUOTA); }
        console.log('Готово: сообщение отправлено без браузера.');
        process.exit(EXIT.OK);
    } catch (e) {
        if (e instanceof QwenApiError) {
            const code = e.code === 'captcha' ? EXIT.CAPTCHA : e.code === 'auth' || e.code === 'forbidden' ? EXIT.LOGIN_FAILED : e.code === 'credentials' ? EXIT.BAD_CREDENTIALS : EXIT.API;
            die(`Ошибка (${e.code}): ${e.message}`, code);
        }
        die(`Непредвиденная ошибка: ${e && e.name}: ${e && e.message}`, EXIT.API);
    }
}
main();
