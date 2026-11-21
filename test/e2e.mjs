import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const proj = path.resolve(here, '..');
const dist = path.join(proj, '.output', 'chrome-mv3');
const imgPath = path.join(here, 'fixtures', 'test-image.jpg');
const profileDir = path.join(proj, 'test', '.tmp-profile');
const PORT = 18742;

fs.rmSync(profileDir, { recursive: true, force: true });

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  String(process.env.LOCALAPPDATA ?? '') + '\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
if (!executablePath) throw new Error('未找到可用的 Chrome 可执行文件');
console.log('browser:', executablePath);

let sseCalls = 0;
let imageEditCalls = 0;
let imageGenCalls = 0;
let openRouterChatCalls = 0;
let openRouterHadRefImage = false;
let chatNoModCalls = 0;
let genOnlyCalls = 0;
let chatSseCalls = 0;
let chat400Calls = 0;
let noV1FallbackCalls = 0;
let chatSseErrCalls = 0;

const MOCK_COMPILED_JSON = {
  category: '瑞士平面海报 · E2E SSE',
  tags: ['Swiss-Grid', 'Brutalist'],
  json_prompt: {
    subject: '黑白几何方块构成的非对称视觉中心',
    style_medium: '瑞士国际主义平面海报设计，高反差粗体排版质感',
    composition_camera: '12 栏非对称网格，居中偏左视觉锚点',
    lighting_atmosphere: '均匀平面印刷感，极简冷峻秩序',
    color_palette: '主色纯黑与米白，点缀高饱和朱红',
    details_texture: '微粗糙胶版印刷纸纹，锐利矢量边缘',
  },
  short_prompt:
    '瑞士国际主义平面海报，几何方块非对称视觉中心，12栏非对称网格，极简黑白米白配色配朱红点缀，胶版印刷纸纹，锐利边缘',
};

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(
      `<!doctype html><html><body style="margin:0;background:#f0f0f0;font-family:monospace">` +
        `<h1>VRC E2E Target Page</h1>` +
        `<img id="target" src="/img.jpg" width="720" style="display:block" />` +
        `</body></html>`,
    );
    return;
  }
  if (req.url === '/img.jpg') {
    res.setHeader('Content-Type', 'image/jpeg');
    fs.createReadStream(imgPath).pipe(res);
    return;
  }
  if (req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'qwen-vl-max' }] }));
    return;
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      sseCalls += 1;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
      });
      const jsonStr = JSON.stringify(MOCK_COMPILED_JSON);
      const mid = Math.floor(jsonStr.length / 2);
      const chunks = [
        { choices: [{ delta: { reasoning_content: 'Analyzing grid and palette...' } }] },
        { choices: [{ delta: { content: jsonStr.slice(0, mid) } }] },
        { choices: [{ delta: { content: jsonStr.slice(mid) } }] },
      ];
      let i = 0;
      const sendNext = () => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
          setTimeout(sendNext, 40);
        } else {
          res.write('data: [DONE]\n\n');
          res.end();
        }
      };
      sendNext();
    });
    return;
  }
  if (req.url === '/v1/images/edits' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      imageEditCalls += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: 'R0lGODlhAQABAAAAACw=' }] }));
    });
    return;
  }
  if (req.url === '/v1/images/generations' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      imageGenCalls += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: 'R0lGODlhAQABAAAAACw=' }] }));
    });
    return;
  }
  if (
    (req.url === '/openrouter/v1/images/edits' ||
      req.url === '/openrouter/v1/images/generations' ||
      req.url === '/chat-nomod/v1/images/edits' ||
      req.url === '/chat-sse/v1/images/edits' ||
      req.url === '/chat-sse/v1/images/generations' ||
      req.url === '/chat-400/v1/images/edits' ||
      req.url === '/chat-400/v1/images/generations' ||
      req.url === '/gen-only/v1/images/edits' ||
      req.url === '/gen-only/v1/chat/completions') &&
    req.method === 'POST'
  ) {
    req.resume();
    req.on('end', () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Not Found', code: 404 } }));
    });
    return;
  }
  if (req.url === '/openrouter/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      openRouterChatCalls += 1;
      try {
        const body = JSON.parse(raw);
        const content = body?.messages?.[0]?.content;
        openRouterHadRefImage =
          Array.isArray(content) &&
          content.some((p) => p?.type === 'image_url' && typeof p?.image_url?.url === 'string' && p.image_url.url.startsWith('data:'));
      } catch { /* ignore */ }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                images: [{ type: 'image_url', image_url: { url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' } }],
              },
            },
          ],
        }),
      );
    });
    return;
  }
  if (req.url === '/chat-nomod/v1/chat/completions' && req.method === 'POST') {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      chatNoModCalls += 1;
      const body = JSON.parse(raw);
      if (body.modalities) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { message: 'unsupported modalities' } }));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '![char](data:image/gif;base64,R0lGODlhAQABAAAAACw=)' } }],
        }),
      );
    });
    return;
  }
  if (req.url === '/gen-only/v1/images/generations' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      genOnlyCalls += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: 'R0lGODlhAQABAAAAACw=' }] }));
    });
    return;
  }
  if (req.url === '/chat-sse/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      chatSseCalls += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('data: {"choices":[{"delta":{"content":"![out]("}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"data:image/gif;base64,R0lGODlhAQABAAAAACw=)"}}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  if (req.url === '/chat-400/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      chat400Calls += 1;
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'bad model id' } }));
    });
    return;
  }
  if (req.url === '/no-v1/v1/images/edits' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      noV1FallbackCalls += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ b64_json: 'R0lGODlhAQABAAAAACw=' }] }));
    });
    return;
  }
  if (
    (req.url === '/chat-sse-err/v1/images/edits' || req.url === '/chat-sse-err/v1/images/generations') &&
    req.method === 'POST'
  ) {
    req.resume();
    req.on('end', () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: { message: 'Not Found', code: 404 } }));
    });
    return;
  }
  if (req.url === '/chat-sse-err/v1/chat/completions' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      chatSseErrCalls += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      res.write('data: {"error":{"message":"sse quota exceeded"}}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ error: { message: 'Not Found', code: 404 } }));
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
console.log(`local page: http://127.0.0.1:${PORT}/`);

const browser = await puppeteer.launch({
  executablePath,
  headless: false, // 真实窗口模式，保证扩展完整生命周期
  defaultViewport: { width: 1280, height: 800 },
  ignoreDefaultArgs: ['--disable-extensions'],
  enableExtensions: [dist], // CDP Extensions.loadUnpacked —— Chrome 137+ 移除 --load-extension 后的官方通道
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--disable-gpu',
    '--window-size=1280,800',
  ],
});

const results = [];
const check = (name, ok) => {
  results.push([name, ok]);
  console.log(`${ok ? '✅' : '❌'} ${name}`);
};

/** Read the full textContent of the first shadow host appended by the content script. */
const shadowText = (page) =>
  page.evaluate(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    return host ? host.shadowRoot.textContent : '';
  });

