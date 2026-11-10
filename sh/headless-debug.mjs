#!/usr/bin/env node

/**
 * Headless debug script for chas-ege templates
 * 
 * Opens dist/sh/otladka.html in Chrome,
 * generates tasks from a template multiple times, and exports LaTeX code.
 * 
 * Prerequisites:
 * 1. Build the project: `grunt`
 * 2. Install puppeteer: `npm install puppeteer@^23.0.0` (compatible with Node.js 22.7.0)
 * 
 * Usage:
 *   node headless-debug.mjs --filepath <path-to-template> [--iterations <count>] [--headless]
 *       [--browser <path>] [--temp-profile] [--fast] [--json] [--png <count>] [--out <dir>]
 *
 *   --fast         do not wait for MathJax and for the page to settle: many generations quickly;
 *                  the LaTeX is exported all the same (it is made from the source of the task)
 *   --json         write <out>/results.json: for every generation its number, the preference
 *                  combination (or null), the text and the answers of the task (as in vopr.txt
 *                  and vopr.ver) and the errors of the page since the previous generation
 *   --png <count>  save the drawings (canvas) of the first <count> generations
 *                  as <out>/task-<n>.png (task-<n>-<k>.png if a task has several drawings)
 *   --out <dir>    the directory for --json and --png, headless-debug-output by default
 *
 * Example:
 *   node sh/headless-debug.mjs --filepath zdn/matege2024p/10/15.js --browser `which chromium` --temp-profile --iterations 5 --headless
 *   node sh/headless-debug.mjs --filepath zdn/matoge2024/16/392118.js --browser `which chromium` --temp-profile --headless \
 *       --iterations 300 --fast --json --png 16 --out /tmp/392118
 * The path to the browser depends on the machine: `which chromium`, `which google-chrome`,
 * /opt/pw-browsers/chromium and so on.

 */

import puppeteer from 'puppeteer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let projectRoot = process.cwd();
while (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
    const parent = path.dirname(projectRoot);
    if (parent === projectRoot) {
        // Fallback to script location if package.json not found
        projectRoot = path.resolve(__dirname, '..');
        break;
    }
    projectRoot = parent;
}

// Parse command line arguments
const args = process.argv.slice(2);
let filepath = '';
let iterations = 1;
let headless = false; // Default to visible mode
let browserPath = '';
let tempProfile = false;
let fast = false;
let writeJson = false;
let pngCount = 0;
let outDir = 'headless-debug-output';

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--filepath' && args[i + 1]) {
        filepath = args[i + 1];
        i++;
    } else if (args[i] === '--iterations' && args[i + 1]) {
        iterations = parseInt(args[i + 1], 10);
        i++;
    } else if (args[i] === '--headless') {
        headless = true;
    } else if (args[i] === '--browser' && args[i + 1]) {
        browserPath = args[i + 1];
        i++;
    } else if (args[i] === '--temp-profile') {
        tempProfile = true;
    } else if (args[i] === '--fast') {
        fast = true;
    } else if (args[i] === '--json') {
        writeJson = true;
    } else if (args[i] === '--png' && args[i + 1]) {
        pngCount = parseInt(args[i + 1], 10);
        i++;
    } else if (args[i] === '--out' && args[i + 1]) {
        outDir = args[i + 1];
        i++;
    }
}



if (!filepath) {
    console.error('Usage: node headless-debug.mjs --filepath <path> [--iterations <count>] [--headless]'
        + ' [--browser <path>] [--temp-profile] [--fast] [--json] [--png <count>] [--out <dir>]');
    process.exit(1);
}

const absoluteOutDir = path.resolve(process.cwd(), outDir);
if (writeJson || pngCount > 0) {
    fs.mkdirSync(absoluteOutDir, { recursive: true });
}
const results = []; // for --json
let pageErrors = []; // errors of the page since the previous generation, for --json

const absoluteFilepath = path.resolve(process.cwd(), filepath);
const filepathRelativeToRoot = path.relative(projectRoot, absoluteFilepath);
const filepathForBrowser = '../../' + filepathRelativeToRoot.split(path.sep).join('/');

const otladkaPath = path.join(projectRoot, 'dist', 'sh', 'otladka.html');
const urlJsonData = {
    filepath: filepathForBrowser,
    autostartFile: true
};
const hashString = '#' + encodeURIComponent(JSON.stringify(urlJsonData));
const fileUrl = 'file://' + otladkaPath + hashString;

console.log(`Mode: ${headless ? 'headless' : 'visible'}`);

