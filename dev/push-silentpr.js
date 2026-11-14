#!/usr/bin/env node
'use strict';
// push-silentpr: перенос silentpr/<target>/<branch> из source-форка в целевые ремоуты.
// Реализация на NodeJS (основной язык проекта) — без bash-экранирования и ловушек stdin.
const { spawnSync } = require('child_process');
const readline = require('readline');

// ---------- git-обёртки ----------
function git(args) { return spawnSync('git', args, { encoding: 'utf8' }); }
function gitOut(args) { const r = git(args); return r.status === 0 ? r.stdout : null; }
function gitOk(args) { return git(args).status === 0; }
// inherit: git сам рисует цветной diff / пейджер / прогресс пуша в терминал
function gitInherit(args) { return spawnSync('git', args, { stdio: 'inherit' }).status; }
function gitQuiet(args) { return spawnSync('git', args, { stdio: ['ignore', 'ignore', 'ignore'] }).status; }
function revparse(ref) { const o = gitOut(['rev-parse', ref]); return o ? o.trim() : null; }
function shortSha(sha) { const o = gitOut(['rev-parse', '--short', sha]); return o ? o.trim() : sha; }

// ---------- ввод ----------
// terminal:false — терминал в каноническом режиме (пейджер git живёт, echo делает драйвер).
// Строки складываем в очередь: при ответах через pipe они приходят заранее,
// и rl.question потерял бы те, что пришли до вызова вопроса. Очередь ничего не теряет.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lineQueue = [];
let lineWaiter = null;
let inputClosed = false;
rl.on('line', (l) => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(l); }
  else lineQueue.push(l);
});
rl.on('close', () => {
  inputClosed = true;
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(null); }
});
function ask(prompt) {
  process.stdout.write(prompt);
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (inputClosed) return Promise.resolve(null);
  return new Promise((res) => { lineWaiter = res; });
}
function eofExit() { console.log('\n⏹️  Ввод закончился (EOF) — выходим.'); process.exit(0); }

// ---------- классификация пробелов ----------
function normWs(buf) {
  const lines = buf.toString('utf8').split('\n')
    .map((l) => l.replace(/^[ \t\r\f\v]+|[ \t\r\f\v]+$/g, ''));
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}
function showFileBuf(sha, f) {
  const r = spawnSync('git', ['show', `${sha}:${f}`]);
  return r.status === 0 ? r.stdout : null;
}
// '' | 'whitespace-only' | 'trimmed-whitespace only'
function classifyWhitespace(a, b) {
  if (gitOk(['diff', '--quiet', a, b])) return '';
  const ign = gitOut(['diff', '--ignore-all-space', '--ignore-blank-lines', a, b]);
  if (ign === null || ign.length > 0) return '';
  const names = gitOut(['diff', '--name-only', '--no-renames', '-z', a, b]) || '';
  let trimmed = true;
  for (const f of names.split('\0').filter(Boolean)) {
    if (!gitOk(['cat-file', '-e', `${a}:${f}`]) || !gitOk(['cat-file', '-e', `${b}:${f}`])) { trimmed = false; break; }
    const fa = showFileBuf(a, f), fb = showFileBuf(b, f);
    if (fa === null || fb === null || normWs(fa) !== normWs(fb)) { trimmed = false; break; }
  }
  return trimmed ? 'trimmed-whitespace only' : 'whitespace-only';
}
function wsNote(a, b) { const n = classifyWhitespace(a, b); if (n) console.log(`⚙️  ${n}`); }

// ---------- показ изменений ----------
function commitMessage(sha) {
  console.log(`💬 Сообщение коммита ${shortSha(sha)}:`);
  gitInherit(['log', '-1', '--format=%B', sha]);
}
function showDiff(a, b) {
  const cnt = gitOut(['rev-list', '--count', '--first-parent', `${a}..${b}`]);
  if (cnt && cnt.trim() === '1') commitMessage(b);
  wsNote(a, b);
  gitInherit(['diff', '--color=always', '--stat', '--patch', a, b]);
}
function showCommit(c) {
  commitMessage(c);
  wsNote(`${c}^`, c);
  gitInherit(['diff', '--color=always', '--stat', '--patch', `${c}^`, c]);
}

