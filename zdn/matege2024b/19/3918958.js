(function () {
	'use strict';
	retryWhileError(function () {
		NAinfo.requireApiVersion(0, 2);

		let key = '3918958';
		let preference1 = ['5digit', '4digit'];
		let preference2 = ['theLargest', 'theLeast'];
		let rand1 = getSelectedPreferenceFromList(key, preference1);
		let rand2 = getSelectedPreferenceFromList(key, preference2);

		let digitWord = ['пятизначное', 'четырёхзначное'][rand1];
		let direction = ['наибольшее', 'наименьшее'][rand2];

		let divisor = sl(12, 99);
		let minVal = [10000, 1000][rand1];
		let maxVal = [99999, 9999][rand1];

		let current, step;
		if (rand2 === 0) {
			// наибольшее
			current = maxVal - (maxVal % divisor);
			step = -divisor;
		} else {
			// наименьшее
			current = minVal + ((divisor - (minVal % divisor)) % divisor);
			step = divisor;
		}

		function digitProduct(number) {
			return Array.from(String(number), Number).reduce((product, digit) => product * digit, 1);
		}

		// Границы произведения цифр, как у ФИПИ: (85; 95), (50; 75)
		let minProd = 5 * sl(2, 19);
		let maxProd = minProd + 5 * sl(2, 6);
		let answer = current;
		while (answer >= minVal && answer <= maxVal) {
			let product = digitProduct(answer);
			if (product > minProd && product < maxProd) {
				break;
			}
			answer += step;
		}
		genAssert(answer >= minVal && answer <= maxVal, 'Не найдено подходящее число');
		NAtask.setTask({
			text: 'Найдите ' + direction + ' ' + digitWord + ' число, кратное $' + divisor + '$, произведение цифр которого больше $' + minProd +
				'$, но меньше $' + maxProd + '$.',
			answers: answer,
			preference: [preference1, preference2],
		});
		NAtask.modifiers.allDecimalsToStandard();
	}, 2000);
})();
//zer00player
//3918958
// 3BCC6E, 6DC37A
