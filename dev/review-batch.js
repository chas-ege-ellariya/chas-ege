#!/usr/bin/env node
'use strict';

/**
 * Подготовка пачки пуллреквестов к ревью (md/review_batch_script.md).
 *
 * Для каждого PR — своя рабочая копия (git worktree, без ветки), слитая с devel локально,
 * своя сборка и npm test; эталон — такая же копия devel. В конце — таблица:
 * смёржен ли PR, сливается ли с devel, конфликты между PR пачки, число тестов против devel.
 *
 *   node dev/review-batch.js 3711 3717 3798          # подготовить пачку
 *   node dev/review-batch.js --no-build 3711 3717    # только карта: смёржен, конфликты
 *   node dev/review-batch.js --clean                 # удалить рабочие копии
 *
 * Ключи:
 *   --remote R   основной репозиторий (upstream)
 *   --base B     ветка, с которой сливать (devel)
 *   --dir D      где заводить рабочие копии (../review-batch от корня репозитория)
 *   --jobs N     сколько сборок одновременно (4)
 *   --no-build   без рабочих копий, сборок и тестов
 *   --clean      удалить рабочие копии из --dir и выйти
 *
 * Нужны git 2.38+ (merge-tree --write-tree) и, для сборок, grunt-cli и canvas в node_modules
 * основной копии (npm install --no-save grunt-cli canvas). Рабочие копии получают node_modules
 * симлинком; npm install внутри них не запускается. Ни одна ветка не создаётся и не меняется:
 * копии отцеплены (--detach), слияние с devel — коммит только в них.
 *
 * Код возврата: 0 — всё собралось и тесты прошли; 1 — ошибка ключей или git;
 * 2 — у какого-то PR сборка или тесты не прошли, тестов меньше, чем в devel,
 * или файл тестов не загрузился.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const usage = 'Использование: node dev/review-batch.js [--remote R] [--base B] [--dir D] [--jobs N] [--no-build] PR…\n'
	+ '               node dev/review-batch.js [--dir D] --clean';

function fail(message) {
	console.error(message);
	process.exit(1);
}

function parseArgs(argv) {
	const opts = { remote: 'upstream', base: 'devel', dir: null, jobs: 4, build: true, clean: false, prs: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const value = () => {
			if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail(`${a} требует значения.\n${usage}`);
			return argv[++i];
		};
		if (a === '--remote') opts.remote = value();
		else if (a === '--base') opts.base = value();
		else if (a === '--dir') opts.dir = value();
		else if (a === '--jobs') {
			opts.jobs = Number(value());
			if (!Number.isInteger(opts.jobs) || opts.jobs < 1) fail('--jobs — целое число не меньше 1.');
		} else if (a === '--no-build') opts.build = false;
		else if (a === '--clean') opts.clean = true;
		else if (a === '-h' || a === '--help') { console.log(usage); process.exit(0); }
		else if (/^[1-9][0-9]*$/.test(a)) opts.prs.push(a);
		else fail(`Непонятный аргумент ${a}: номер PR — число.\n${usage}`);
	}
	opts.prs = [...new Set(opts.prs)].sort((x, y) => x - y);
	if (!opts.clean && !opts.prs.length) fail(usage);
	return opts;
}

function git(args, cwd) {
	return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitOk(args, cwd) {
	return git(args, cwd).status === 0;
}

function gitOut(args, cwd) {
	const r = git(args, cwd);
	if (r.status !== 0) fail(`git ${args.join(' ')}:\n${r.stderr.trim()}`);
	return r.stdout.trim();
}

/** Пути зарегистрированных рабочих копий репозитория. */
function worktrees(root) {
	return gitOut(['worktree', 'list', '--porcelain'], root).split('\n')
		.filter(line => line.startsWith('worktree ')).map(line => path.resolve(line.slice('worktree '.length)));
}

/** Удаляет рабочую копию, только если это рабочая копия этого репозитория. */
function removeWorktree(root, dir) {
	if (!fs.existsSync(dir)) return;
	if (!worktrees(root).includes(path.resolve(dir))) {
		fail(`${dir} есть, но это не рабочая копия этого репозитория: не трогаю. Укажите другой --dir.`);
	}
	gitOut(['worktree', 'remove', '--force', dir], root);
}

/** Файлы с конфликтом при слиянии a и b (пусто — сливаются чисто). */
function conflictFiles(root, a, b) {
	const r = git(['merge-tree', '--write-tree', '--name-only', a, b], root);
	if (r.status === 0) return [];
	if (r.status !== 1) fail(`git merge-tree ${a} ${b}:\n${r.stderr.trim()}`);
	// Вывод: хеш дерева, затем файлы с конфликтом, затем пустая строка и сообщения
	const lines = r.stdout.split('\n');
	const end = lines.indexOf('', 1);
	return lines.slice(1, end === -1 ? undefined : end);
}

/**
 * Коммит «PR, слитый с base» — без рабочей копии и без ветки (объект в .git, его уберёт gc).
 * Пары PR сравниваются так, а не головами: головы со старой базой «конфликтуют» из-за
 * чужих правок devel, которых нет в одной из них.
 */
