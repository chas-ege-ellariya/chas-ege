'use strict';

/**
 * Юнит-тесты для lib/mathjs_functions.js (Node.js / QUnit)
 * Подключаются через require() в run-node-tests.js
 *
 * lib/mathjs_functions.js не входит в build/lib/chas-lib.js: в браузере он
 * загружается отдельно, после mathjs. Поэтому здесь создаётся свой экземпляр
 * mathjs, и файл вместе с lib/mathjs_helpers.js выполняется над ним внутри
 * отдельной функции, не затрагивая глобальную область.
 */

const fs = require('fs');
const path = require('path');

function loadMathWithChasFunctions() {
    const { create, all } = require('mathjs');
    const math = create(all);
    const read = name => fs.readFileSync(path.join(__dirname, '..', 'lib', name), 'utf8');
    new Function('math', read('mathjs_helpers.js') + '\n' + read('mathjs_functions.js'))(math);
    return math;
}

module.exports = function registerMathjsFunctionsTests(QUnit) {

    const math = loadMathWithChasFunctions();

    // Встроенный вывод mathjs — для сравнения
    const { create, all } = require('mathjs');
    const plainMath = create(all);

    const tex = expr => math.parse(expr).toTex();

    // ============================================================
    //  nthRoot: вывод в TeX  (lib/mathjs_functions.js)
    // ============================================================
    QUnit.module('mathjs Functions: nthRoot');

    QUnit.test('nthRoot: корень второй степени выводится без показателя', function (assert) {
        assert.equal(tex('nthRoot(16, 2)'), '\\sqrt{16}', 'nthRoot(16, 2)');
        assert.equal(tex('nthRoot(16)'), '\\sqrt{16}', 'nthRoot с одним аргументом');
        assert.equal(tex('nthRoot(1024, 2)'), tex('sqrt(1024)'), 'совпадает с выводом sqrt');
        assert.equal(tex('nthRoot(x + 1, 2)'), tex('sqrt(x + 1)'), 'выражение под корнем');
        assert.equal(tex('nthRoot(0.5, 2)'), '\\sqrt{0.5}', 'десятичная дробь');
    });

    QUnit.test('nthRoot: корень первой степени выводится как подкоренное выражение', function (assert) {
        assert.equal(tex('nthRoot(5, 1)'), '5', 'число');
        assert.equal(tex('nthRoot(x, 1)'), tex('x'), 'переменная');
        assert.equal(tex('nthRoot(x + 1, 1)'), '\\left(' + tex('x + 1') + '\\right)', 'сумма берётся в скобки');
        assert.equal(tex('2 * nthRoot(x + 1, 1)'), tex('2 * (x + 1)'), 'в произведении скобки сохраняют смысл');
        assert.equal(tex('nthRoot(-8, 1)'), '\\left(-8\\right)', 'отрицательное число берётся в скобки');
    });

    QUnit.test('nthRoot: остальные показатели выводятся как во встроенном mathjs', function (assert) {
        const expressions = [
            'nthRoot(8, 3)', 'nthRoot(1024, 5)', 'nthRoot(1024, 10)', 'nthRoot(-8, 3)', 'nthRoot(x + 1, 3)',
            'nthRoot(x, n)', 'nthRoot(2^5, 5)', 'nthRoot(a / b, 4)', 'nthRoot(x, 2 + 1)', 'nthRoot(x, 20)',
            'nthRoot(nthRoot(x, 3), 4)', 'nthRoot(16, 0.5)', 'nthRoot(x, -2)',
        ];
        const different = expressions.filter(expr => tex(expr) !== plainMath.parse(expr).toTex());
        assert.deepEqual(different, [], 'вывод не изменился');
        assert.equal(tex('nthRoot(8, 3)'), '\\sqrt[3]{8}', 'nthRoot(8, 3)');
    });

    QUnit.test('nthRoot: показатель, заданный выражением, не упрощается', function (assert) {
        assert.equal(tex('nthRoot(x, 1 + 1)'), plainMath.parse('nthRoot(x, 1 + 1)').toTex(), 'показатель 1 + 1 остаётся как есть');
        assert.equal(tex('nthRoot(x, n)'), plainMath.parse('nthRoot(x, n)').toTex(), 'показатель-переменная остаётся как есть');
    });

    QUnit.test('nthRoot: вложенные корни и корни внутри выражений', function (assert) {
        assert.equal(tex('nthRoot(nthRoot(x, 2), 3)'), '\\sqrt[3]{' + tex('sqrt(x)') + '}', 'квадратный корень под кубическим');
        assert.equal(tex('nthRoot(32, 5) * nthRoot(4, 2) / nthRoot(27, 3)'),
            plainMath.parse('nthRoot(32, 5) * sqrt(4) / nthRoot(27, 3)').toTex(), 'выражение из шаблона 26745 с показателем 2');
        assert.equal(tex('nthRoot(x, 2) ^ 2'), tex('sqrt(x) ^ 2'), 'корень в степени');
    });

    QUnit.test('nthRoot: значение не изменилось', function (assert) {
        assert.equal(math.evaluate('nthRoot(16, 2)'), 4, 'nthRoot(16, 2)');
        assert.equal(math.evaluate('nthRoot(16)'), 4, 'nthRoot(16)');
        assert.equal(math.evaluate('nthRoot(5, 1)'), 5, 'nthRoot(5, 1)');
        assert.equal(math.evaluate('nthRoot(-8, 3)'), -2, 'корень нечётной степени из отрицательного числа');
        assert.equal(math.evaluate('nthRoot(1024, 10)'), 2, 'nthRoot(1024, 10)');
    });

    QUnit.test('nthRoot: вывод сохраняется после упрощения выражения', function (assert) {
        const simplified = math.simplify('1 * nthRoot(x, 2)', [{ l: '1 * n1', r: 'n1' }]);
        assert.equal(simplified.toTex(), tex('sqrt(x)'), 'math.simplify не теряет настройку вывода');
    });
};
