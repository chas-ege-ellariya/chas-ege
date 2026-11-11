'use strict';

/**
 * Юнит-тесты для lib/mathjs_rules.js (Node.js / QUnit)
 * Подключаются через require() в run-node-tests.js
 *
 * lib/mathjs_rules.js не входит в build/lib/chas-lib.js: в браузере он
 * загружается отдельно, после mathjs. Поэтому здесь создаётся свой экземпляр
 * mathjs, и файл вместе с lib/mathjs_helpers.js выполняется над ним внутри
 * отдельной функции, не затрагивая глобальную область.
 */

const fs = require('fs');
const path = require('path');

function loadMathjsRules(math) {
    const read = name => fs.readFileSync(path.join(__dirname, '..', 'lib', name), 'utf8');
    return new Function('math', read('mathjs_helpers.js') + '\n' + read('mathjs_rules.js') + '\nreturn mathjsRules;')(math);
}

module.exports = function registerMathjsRulesTests(QUnit) {

    const { create, all } = require('mathjs');
    const math = create(all);
    const mathjsRules = loadMathjsRules(math);

    const tex = expr => math.parse(expr).toTex();
    const simplified = expr => math.simplify(expr, mathjsRules.nthRoot2sqrt);

    // ============================================================
    //  mathjsRules.nthRoot2sqrt  (lib/mathjs_rules.js)
    // ============================================================
    QUnit.module('mathjs Rules: nthRoot2sqrt');

    QUnit.test('nthRoot2sqrt: корень второй степени становится квадратным', function (assert) {
        assert.equal(simplified('nthRoot(16, 2)').toString(), 'sqrt(16)', 'nthRoot(16, 2)');
        assert.equal(simplified('nthRoot(16)').toString(), 'sqrt(16)', 'nthRoot с одним аргументом');
        assert.equal(simplified('nthRoot(x + 1, 2)').toString(), 'sqrt(x + 1)', 'выражение под корнем');
        assert.equal(simplified('nthRoot(1024, 2)').toTex(), '\\sqrt{1024}', 'в TeX показателя нет');
        assert.equal(tex('nthRoot(1024, 2)'), '\\sqrt[2]{1024}', 'без правила показатель 2 выводится');
    });

    QUnit.test('nthRoot2sqrt: корень первой степени снимается', function (assert) {
        assert.equal(simplified('nthRoot(5, 1)').toString(), '5', 'число');
        assert.equal(simplified('nthRoot(x, 1)').toString(), 'x', 'переменная');
        assert.equal(simplified('2 * nthRoot(x + 1, 1)').toTex(), tex('2 * (x + 1)'), 'сумма в произведении остаётся в скобках');
        assert.equal(simplified('nthRoot(x + 1, 1) ^ 2').toTex(), tex('(x + 1) ^ 2'), 'сумма в степени остаётся в скобках');
    });

    QUnit.test('nthRoot2sqrt: остальные показатели не затрагиваются', function (assert) {
        const expressions = [
            'nthRoot(8, 3)', 'nthRoot(1024, 5)', 'nthRoot(1024, 10)', 'nthRoot(-8, 3)', 'nthRoot(x + 1, 3)',
            'nthRoot(x, n)', 'nthRoot(2 ^ 5, 5)', 'nthRoot(a / b, 4)', 'nthRoot(x, 20)', 'nthRoot(x, 12)',
            'nthRoot(x, 21)', 'nthRoot(16, 0.5)', 'nthRoot(x, -2)', 'nthRoot(x, -1)',
        ];
        const changed = expressions.filter(expr => simplified(expr).toTex() !== tex(expr));
        assert.deepEqual(changed, [], 'вывод в TeX не изменился');
    });

    QUnit.test('nthRoot2sqrt: показатель, заданный выражением, не вычисляется', function (assert) {
        assert.equal(simplified('nthRoot(x, 1 + 1)').toString(), 'nthRoot(x, 1 + 1)', 'показатель 1 + 1');
        assert.equal(simplified('nthRoot(x, n)').toString(), 'nthRoot(x, n)', 'показатель-переменная');
    });

    QUnit.test('nthRoot2sqrt: вложенные корни и корни внутри выражений', function (assert) {
        assert.equal(simplified('nthRoot(nthRoot(x, 2), 3)').toString(), 'nthRoot(sqrt(x), 3)', 'квадратный корень под кубическим');
        assert.equal(simplified('nthRoot(nthRoot(x, 1), 2)').toString(), 'sqrt(x)', 'оба правила подряд');
        assert.equal(simplified('nthRoot(32, 5) * nthRoot(4, 2) / nthRoot(27, 3)').toTex(),
            tex('nthRoot(32, 5) * sqrt(4) / nthRoot(27, 3)'), 'выражение из шаблона 26745 с показателем 2');
        assert.equal(simplified('nthRoot(1024, 5) nthRoot(1024, 10) / nthRoot(1024, 2)').toTex(),
            tex('nthRoot(1024, 5) nthRoot(1024, 10) / sqrt(1024)'), 'неявное умножение сохраняется');
    });

    QUnit.test('nthRoot2sqrt: выражение без корней не меняется', function (assert) {
        // math.simplify сам убирает лишние скобки при любом наборе правил, поэтому
        // сравнение идёт с упрощением по правилу, которое ни к чему не применимо
        const idle = expr => math.simplify(expr, [{ l: 'noSuchFunction(n1)', r: 'n1' }]);
        const expressions = ['2 x + 3', 'sqrt(x) / 2', 'sin(x) ^ 2 + 1', '(a + b) / (c - d)', '2 * 3 * x', 'x - -3'];
        const changed = expressions.filter(expr => simplified(expr).toTex() !== idle(expr).toTex());
        assert.deepEqual(changed, [], 'вывод в TeX тот же, что и без правила');
    });

    QUnit.test('nthRoot2sqrt: значение выражения сохраняется', function (assert) {
        const expressions = ['nthRoot(16, 2)', 'nthRoot(16)', 'nthRoot(5, 1)', 'nthRoot(32, 5) * nthRoot(4, 2) / nthRoot(27, 3)',
            'nthRoot(nthRoot(64, 2), 3)', '2 * nthRoot(3 + 6, 2) - nthRoot(7, 1)'];
        const different = expressions.filter(expr => Math.abs(simplified(expr).evaluate() - math.evaluate(expr)) > 1e-12);
        assert.deepEqual(different, [], 'значения до и после упрощения совпадают');
    });

    QUnit.test('nthRoot2sqrt: встроенный вывод nthRoot не переопределён', function (assert) {
        assert.equal(typeof math.nthRoot.toTex, 'undefined', 'у math.nthRoot нет собственного toTex');
    });
};