(async () => {
    const launchOptions = {
        headless: headless ? 'new' : false,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--allow-file-access-from-files', '--disable-web-security']
    };

    let tempDir = null;

    if (browserPath) {
        launchOptions.executablePath = browserPath;
    }

    if (tempProfile) {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer_dev_profile-'));
        launchOptions.userDataDir = tempDir;
    }

    const browser = await puppeteer.launch(launchOptions);
    
    // Grant clipboard permissions BEFORE creating the page
  const context = browser.defaultBrowserContext();
  await context.overridePermissions(fileUrl, ['clipboard-read', 'clipboard-write']);

  const page = await browser.newPage();

  // Listen to console messages from the browser
  const spamPatterns = [
    'Скрипт по адресу',
    'Таблица стилей',
    'отработал',
    'загружен',
    'добавлен',
    'запрошен',
    'debug',
    'verbose',
    'Не удалось выделить настройки'
  ];
  
  page.on('console', msg => {
    const text = msg.text();
    const type = msg.type();
    
    // Always log errors and warnings, even if they match spam patterns
    if (type === 'error' || type === 'warning') {
      console.log(`[BROWSER ${type.toUpperCase()}]`, text);
      if (type === 'error') pageErrors.push(text);
      return;
    }
    
    if (spamPatterns.some(pattern => text.includes(pattern))) {
      return;
    }
    console.log(text);
  });
  
  page.on('pageerror', error => {
    console.log(`[PAGE ERROR]`, error.message);
    pageErrors.push(error.message);
  });
    
    // We will intercept copyToClipboard AFTER page scripts have loaded
    
    console.log(`Opening ${fileUrl}...`);
    
    try {
        await page.goto(fileUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('Page loaded successfully.');
        
        // Intercept copyToClipboard AFTER page scripts have loaded
        await page.evaluate(() => {
            const originalCopyToClipboard = window.copyToClipboard;
            window.copyToClipboard = function(text) {
                window.__lastExportedText = text;
                console.log('=== LaTeX CODE START ===');
                console.log(text);
                console.log('=== LaTeX CODE END ===');
                window.__latexExported = true;
                if (originalCopyToClipboard) {
                    return originalCopyToClipboard.call(this, text);
                }
            };
        });
    } catch (error) {
        console.error('Failed to load page:', error.message);
        await browser.close();
        process.exit(1);
    }
    
    // Wait for page to be ready
    if (!fast) {
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // First generation (auto-started by otladka.js via parsedJSON.autostartFile)
    try {
        await page.waitForFunction(
            () => {
                const question = document.getElementById('question');
                return question && 
                       question.innerHTML !== 'Задание составляется, подождите...' &&
                       question.innerHTML !== '';
            },
            { timeout: 30000 }
        );
    } catch (error) {
        console.log('Timeout waiting for first generation, continuing...');
    }

    // Check for preference after first generation
    let preference = await page.evaluate(() => {
        return window.vopr && window.vopr.preference ? window.vopr.preference : null;
    });
    
    let combinations = [];
    
    if (preference && Array.isArray(preference) && preference.length > 0) {
        console.error(`\n[PREFERENCE DETECTED] Task has preferences: ${JSON.stringify(preference, null, 2)}`);
        
        // generateVariations - handles both flat and nested arrays (Cartesian product)
        function generateVariations(arrays) {
            if (!arrays || arrays.length === 0) return [];
            if (!Array.isArray(arrays[0])) {
                return arrays.map(item => [item]);
            }
            let result = arrays[0].map(item => [item]);
            for (let i = 1; i < arrays.length; i++) {
                const temp = [];
                for (let existingComb of result) {
                    for (let newElement of arrays[i]) {
                        temp.push([...existingComb, newElement]);
                    }
                }
                result = temp;
            }
            return result;
        }

        combinations = generateVariations(preference);
        console.error(`\n[VARIATIONS] Total combinations: ${combinations.length}`);
        combinations.forEach((combo, idx) => {
            console.error(`  Combination ${idx + 1}: ${JSON.stringify(combo)}`);
        });
        
        // Setup Proxy for nabor.preferences to force specific combinations
        // getListedPreference reads nabor.preferences[key] — the Proxy returns our
        // current combination array regardless of which key the task uses
        await page.evaluate(() => {
            if (!window.__originalNaborPreferences) {
                window.__originalNaborPreferences = window.nabor.preferences;
                window.nabor.preferences = new Proxy({}, {
                    get(target, key) {
                        return window.__currentPreferences || [];
                    }
                });
            }
        });
    } else {
        console.error(`\n[NO PREFERENCE] Task has no preferences defined.`);
    }
    
    // Determine total runs: if preferences exist, generate `iterations` examples for each combination
    const totalRuns = combinations.length > 0 ? combinations.length * iterations : iterations;
    
    for (let i = 0; i < totalRuns; i++) {
        let comboIdx = 0;
        let iterIdx = i;
        
        if (combinations.length > 0) {
            comboIdx = Math.floor(i / iterations);
            iterIdx = i % iterations;
        }
        
        const runLabel = combinations.length > 0 
            ? `Combination ${comboIdx + 1}/${combinations.length} [${JSON.stringify(combinations[comboIdx])}], Example ${iterIdx + 1}/${iterations}`
            : `Example ${i + 1}/${iterations}`;
        console.log(`\n=== ${runLabel} ===`);
        
        if (combinations.length > 0) {
            // Set current combination
            await page.evaluate((combo) => {
                window.__currentPreferences = combo;
            }, combinations[comboIdx]);
        }
        
        // Regenerate task. The very first generation already happened (auto-started by otladka.js),
        // but before the preferences were forced, so with preferences it is made once more
        if (i > 0 || combinations.length > 0) {
            await page.evaluate(() => {
                createFromFile();
            });
        }
        
        // Wait for question to be generated
        try {
            await page.waitForFunction(
                () => {
                    const question = document.getElementById('question');
                    return question && 
                           question.innerHTML !== 'Задание составляется, подождите...' &&
                           question.innerHTML !== '';
                },
                { timeout: 30000 }
            );
        } catch (error) {
            console.log('Timeout waiting for question generation, continuing...');
        }

        // Wait for MathJax
        if (!fast) {
            await new Promise(resolve => setTimeout(resolve, 1500));
        }

        // Take the task and its drawings before the LaTeX export: it replaces the canvases by images
        if (writeJson || i < pngCount) {
            const snapshot = await page.evaluate((wantPng) => {
                const canvases = [...document.querySelectorAll('#question canvas')].filter(canvas => canvas.width > 0);
                return {
                    text: window.vopr.txt,
                    answers: window.vopr.ver,
                    png: wantPng ? canvases.map(canvas => canvas.toDataURL('image/png')) : [],
                };
            }, i < pngCount);
            const pngFiles = snapshot.png.map((dataUrl, k) => {
                const file = snapshot.png.length > 1 ? `task-${i + 1}-${k + 1}.png` : `task-${i + 1}.png`;
                fs.writeFileSync(path.join(absoluteOutDir, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
                return file;
            });
            results.push({
                number: i + 1,
                preference: combinations.length > 0 ? combinations[comboIdx] : null,
                text: snapshot.text,
                answers: snapshot.answers,
                errors: pageErrors,
                png: pngFiles,
            });
            pageErrors = [];
        }

        // Output preference marker before LaTeX block
        if (combinations.length > 0) {
            console.log(`=== PREFERENCE: ${JSON.stringify(combinations[comboIdx])} ===`);
        }
        // Click LaTeX export button
        await page.evaluate(() => {
            window.__latexExported = false;
            if (typeof startQuickExportToTex === 'function') {
                startQuickExportToTex();
            } else {
                console.error('startQuickExportToTex is not defined');
            }
        });
        
        try {
            await page.waitForFunction(
                () => window.__latexExported === true,
                { timeout: 30000 }
            );

            // Check if the generated LaTeX is empty (just headers)
            const isEmpty = await page.evaluate(() => {
                const text = window.__lastExportedText || '';
                let cleaned = text.replace(/Текст задания:\s*/g, '')
                                  .replace(/Ответ:\s*/g, '')
                                  .replace(/Решение:\s*/g, '')
                                  .replace(/\\begin\{tabular\}[\s\S]*?\\end\{tabular\}/g, '')
                                  .replace(/\\\[|\\\]/g, '')
                                  .replace(/\$\$/g, '')
                                  .replace(/\s+/g, '');
                return cleaned.length === 0;
            });

            if (isEmpty) {
                console.log('Empty task detected. Stopping generation.');
                console.log('=== LaTeX CODE START ===');
                console.log('ЗАДАЧА_НЕ_ГЕНЕРИРУЕТСЯ');
                console.log('=== LaTeX CODE END ===');
                break;
            }
        } catch (error) {
            console.log('Timeout waiting for LaTeX export completion.');
        }
    }
    
    if (writeJson) {
        const jsonPath = path.join(absoluteOutDir, 'results.json');
        fs.writeFileSync(jsonPath, JSON.stringify({ filepath: filepathRelativeToRoot, results }, null, 1));
        console.log(`\nResults written to ${jsonPath}`);
    }

    await browser.close();
    if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
    console.log('\n=== DONE ===');
    process.exit(0);
})();