// ---------- интерактивный вопрос ----------
const HELP = [
  '  y - Запушить source в target (или обновить source если target опережает)',
  '  n - Пропустить этот silentpr',
  '  d - Удалить изменения: force reset source к target (сбросить к состоянию target)',
  '  s - Разбить на коммиты: принимать по одному, от старых к новым',
  '  ? - Показать эту справку',
];
async function askAction(ref, targetRemote, branchName, sourceSha, targetSha, targetExists) {
  console.log('');
  console.log(`📋 SilentPR: ${ref}`);
  console.log(`   Целевой ремоут: ${targetRemote}`);
  console.log(`   Имя ветки: ${branchName}`);
  console.log(`   Source SHA: ${sourceSha.slice(0, 9)}`);
  if (targetExists) {
    console.log(`   Target SHA: ${targetSha.slice(0, 9)}`);
    if (gitOk(['merge-base', '--is-ancestor', sourceSha, targetSha]))
      console.log('   Статус: ⚠️  Target опережает source (можно обновить source)');
    else if (gitOk(['merge-base', '--is-ancestor', targetSha, sourceSha]))
      console.log('   Статус: 🚀 Source опережает target (можно запушить)');
    else
      console.log('   Статус: ❌ Ветки diverged (нужен merge/rebase)');
  } else {
    console.log('   Target SHA: (не существует)');
    console.log('   Статус: 🆕 Target не существует');
  }

  // Diff перед вопросом + база для split-режима (действие s)
  let splitBase = '', splitWhy = '', dispA = '', dispB = '';
  console.log('');
  if (targetExists) {
    if (gitOk(['merge-base', '--is-ancestor', sourceSha, targetSha])) {
      console.log('📄 Diff source → target (что получит source при обновлении):');
      dispA = sourceSha; dispB = targetSha;
      splitWhy = 's недоступен: source отстаёт от target, пушить нечего (y обновит source)';
    } else {
      console.log('📄 Diff target → source (что уйдёт в target при пуше):');
      dispA = targetSha; dispB = sourceSha;
      if (gitOk(['merge-base', '--is-ancestor', targetSha, sourceSha])) splitBase = targetSha;
      else splitWhy = 's недоступен: ветки diverged, сначала нужен merge/rebase';
    }
  } else {
    let base = '', baseName = '';
    for (const cand of ['devel', 'main', 'master']) {
      const r = `refs/remotes/${targetRemote}/${cand}`;
      if (gitOk(['rev-parse', '--verify', '--quiet', r])) {
        const mb = gitOut(['merge-base', sourceSha, r]);
        if (mb && mb.trim()) { base = mb.trim(); baseName = `${targetRemote}/${cand}`; break; }
      }
    }
    if (!base && gitQuiet(['fetch', '--quiet', targetRemote, 'devel']) === 0) {
      const mb = gitOut(['merge-base', sourceSha, 'FETCH_HEAD']);
      if (mb && mb.trim()) { base = mb.trim(); baseName = `${targetRemote}/devel`; }
    }
    if (base) {
      console.log(`📄 Diff от общей базы с ${baseName} (ветка новая):`);
      dispA = base; dispB = sourceSha; splitBase = base;
    } else {
      console.log('📄 Общей базы нет, показываю последний коммит source:');
      gitInherit(['show', '--color=always', '--stat', sourceSha]);
      splitWhy = 's недоступен: нет общей базы для отсчёта коммитов';
    }
  }
  if (dispA) showDiff(dispA, dispB);

  console.log('');
  console.log('Действие? [y/n/d/s/?]');
  HELP.forEach((l) => console.log(l));
  console.log('');
  for (;;) {
    const choice = await ask('Ваш выбор: ');
    if (choice === null) eofExit();
    const c = choice.trim();
    if (/^[yY]$/.test(c)) return { action: 'y', splitBase };
    if (/^[nN]$/.test(c)) return { action: 'n', splitBase };
    if (/^[dD]$/.test(c)) return { action: 'd', splitBase };
    if (/^[sS]$/.test(c)) {
      if (splitBase) return { action: 's', splitBase };
      console.log(splitWhy);
      continue;
    }
    if (c === '?') {
      console.log('');
      console.log('Доступные действия:');
      HELP.forEach((l) => console.log(l));
      console.log('');
      continue;
    }
    console.log(`Неизвестный выбор: ${choice}`);
  }
}