const shadowClick = (page, query, index = 0) =>
  page.evaluate(
    (q, idx) => {
      const host = [...document.body.children].find((el) => el.shadowRoot);
      if (!host?.shadowRoot) return false;
      const btns = [...host.shadowRoot.querySelectorAll('button')];
      const matches = btns.filter((b) => b.title === q || (b.textContent ?? '').includes(q));
      const btn = matches[idx];
      if (!btn) return false;
      btn.click();
      return true;
    },
    query,
    index,
  );

const shadowSetInput = (page, placeholderSub, value) =>
  page.evaluate(
    (sub, val) => {
      const host = [...document.body.children].find((el) => el.shadowRoot);
      const input = [...(host?.shadowRoot?.querySelectorAll('input') ?? [])].find((el) =>
        (el.placeholder ?? '').includes(sub),
      );
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, val);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    },
    placeholderSub,
    value,
  );

try {
  let swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 20000 },
  ).catch(() => null);
  if (!swTarget) {
    console.log('  当前 targets:', browser.targets().map((t) => `${t.type()}:${t.url()}`).join(' | '));
    throw new Error('未发现扩展 Service Worker target');
  }
  check('background service worker 已启动', Boolean(swTarget));

  const worker = await swTarget.worker();

  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 160)));
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

  // HUD 初始为隐藏空状态（未触发时 return null），等待 Shadow DOM 宿主挂载即可
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot),
    { timeout: 15000 },
  );
  check('content script 注入且 Shadow DOM HUD 挂载', true);

  // --- Module A: hover then Alt+RightClick trigger ---
  const img = await page.$('#target');
  const box = await img.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(
    (x, y) => {
      const el = document.getElementById('target');
      el.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          altKey: true,
          clientX: x,
          clientY: y,
        }),
      );
    },
    Math.round(box.x + box.width / 2),
    Math.round(box.y + box.height / 2),
  );
  console.log('  Alt+RightClick 已派发');

  // --- Module B: 0-token physics rendered & stops at manual confirmation ---
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          el.shadowRoot.textContent.includes('HARD FACTS') &&
          el.shadowRoot.textContent.includes('开始 Vision LLM 解构'),
      ),
    { timeout: 20000 },
  );
  await new Promise((r) => setTimeout(r, 250));
  const confirmText = await shadowText(page);
  check('Physics Bar（Hard Facts）已渲染且停留在待确认态（未自动调 LLM）', !confirmText.includes('LLM 编译失败'));

  check('色板 Hex 输出（5 色 #XXXXXX）', (confirmText.match(/#[0-9A-Fa-f]{6}/g) ?? []).length >= 5);
  check('宽高比 + 推荐 --ar 标签', /--ar/.test(confirmText));
  check('明度三分区（SHADOWS / MIDTONES / HIGHLIGHTS）', /SHADOWS/.test(confirmText) && /MIDTONES/.test(confirmText) && /HIGHLIGHTS/.test(confirmText));
  check('光调标签（Balanced Flat / Low-Key 等）', /Balanced Flat|Low-Key|High-Key|Chiaroscuro/.test(confirmText));
  check('尺寸读取（800×600）', /800\s*×\s*600/.test(confirmText));

  // --- Click confirm button to trigger LLM -> friendly error without API Key ---
  await shadowClick(page, '开始 Vision LLM 解构');
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) => el.shadowRoot && el.shadowRoot.textContent.includes('API Key'),
      ),
    { timeout: 20000 },
  );
  check('手动确认后调用后台 → 无 Key 友好报错', true);

  await page.screenshot({ path: path.join(here, 'acceptance-hud.png') });
  console.log('screenshot → test/acceptance-hud.png');

  // --- Alt+Q trigger ---
  await shadowClick(page, '关闭');
  await page.waitForFunction(
    () => ![...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('HARD FACTS')),
    { timeout: 5000 },
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyQ');
  await page.keyboard.up('Alt');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('HARD FACTS')),
    { timeout: 10000 },
  );
  check('Alt+Q 快捷键触发 HUD 成功', true);

  // --- Settings Modal: configure main Vision API (with model fetch) + optional Image Gen + triggerMode ---
  await shadowClick(page, '设置');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('BYOK SETTINGS')),
    { timeout: 5000 },
  );
  await shadowSetInput(page, 'api.openai.com', `http://127.0.0.1:${PORT}/v1`);
  await shadowSetInput(page, 'sk-…', 'sk-e2e-test');
  await shadowClick(page, '拉取模型', 0);
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('已拉取 2 个模型')),
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    const sel = host.shadowRoot.querySelector('select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    setter?.call(sel, 'qwen-vl-max');
    sel?.dispatchEvent(new Event('change', { bubbles: true }));
  });

  // Expand optional Image Gen config and set OpenAI-Compatible image model
  await shadowClick(page, 'IMAGE GEN');
  await shadowSetInput(page, 'dall-e-3', 'gpt-image-mock');

  await shadowClick(page, '两者同时启用');
  await shadowClick(page, 'SAVE SETTINGS');
  await new Promise((r) => setTimeout(r, 300));
  const savedCfg = await worker.evaluate(() => chrome.storage.local.get('vrc_settings'));
  check(
    'Settings 拉取模型、可选生图模型与触发模式保存成功',
    savedCfg?.vrc_settings?.triggerMode === 'both' &&
      savedCfg?.vrc_settings?.model === 'qwen-vl-max' &&
      savedCfg?.vrc_settings?.imageGenModel === 'gpt-image-mock',
  );

  // --- Floating [+] badge trigger -> Parallel Optional: Extract Character Asset + SSE Stream Compile ---
  await shadowClick(page, '关闭');
  await page.mouse.move(5, 5);
  await new Promise((r) => setTimeout(r, 250));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 4 });
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.textContent === '[+]'),
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    const b = [...document.body.children].find((el) => el.textContent === '[+]');
    b?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('提取人物资产图')),
    { timeout: 10000 },
  );
  check('悬浮 [+] 徽章触发进入待确认态成功', true);

  // Step A (Parallel Optional): extract 50/50 character asset image directly from confirm card
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('人物资产图已存入全局资产库')),
    { timeout: 10000 },
  );
  check('并行可选：直接提取人物资产图并存入全局资产库', imageEditCalls === 1);

  // Step A2 (Parallel Optional): anime-to-real direct character asset extraction from confirm card
  await shadowClick(page, '漫转真人资产图');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('漫转真人 ')),
    { timeout: 10000 },
  );
  check('并行可选：直接生成漫转真人资产图并存入全局资产库', imageEditCalls === 2);

  // Step B (Parallel Optional): click to run SSE streaming Vision LLM compilation
  await shadowClick(page, '开始 Vision LLM 解构');
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          el.shadowRoot.textContent.includes('JSON PROMPT') &&
          el.shadowRoot.textContent.includes('SHORT PROMPT'),
      ),
    { timeout: 15000 },
  );
  const readyText = await shadowText(page);
  check(
    'SSE 流式解构（含思考分片 + 空闲重置）并渲染双区块（JSON + 精简版）成功',
    sseCalls === 1 &&
      readyText.includes('瑞士平面海报 · E2E SSE') &&
      readyText.includes('按 JSON 提示词生图') &&
      readyText.includes('按精简版提示词生图') &&
      readyText.includes('瑞士国际主义平面海报，几何方块非对称视觉中心') &&
      !readyText.includes('自定义主体'),
  );
  check(
    'JSON 与精简提示词均固定写入图像比例（aspect_ratio + 画幅比例）',
    readyText.includes('"aspect_ratio": "4:3"') && readyText.includes('画幅比例 4:3'),
  );

  await page.screenshot({ path: path.join(here, 'acceptance-hud.png') });
  console.log('screenshot → test/acceptance-hud.png');

  // Generate image from Short Prompt using saved character asset as reference (垫图)
  await shadowClick(page, '按精简版提示词生图');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('从人物资产库挑选垫图')),
    { timeout: 5000 },
  );
  await page.evaluate(() => {
    const host = [...document.body.children].find((el) => el.shadowRoot);
    const card = [...host.shadowRoot.querySelectorAll('div')].find((d) =>
      (d.title ?? '').includes('点击设为垫图'),
    );
    card?.click();
  });
  await shadowClick(page, '生成图片', 1);
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('下载 PNG')),
    { timeout: 10000 },
  );
  check('选用历史人物资产图作为垫图生成图片成功', imageEditCalls === 3);

  // Verify HistoryDrawer reads the SSE-compiled record from extension-origin IndexedDB
  await shadowClick(page, '历史记录');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('瑞士平面海报 · E2E SSE')),
    { timeout: 5000 },
  );
  check('History 抽屉读取全局 IndexedDB 记录成功', true);

  await shadowClick(page, '人物资产 (');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('50/50 角色')),
    { timeout: 5000 },
  );
  const assetsTabText = await shadowText(page);
  check(
    '人物资产列表不暴露后台提示词“复制提示词”按钮',
    assetsTabText.includes('下载 PNG') && !assetsTabText.includes('复制提示词'),
  );

  // --- OpenRouter / chat-completions fallback when /images/edits & /images/generations return 404 ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}/openrouter/v1/chat/completions`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('✓ 已提取人物资产图并存入资产库')),
    { timeout: 10000 },
  );
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          [...el.shadowRoot.querySelectorAll('button')].some(
            (b) => (b.textContent ?? '').trim() === '提取人物资产图' && !b.disabled,
          ),
      ),
    { timeout: 5000 },
  );
  check(
    'OpenRouter 404 回退 /chat/completions（保留垫图 + 规范化 Base URL）提取人物资产图成功',
    openRouterChatCalls === 1 && openRouterHadRefImage,
  );

  // --- /chat/completions 400 modalities retry + markdown image response ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}/chat-nomod/v1`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          [...el.shadowRoot.querySelectorAll('button')].some(
            (b) => (b.textContent ?? '').trim() === '提取人物资产图' && !b.disabled,
          ),
      ),
    { timeout: 10000 },
  );
  check(
    'Chat 生图 400 modalities 自动降级重试并解析 Markdown 图像成功',
    chatNoModCalls === 2,
  );

  // --- Fallback to /images/generations when both /images/edits and /chat/completions return 404 ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}/gen-only/v1`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          [...el.shadowRoot.querySelectorAll('button')].some(
            (b) => (b.textContent ?? '').trim() === '提取人物资产图' && !b.disabled,
          ),
      ),
    { timeout: 10000 },
  );
  check(
    '纯 /images/generations 端点在 /images/edits 与 /chat/completions 均 404 时回退成功',
    genOnlyCalls === 1,
  );

  // --- SSE stream response from /chat/completions image gen ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}/chat-sse/v1`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          [...el.shadowRoot.querySelectorAll('button')].some(
            (b) => (b.textContent ?? '').trim() === '提取人物资产图' && !b.disabled,
          ),
      ),
    { timeout: 10000 },
  );
  check('Chat 生图返回 SSE (text/event-stream) 时解析图像成功', chatSseCalls === 1);

  // --- /chat/completions 400 error should not be masked by /images/generations 404 ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}/chat-400/v1`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('bad model id')),
    { timeout: 10000 },
  );
  check(
    'Chat 生图 400 错误在 /images/generations 404 时不被掩盖（透传真实 400 错误）',
    chat400Calls === 2,
  );

  // --- Root Base URL without /v1 automatically tries /v1 ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          [...el.shadowRoot.querySelectorAll('button')].some(
            (b) => (b.textContent ?? '').trim() === '提取人物资产图' && !b.disabled,
          ),
      ),
    { timeout: 10000 },
  );
  check('根路径 Base URL 未填 /v1 时自动补全 /v1 生图成功', imageEditCalls === 4);

  // --- Sub-path Base URL without /v1 falls back to /v1 on 404 ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}/no-v1`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () =>
      [...document.body.children].some(
        (el) =>
          el.shadowRoot &&
          [...el.shadowRoot.querySelectorAll('button')].some(
            (b) => (b.textContent ?? '').trim() === '提取人物资产图' && !b.disabled,
          ),
      ),
    { timeout: 10000 },
  );
  check('子路径 Base URL 未填 /v1 且 404 时回退 /v1 生图成功', noV1FallbackCalls === 1);

  // --- All endpoints 404 summarizes all attempted endpoints ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: { ...obj.vrc_settings, imageGenBaseUrl: url },
    });
  }, `http://127.0.0.1:${PORT}/all-404/v1`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('已尝试端点：')),
    { timeout: 10000 },
  );
  const all404Text = await shadowText(page);
  check(
    '全部端点 404 时清晰汇总已尝试端点',
    all404Text.includes('/all-404/v1/images/edits (404)') &&
      all404Text.includes('/all-404/v1/chat/completions (404)') &&
      all404Text.includes('/all-404/v1/images/generations (404)'),
  );

  // --- SSE stream error payload surfaces real error message ---
  await worker.evaluate(async (url) => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: {
        ...obj.vrc_settings,
        imageGenModel: 'gpt-image-mock',
        imageGenBaseUrl: url,
      },
    });
  }, `http://127.0.0.1:${PORT}/chat-sse-err/v1`);
  await shadowClick(page, '提取人物资产图');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('sse quota exceeded')),
    { timeout: 10000 },
  );
  check('Chat 生图 SSE 返回 error 载荷时透传真实错误信息', chatSseErrCalls === 1);

  // --- Empty model fails explicitly without calling Vision API ---
  await worker.evaluate(async () => {
    const obj = await chrome.storage.local.get('vrc_settings');
    await chrome.storage.local.set({
      vrc_settings: {
        ...obj.vrc_settings,
        model: '',
      },
    });
  });
  await shadowClick(page, '关闭');
  await page.waitForFunction(
    () => ![...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('HARD FACTS')),
    { timeout: 5000 },
  );
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 3 });
  await page.keyboard.down('Alt');
  await page.keyboard.press('KeyQ');
  await page.keyboard.up('Alt');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('开始 Vision LLM 解构')),
    { timeout: 10000 },
  );
  await shadowClick(page, '开始 Vision LLM 解构');
  await page.waitForFunction(
    () => [...document.body.children].some((el) => el.shadowRoot && el.shadowRoot.textContent.includes('未配置视觉模型')),
    { timeout: 5000 },
  );
  check('视觉模型为空时显式报错提示用户填写（不静默回退）', sseCalls === 1);
} catch (e) {
  results.push(['流程异常中断', false]);
  console.error('❌ 异常:', e);
  try {
    const page = (await browser.pages()).pop();
    if (page) await page.screenshot({ path: path.join(here, 'acceptance-fail.png') });
  } catch { /* ignore */ }
} finally {
  await browser.close();
  server.close();
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n===== 验收结果: ${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length ? 1 : 0);
