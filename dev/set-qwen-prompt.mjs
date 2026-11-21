#!/usr/bin/env node
/**
 * set-qwen-prompt.mjs — поставить аккаунту Qwen мастер-промпт и/или модель по умолчанию
 * через HTTP API: без Chromium, без браузерного профиля и без создания чатов.
 *
 * Использование:
 *   node dev/set-qwen-prompt.mjs --master-prompt Kira.prompt.txt --default-model qwen4-max \
 *        --credentials ../chas-ege-chromium-profiles/kira-auto-3
 *   node dev/set-qwen-prompt.mjs --master-prompt Kira.prompt.txt --login EMAIL --password PAROL
 *   node dev/set-qwen-prompt.mjs --default-model qwen4-max --credentials ПРОФИЛЬ
 *   node dev/set-qwen-prompt.mjs --check --master-prompt Kira.prompt.txt --credentials ПРОФИЛЬ
 *
 * Старая позиционная форма тоже работает: <промпт> <профиль> или <промпт> <логин> <пароль>.
 * Флаги имеют приоритет над позиционными аргументами.
 *
 * Промпт и модель, если заданы оба, пишутся ОДНИМ запросом и сверяются одним чтением.
 * Токены кэшируются в dev/.qwen-tokens.cache (общий кэш с браузерным скриптом),
 * так что повторные запуски и аудит по всем профилям обходятся без логинов.
 *
 * Коды возврата:
 *   0 — установлено (или уже стояло так же)
 *   2 — неверные аргументы / неизвестная модель
 *   3 — плохой файл промпта (каталог, меньше килобайта, бинарный мусор, длиннее лимита)
 *   4 — не удалось взять логин/пароль
 *   5 — логин не удался
 *   6 — ошибка API (в том числе капча/WAF или смена API)
 *   7 — --check: в аккаунте что-то отличается
 *   8 — записали, но проверка после записи не совпала
 *
 * Секреты не печатаются: ни пароль, ни токен, ни текст промпта — только размеры и хэши.
 * Требуется Node.js 18.3+ (глобальный fetch и util.parseArgs).
 */

import { parseArgs } from 'node:util';
import {
    QwenApiError, QWEN_BASE_URL, INSTRUCTION_MAX_CHARS, DEFAULT_USER_AGENT,
    readPromptFile, readProfileCredentials, fingerprint,
    openSession, listModels, applyAccountConfig, checkAccountConfig,
} from './lib/qwen-api.mjs';
import { DEFAULT_CACHE_FILE } from './lib/qwen-token-cache.mjs';

const EXIT = { OK: 0, BAD_ARGS: 2, BAD_PROMPT: 3, BAD_CREDENTIALS: 4, LOGIN_FAILED: 5, API: 6, DIFFERS: 7, VERIFY: 8 };
const ERROR_EXIT = { prompt: EXIT.BAD_PROMPT, credentials: EXIT.BAD_CREDENTIALS, auth: EXIT.LOGIN_FAILED, verify: EXIT.VERIFY };

const OPTIONS_SPEC = {
    'master-prompt': { type: 'string' },
    'default-model': { type: 'string' },
    credentials: { type: 'string' },
    login: { type: 'string' },
    password: { type: 'string' },
    check: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'base-url': { type: 'string', default: QWEN_BASE_URL },
    timeout: { type: 'string', default: '20000' },
    'user-agent': { type: 'string' },
    'token-cache': { type: 'string', default: DEFAULT_CACHE_FILE },
    'no-token-cache': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
};

function usage(stream = process.stdout) {
    stream.write([
        'Использование:',
        '  node dev/set-qwen-prompt.mjs --master-prompt ФАЙЛ [--default-model ID] --credentials ПРОФИЛЬ',
        '  node dev/set-qwen-prompt.mjs --master-prompt ФАЙЛ [--default-model ID] --login EMAIL --password PAROL',
        '  (старая форма: ФАЙЛ ПРОФИЛЬ или ФАЙЛ ЛОГИН ПАРОЛЬ)',
        '',
        'Что ставим:',
        '  --master-prompt ФАЙЛ   мастер-промпт (пользовательская инструкция)',
        '  --default-model ID     модель по умолчанию, например qwen4-max',
        'Доступы:',
        '  --credentials ПУТЬ     папка профиля или сам credentials.json',
        '  --login EMAIL --password PAROL',
        'Прочее:',
        '  --check                только сравнить, ничего не писать (код 7, если отличается)',
        '  --dry-run              показать, что изменилось бы, но не писать',
        '  --no-token-cache       не пользоваться кэшем токенов',
        '  --token-cache ПУТЬ     другой файл кэша (по умолчанию dev/.qwen-tokens.cache)',
        '  --base-url URL         другой адрес API',
        '  --timeout МС           таймаут запроса (по умолчанию 20000)',
        '  --user-agent СТРОКА    свой User-Agent (иначе берётся из кэша или свежий Chromium/Linux)',
        '  --help',
        '',
    ].join('\n'));
}

function show(label, text) {
    if (text === null || text === undefined) { console.log(`${label}: пусто (инструкция не задана)`); return; }
    const f = fingerprint(text);
    console.log(`${label}: ${f.chars} симв., ${f.bytes} байт, ${text.split('\n').length} строк, sha256 ${f.sha256}`);
}

function die(message, code) {
    console.error(message);
    process.exit(code);
}

