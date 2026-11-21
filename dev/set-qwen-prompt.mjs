#!/usr/bin/env node
/**
 * set-qwen-prompt.mjs — поставить аккаунту Qwen пользовательскую инструкцию («промпт»)
 * через HTTP API: без Chromium, без браузерного профиля и без создания чатов.
 *
 * Использование (два или три аргумента):
 *   node dev/set-qwen-prompt.mjs <промпт.txt> <папка-профиля>
 *   node dev/set-qwen-prompt.mjs <промпт.txt> <папка-профиля/credentials.json>
 *   node dev/set-qwen-prompt.mjs <промпт.txt> <логин> <пароль>
 *
 * В первом случае логин и пароль берутся из credentials.json профиля
 * (тот же файл, что используют dev/ask_*_to_review.sh). Во втором — из аргументов,
 * так что скрипт можно запускать и со своей машины, сервер не нужен.
 *
 * Ключи:
 *   --check          только прочитать и сравнить, ничего не писать (код 7, если отличается)
 *   --dry-run        показать, что изменилось бы, но не писать
 *   --base-url=URL   другой адрес API (по умолчанию https://chat.qwen.ai)
 *   --timeout=МС     таймаут одного запроса (по умолчанию 20000)
 *   --help
 *
 * Коды возврата:
 *   0 — промпт установлен (или уже стоял такой же)
 *   2 — неверные аргументы
 *   3 — плохой файл промпта (каталог, меньше килобайта, бинарный мусор, длиннее лимита)
 *   4 — не удалось взять логин/пароль
 *   5 — логин не удался
 *   6 — ошибка API (в том числе капча/WAF или смена API)
 *   7 — --check: промпт в аккаунте отличается
 *   8 — записали, но проверка после записи не совпала
 *
 * Секреты не печатаются: ни пароль, ни токен, ни текст промпта — только размеры и хэши.
 * Требуется Node.js 18+ (глобальный fetch).
 */

import {
    QwenApiError, QWEN_BASE_URL, INSTRUCTION_MAX_CHARS,
    readPromptFile, readProfileCredentials, fingerprint,
    signIn, getSettings, extractInstruction, setInstruction,
} from './lib/qwen-api.mjs';

const EXIT = { OK: 0, BAD_ARGS: 2, BAD_PROMPT: 3, BAD_CREDENTIALS: 4, LOGIN_FAILED: 5, API: 6, DIFFERS: 7, VERIFY: 8 };
const ERROR_EXIT = { prompt: EXIT.BAD_PROMPT, credentials: EXIT.BAD_CREDENTIALS, auth: EXIT.LOGIN_FAILED, verify: EXIT.VERIFY };

function usage(stream = process.stdout) {
    stream.write([
        'Использование:',
        '  node dev/set-qwen-prompt.mjs <промпт.txt> <папка-профиля|credentials.json>',
        '  node dev/set-qwen-prompt.mjs <промпт.txt> <логин> <пароль>',
        '',
        'Ключи: --check, --dry-run, --base-url=URL, --timeout=МС, --help',
        '',
    ].join('\n'));
}

function parseArgs(argv) {
    const cfg = { baseUrl: QWEN_BASE_URL, timeoutMs: 20000, check: false, dryRun: false, help: false, positional: [] };
    for (const a of argv) {
        if (a === '--help' || a === '-h') cfg.help = true;
        else if (a === '--check') cfg.check = true;
        else if (a === '--dry-run') cfg.dryRun = true;
        else if (a.startsWith('--base-url=')) cfg.baseUrl = a.slice('--base-url='.length).replace(/\/+$/, '');
        else if (a.startsWith('--timeout=')) {
            const n = Number(a.slice('--timeout='.length));
            if (!Number.isFinite(n) || n <= 0) throw new QwenApiError('--timeout: нужно положительное число миллисекунд', 'args');
            cfg.timeoutMs = n;
        }
        else if (a.startsWith('--')) throw new QwenApiError(`неизвестный ключ: ${a}`, 'args');
        else cfg.positional.push(a);
    }
    return cfg;
}