function mergedWithBase(root, ref, baseRef) {
	const tree = gitOut(['merge-tree', '--write-tree', baseRef, ref], root).split('\n')[0];
	return gitOut(['-c', 'user.name=review-batch', '-c', 'user.email=review-batch@localhost',
		'commit-tree', tree, '-p', baseRef, '-p', ref, '-m', 'review-batch: ' + ref], root);
}

/** Запускает команду, пишет вывод в лог, возвращает код и вывод. */
function run(cmd, args, cwd, log) {
	return new Promise(resolve => {
		const child = spawn(cmd, args, { cwd, env: { ...process.env, FORCE_COLOR: '0' } });
		let out = '';
		child.stdout.on('data', d => { out += d; });
		child.stderr.on('data', d => { out += d; });
		child.on('close', code => {
			fs.appendFileSync(log, `$ ${cmd} ${args.join(' ')}\n${out}\n[код ${code}]\n\n`);
			resolve({ code, out });
		});
		child.on('error', err => resolve({ code: -1, out: String(err) }));
	});
}

/** Сборка и тесты в рабочей копии. */
async function buildAndTest(dir) {
	const log = path.join(dir, 'review-batch.log');
	fs.writeFileSync(log, '');
	const result = { tests: null, failed: null, notLoaded: [], grunt: true, small: false, log };
	const grunt = await run(path.join(dir, 'node_modules', '.bin', 'grunt'), [], dir, log);
	if (grunt.code !== 0) {
		result.grunt = false;
		return result;
	}
	const bundle = path.join(dir, 'build', 'lib', 'chas-uijs.js');
	// Без chas-lib бандл около 2,3 МБ вместо 6,3 МБ (md/how_to_review_PR.md, «Несколько PR сразу»)
	result.small = !fs.existsSync(bundle) || fs.statSync(bundle).size < 4e6;
	const test = await run('node', ['dev/run-node-tests.js'], dir, log);
	const total = test.out.match(/Всего тестов: (\d+), Прошло: (\d+), Упало: (\d+)/);
	if (total) {
		result.tests = Number(total[1]);
		result.failed = Number(total[3]);
	}
	result.notLoaded = [...test.out.matchAll(/Не удалось загрузить ([^:\n]+)/g)].map(m => m[1]);
	result.testCode = test.code;
	return result;
}

/** Выполняет задачи не больше чем по n одновременно. */
async function pool(tasks, n) {
	const results = new Array(tasks.length);
	let next = 0;
	const worker = async () => {
		while (next < tasks.length) {
			const i = next++;
			results[i] = await tasks[i]();
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker));
	return results;
}