// ---------- split-режим ----------
async function splitPush(base, targetRemote, branchName, sourceSha) {
  const total = (gitOut(['rev-list', '--count', '--first-parent', `${base}..${sourceSha}`]) || '0').trim();
  console.log('');
  console.log(`✂️  Split-режим: коммитов к разбору: ${total} (от старых к новым)`);
  const list = (gitOut(['rev-list', '--reverse', '--first-parent', `${base}..${sourceSha}`]) || '')
    .split('\n').filter(Boolean);
  let i = 0, pushed = 0;
  for (const c of list) {
    i++;
    console.log('');
    console.log(`── Коммит ${i}/${total} ──`);
    showCommit(c);
    let choice;
    for (;;) {
      choice = await ask('Принять этот коммит? [y/n/?] ');
      if (choice === null) eofExit();
      const cc = choice.trim();
      if (/^[yYnN]$/.test(cc)) { choice = cc; break; }
      if (cc === '?') {
        console.log('  y - запушить этот коммит и перейти к следующему');
        console.log('  n - остановиться (остальные коммиты останутся только в source)');
        continue;
      }
      console.log(`Неизвестный выбор: ${choice}`);
    }
    if (choice === 'n' || choice === 'N') {
      console.log('⏹️  Останавливаемся: без этого коммита дальше по истории идти нельзя.');
      break;
    }
    console.log(`🚀 Пушим коммит ${shortSha(c)} в '${targetRemote}' как '${branchName}'...`);
    if (gitInherit(['push', targetRemote, `${c}:refs/heads/${branchName}`]) === 0) {
      console.log('✅ Коммит принят и запушен');
      pushed++;
    } else {
      console.log('❌ Ошибка пуша — останавливаемся.');
      break;
    }
  }
  console.log(`📊 Принято коммитов: ${pushed}/${total}`);
  console.log('-----------------------------------');
}

// ---------- main ----------
async function main() {
  let sourceRemote = '', interactive = false;
  for (const a of process.argv.slice(2)) {
    if (a === '-i' || a === '--interactive') interactive = true;
    else sourceRemote = a;
  }
  if (!sourceRemote) {
    console.log(`Использование: ${process.argv[1]} [-i] <source_remote>`);
    console.log(`Пример: ${process.argv[1]} chas-ege-ulyana`);
    console.log('Флаги:');
    console.log('  -i, --interactive  Интерактивный режим (y/n/d/s для каждого silentpr)');
    process.exit(1);
  }

  console.log(`🔄 Подтягиваем свежие ветки из ${sourceRemote}...`);
  gitInherit(['fetch', '--quiet', '--prune', sourceRemote]);

  const refs = (gitOut(['for-each-ref', '--format=%(refname:short)', `refs/remotes/${sourceRemote}/silentpr`]) || '')
    .split('\n').filter(Boolean);
  for (const ref of refs) {
    const parts = ref.split('/');
    if (parts.length < 4) continue;
    const targetRemote = parts[2];
    const branchName = parts.slice(3).join('/');
    const sourceSha = revparse(`refs/remotes/${ref}`);
    if (!sourceSha) continue;

    gitQuiet(['fetch', '--quiet', targetRemote, branchName]);
    const targetSha = revparse(`refs/remotes/${targetRemote}/${branchName}`);
    const targetExists = !!targetSha;

    // Ветки совпадают — молча пропускаем в любом режиме
    if (targetExists && sourceSha === targetSha) continue;

    if (interactive) {
      const { action, splitBase } = await askAction(ref, targetRemote, branchName, sourceSha, targetSha, targetExists);
      if (action === 'n') {
        console.log(`⏭️  Пропускаем ${ref}`);
        console.log('-----------------------------------');
        continue;
      }
      if (action === 'd') {
        console.log('🗑️  Force reset source к target...');
        if (targetExists) {
          if (gitQuiet(['push', '--force', sourceRemote, `${targetSha}:refs/heads/silentpr/${targetRemote}/${branchName}`, '--quiet']) === 0)
            console.log('✅ Source сброшен к состоянию target');
          else
            console.log('❌ Ошибка force reset');
        } else {
          console.log('❌ Target не существует, нечего сбрасывать');
        }
        console.log('-----------------------------------');
        continue;
      }
      if (action === 's') {
        await splitPush(splitBase, targetRemote, branchName, sourceSha);
        continue;
      }
      // action === 'y' — продолжаем с обычным пушем
    }

    if (targetExists && gitOk(['merge-base', '--is-ancestor', sourceSha, targetSha])) {
      console.log('🔄 Target опережает source, обновляем source...');
      gitQuiet(['push', sourceRemote, `${targetSha}:refs/heads/silentpr/${targetRemote}/${branchName}`, '--quiet']);
      console.log('✅ Source обновлён');
      console.log('-----------------------------------');
      continue;
    }

    console.log(`🚀 Отправляем коммит ${sourceSha} в ремоут '${targetRemote}' как ветку '${branchName}'...`);
    // Пушим именно SHA коммита (обход GitHub cross-fork push protection)
    if (gitInherit(['push', targetRemote, `${sourceSha}:refs/heads/${branchName}`]) === 0)
      console.log('✅ Успешно запушено!');
    else
      console.log('❌ Ошибка пуша. Возможно, нет прав или ветка diverged.');
    console.log('-----------------------------------');
  }
  rl.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