async function main() {
    if (typeof fetch !== 'function') die('Нужен Node.js 18.3+ (нет глобального fetch).', EXIT.API);

    let values, positionals;
    try {
        ({ values, positionals } = parseArgs({ args: process.argv.slice(2), options: OPTIONS_SPEC, allowPositionals: true, strict: true }));
    } catch (e) {
        console.error(`Аргументы: ${e.message}`);
        usage(process.stderr);
        process.exit(EXIT.BAD_ARGS);
    }
    if (values.help) { usage(); process.exit(EXIT.OK); }

    const timeoutMs = Number(values.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die('--timeout: нужно положительное число миллисекунд', EXIT.BAD_ARGS);
    const baseUrl = values['base-url'].replace(/\/+$/, '');

    // флаги важнее позиционных; позиционные — совместимость со старой формой
    const promptFile = values['master-prompt'] || positionals[0] || null;
    const model = values['default-model'] || null;
    let credentialsPath = values.credentials || null;
    let login = values.login || null;
    let password = values.password || null;
    if (!credentialsPath && !login && positionals.length === 2) credentialsPath = positionals[1];
    if (!credentialsPath && !login && positionals.length === 3) { login = positionals[1]; password = positionals[2]; }

    if (!promptFile && !model) {
        console.error('Нечего делать: задай --master-prompt и/или --default-model.');
        usage(process.stderr);
        process.exit(EXIT.BAD_ARGS);
    }
    if (!credentialsPath && !(login && password)) {
        console.error('Не заданы доступы: --credentials или пара --login/--password.');
        usage(process.stderr);
        process.exit(EXIT.BAD_ARGS);
    }

    let prompt = null;
    if (promptFile) {
        try { prompt = readPromptFile(promptFile); }
        catch (e) { die(`Промпт: ${e.message}`, ERROR_EXIT[e.code] || EXIT.BAD_PROMPT); }
    }
    let creds, source;
    try {
        if (login && password) { creds = { login, password }; source = 'логин и пароль из аргументов'; }
        else { creds = readProfileCredentials(credentialsPath); source = `профиль ${creds.file}`; }
    } catch (e) { die(`Доступ: ${e.message}`, ERROR_EXIT[e.code] || EXIT.BAD_CREDENTIALS); }

    if (prompt) {
        console.log(`Файл промпта: ${prompt.file} (${prompt.size} байт)`);
        show('Промпт к установке', prompt.text);
        console.log(`Лимит поля: ${INSTRUCTION_MAX_CHARS} симв. — ${Array.from(prompt.text).length <= INSTRUCTION_MAX_CHARS ? 'укладываемся' : 'ПРЕВЫШЕН'}`);
    }
    if (model) console.log(`Модель по умолчанию к установке: ${model}`);
    console.log(`Доступ: ${source}`);

    const session = openSession({
        login: creds.login,
        password: creds.password,
        baseUrl,
        timeoutMs,
        userAgent: values['user-agent'] || process.env.QWEN_USER_AGENT || null,
        useCache: !values['no-token-cache'],
        cacheFile: values['token-cache'],
        onEvent: (m) => console.log(`Токен: ${m}`),
    });

    const want = { instruction: prompt ? prompt.text : undefined, model: model || undefined };
    try {
        const state = await checkAccountConfig(session, want);
        console.log(`Аккаунт: ${session.email}`);
        if (prompt) show('Промпт в аккаунте', state.instruction);
        console.log(`Модель в аккаунте: [${state.models.join(', ') || 'не задана'}]`);

        if (values.check) {
            const diffs = [];
            if (state.instructionMatches === false) diffs.push('промпт');
            if (state.modelMatches === false) diffs.push('модель');
            console.log(diffs.length ? `Отличается: ${diffs.join(', ')}.` : 'Совпадает: в аккаунте ровно то, что просили.');
            process.exit(diffs.length ? EXIT.DIFFERS : EXIT.OK);
        }

        const needInstruction = state.instructionMatches === false;
        const needModel = state.modelMatches === false;
        if (!needInstruction && !needModel) {
            console.log('Уже установлено то же самое — ничего не делаю.');
            process.exit(EXIT.OK);
        }
        if (values['dry-run']) {
            console.log(`--dry-run: изменил бы ${[needInstruction ? 'промпт' : null, needModel ? 'модель' : null].filter(Boolean).join(' и ')}, но ничего не записываю.`);
            process.exit(EXIT.OK);
        }

        if (needModel) {
            try {
                const catalog = await listModels(session);
                if (catalog.length && !catalog.some(m => m.id === model)) {
                    die(`Неизвестная модель: ${model}. Доступны: ${catalog.map(m => m.id).join(', ')}`, EXIT.BAD_ARGS);
                }
            } catch (e) {
                if (e instanceof QwenApiError && e.code === 'auth') throw e;
                console.log(`Каталог моделей недоступен (${e.code || e.name}) — проверяю модель только сверкой после записи.`);
            }
        }

        console.log(`Записываю: ${[needInstruction ? 'промпт' : null, needModel ? 'модель' : null].filter(Boolean).join(' и ')} (одним запросом)...`);
        const res = await applyAccountConfig(session, want);
        if (res.instructionChanged) show('Промпт после записи', res.after.instruction);
        console.log(`Модель после записи: [${res.after.models.join(', ')}]`);
        console.log('Проверка после записи: совпадает.');
        console.log('Готово.');
        process.exit(EXIT.OK);
    } catch (e) {
        if (e instanceof QwenApiError) die(`Ошибка (${e.code}): ${e.message}`, ERROR_EXIT[e.code] || (e.code === 'forbidden' ? EXIT.LOGIN_FAILED : EXIT.API));
        die(`Непредвиденная ошибка: ${e && e.name}: ${e && e.message}`, EXIT.API);
    }
}

main();