function table(rows) {
	const widths = rows[0].map((_, c) => Math.max(...rows.map(r => String(r[c]).length)));
	return rows.map(r => r.map((cell, c) => String(cell).padEnd(widths[c])).join('  ').trimEnd()).join('\n');
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	const root = gitOut(['rev-parse', '--show-toplevel'], process.cwd());
	const dir = path.resolve(root, opts.dir || path.join('..', 'review-batch'));

	if (opts.clean) {
		const ours = worktrees(root).filter(w => path.dirname(w) === dir);
		ours.forEach(w => gitOut(['worktree', 'remove', '--force', w], root));
		console.log(`Удалено рабочих копий: ${ours.length} (${dir}).`);
		return 0;
	}
	if (opts.build && !fs.existsSync(path.join(root, 'node_modules', '.bin', 'grunt'))) {
		fail('Нет node_modules/.bin/grunt: npm install && npm install --no-save grunt-cli canvas (одной командой, см. md/how_to_review_PR.md).');
	}

	const { remote, base } = opts;
	const baseRef = `refs/remotes/${remote}/${base}`;
	console.error(`Скачиваю ${remote}/${base} и головы PR…`);
	// refspec явный: при урезанном remote.<name>.fetch иначе refs/remotes/… не обновится
	gitOut(['fetch', '-q', remote, `+refs/heads/${base}:${baseRef}`, `+refs/pull/*/head:refs/remotes/${remote}/pr/*`], root);
	const baseSha = gitOut(['rev-parse', '--short', baseRef], root);

	const prs = opts.prs.map(n => {
		const ref = `refs/remotes/${remote}/pr/${n}`;
		if (!gitOk(['rev-parse', '-q', '--verify', ref], root)) return { n, ref, missing: true };
		const merged = gitOk(['merge-base', '--is-ancestor', ref, baseRef], root);
		return { n, ref, head: gitOut(['rev-parse', '--short', ref], root), merged };
	});
	const open = prs.filter(p => !p.missing && !p.merged);

	open.forEach(p => {
		p.baseConflict = conflictFiles(root, p.ref, baseRef);
		p.withBase = p.baseConflict.length ? null : mergedWithBase(root, p.ref, baseRef);
	});
	const pairs = [];
	for (let i = 0; i < open.length; i++) {
		for (let j = i + 1; j < open.length; j++) {
			const [a, b] = [open[i], open[j]];
			// Сравниваются «a + devel» и «b + devel»; PR, который с devel не сливается, в пары не идёт:
			// его голова «конфликтует» с другими и из-за чужих правок devel
			if (!a.withBase || !b.withBase) continue;
			const files = conflictFiles(root, a.withBase, b.withBase);
			if (files.length) pairs.push({ a: a.n, b: b.n, files });
		}
	}

	let baseline = null;
	if (opts.build && open.length) {
		fs.mkdirSync(dir, { recursive: true });
		const prepare = (wt, ref) => {
			removeWorktree(root, wt);
			gitOut(['worktree', 'add', '-q', '--detach', wt, ref], root);
			fs.symlinkSync(path.join(root, 'node_modules'), path.join(wt, 'node_modules'));
		};
		const baseDir = path.join(dir, base);
		prepare(baseDir, baseRef);
		for (const p of open) {
			p.dir = path.join(dir, 'pr-' + p.n);
			prepare(p.dir, p.ref);
			// Слияние с devel — только в отцепленной копии: так видно, что будет после мержа
			if (!p.baseConflict.length) {
				const merge = git(['-c', 'user.name=review-batch', '-c', 'user.email=review-batch@localhost',
					'merge', '-q', '--no-edit', baseRef], p.dir);
				if (merge.status !== 0) fail(`Слияние ${p.n} с ${base} не удалось:\n${merge.stderr.trim()}`);
			}
		}
		console.error(`Сборки и тесты: рабочих копий ${open.length + 1}, одновременно до ${opts.jobs}, в ${dir}…`);
		const results = await pool([baseDir, ...open.map(p => p.dir)].map(d => () => buildAndTest(d)), opts.jobs);
		baseline = results[0];
		open.forEach((p, i) => {
			p.result = results[i + 1];
			// Голова без слияния: её тесты сравнивают с её базой, а не с devel (md/how_to_review_PR.md)
			if (p.baseConflict.length) p.result.oldBase = gitOut(['merge-base', p.ref, baseRef], root).slice(0, 9);
		});
	}

	const describeBuild = r => {
		if (!r) return ['', ''];
		if (!r.grunt) return ['grunt упал', `см. ${r.log}`];
		const notes = [];
		if (r.small) notes.push('бандл меньше 4 МБ — без chas-lib? запустить grunt ещё раз');
		if (r.notLoaded.length) notes.push('не загрузился ' + r.notLoaded.join(', '));
		if (r.failed) notes.push(`упало ${r.failed}`);
		if (r.tests === null) notes.push(`итога тестов нет, см. ${r.log}`);
		let tests = r.tests === null ? '?' : String(r.tests);
		if (r.oldBase) notes.push(`собрана голова PR без слияния: число тестов сравнивать с её базой ${r.oldBase}`);
		else if (baseline && baseline.tests !== null && r !== baseline && r.tests !== null) {
			const d = r.tests - baseline.tests;
			tests += ` (${d >= 0 ? '+' : ''}${d})`;
			if (d < 0) notes.push(`тестов меньше, чем в ${base}`);
		}
		return [tests, notes.join('; ')];
	};

	const rows = [['PR', 'голова', 'состояние', `слияние с ${base}`, 'тестов', 'замечания']];
	if (baseline) rows.push([base, baseSha, '', '', ...describeBuild(baseline)]);
	for (const p of prs) {
		if (p.missing) { rows.push([p.n, '—', `нет ${remote}/pr/${p.n}`, '', '', '']); continue; }
		if (p.merged) { rows.push([p.n, p.head, 'смёржен', '', '', '']); continue; }
		const mergeCell = p.baseConflict.length ? 'конфликт: ' + p.baseConflict.join(' ') : 'чисто';
		const [tests, notes] = describeBuild(p.result);
		rows.push([p.n, p.head, 'не смёржен', mergeCell, tests, notes]);
	}
	console.log(table(rows));
	console.log('\nКонфликты между PR пачки (каждый слит с ' + base + '):' + (pairs.length ? '' : ' нет'));
	pairs.forEach(({ a, b, files }) => console.log(`  ${a} и ${b}: ${files.join(' ')}`));
	const skipped = open.filter(p => !p.withBase).map(p => p.n);
	if (skipped.length && open.length > 1) {
		console.log(`  Не проверялись пары с ${skipped.join(', ')}: сначала конфликт с ${base}.`);
	}
	console.log('\n«не смёржен» — это и открытый, и закрытый без мержа PR: по git их не различить.');
	if (baseline) {
		console.log(`Сборки: ${dir}/<${base} | pr-N>/build; раннер копии — node ${dir}/pr-N/build/dev/run-node-template.js`);
		console.log(`Удалить копии: node dev/review-batch.js${opts.dir ? ' --dir ' + opts.dir : ''} --clean`);
	}

	const bad = r => r && (!r.grunt || r.small || r.notLoaded.length || r.failed || r.tests === null
		|| (!r.oldBase && baseline && baseline.tests !== null && r.tests < baseline.tests));
	return [baseline, ...open.map(p => p.result)].some(bad) ? 2 : 0;
}

main().then(code => process.exit(code), err => {
	console.error(err && err.stack ? err.stack : err);
	process.exit(1);
});