function show(label, text) {
    const f = fingerprint(text);
    if (text === null || text === undefined) { console.log(`${label}: пусто (инструкция не задана)`); return; }
    console.log(`${label}: ${f.chars} симв., ${f.bytes} байт, ${text.split('\n').length} строк, sha256 ${f.sha256}`);
}

async function main() {
    if (typeof fetch !== 'function') {
        console.error('Нужен Node.js 18+ (нет глобального fetch).');
        process.exit(EXIT.API);
    }
    let cfg;
    try {
        cfg = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message); usage(process.stderr); process.exit(EXIT.BAD_ARGS);
    }
    if (cfg.help) { usage(); process.exit(EXIT.OK); }
    if (cfg.positional.length !== 2 && cfg.positional.length !== 3) {
        console.error(`Нужно 2 или 3 аргумента, получено ${cfg.positional.length}.`);
        usage(process.stderr);
        process.exit(EXIT.BAD_ARGS);
    }

    const [promptFile, second, third] = cfg.positional;
    const opts = { baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs };

    let prompt, creds, source;
    try {
        prompt = readPromptFile(promptFile);
    } catch (e) {
        console.error(`Промпт: ${e.message}`);
        process.exit(ERROR_EXIT[e.code] || EXIT.BAD_PROMPT);
    }
    try {
        if (third === undefined) {
            creds = readProfileCredentials(second);
            source = `профиль ${creds.file}`;
        } else {
            creds = { login: second, password: third };
            source = 'логин и пароль из аргументов';
        }
    } catch (e) {
        console.error(`Доступ: ${e.message}`);
        process.exit(ERROR_EXIT[e.code] || EXIT.BAD_CREDENTIALS);
    }

    console.log(`Файл промпта: ${prompt.file} (${prompt.size} байт)`);
    show('Промпт к установке', prompt.text);
    console.log(`Лимит поля: ${INSTRUCTION_MAX_CHARS} симв. — ${Array.from(prompt.text).length <= INSTRUCTION_MAX_CHARS ? 'укладываемся' : 'ПРЕВЫШЕН'}`);
    console.log(`Доступ: ${source}`);

    let session;
    try {
        session = await signIn({ ...creds, ...opts });
    } catch (e) {
        console.error(`Логин: ${e.message}`);
        process.exit(ERROR_EXIT[e.code] || EXIT.LOGIN_FAILED);
    }
    console.log(`Аккаунт: ${session.email}`);

    try {
        const current = extractInstruction(await getSettings(session.token, opts));
        show('Промпт в аккаунте', current);
        const same = current === prompt.text;

        if (cfg.check) {
            console.log(same ? 'Совпадает: промпт в аккаунте ровно такой.' : 'Отличается: в аккаунте другой промпт.');
            process.exit(same ? EXIT.OK : EXIT.DIFFERS);
        }
        if (same) {
            console.log('Уже установлен такой же промпт — ничего не делаю.');
            process.exit(EXIT.OK);
        }
        if (cfg.dryRun) {
            console.log('--dry-run: промпт отличается, но ничего не записываю.');
            process.exit(EXIT.OK);
        }

        console.log('Записываю новый промпт (меняется только personalization.instruction)...');
        const res = await setInstruction(session.token, prompt.text, opts);
        show('Промпт после записи', res.after);
        console.log('Проверка после записи: совпадает символ в символ.');
        console.log(res.changed ? 'Готово: промпт обновлён.' : 'Готово: промпт уже был таким.');
        process.exit(EXIT.OK);
    } catch (e) {
        if (e instanceof QwenApiError) {
            console.error(`Ошибка (${e.code}): ${e.message}`);
            process.exit(ERROR_EXIT[e.code] || EXIT.API);
        }
        console.error(`Непредвиденная ошибка: ${e && e.name}: ${e && e.message}`);
        process.exit(EXIT.API);
    }
}

main();
