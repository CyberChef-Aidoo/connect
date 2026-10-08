import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const ORIGIN = 'http://172.20.10.13:8443';

function launch(port, dir) {
  return spawn(EDGE, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--disable-extensions',
    'about:blank',
  ], { stdio: 'ignore' });
}

async function waitPort(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return;
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Edge did not start');
}

async function connect(port) {
  const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const page = pages.find((entry) => entry.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let next = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  function send(method, params = {}) {
    const id = ++next;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  return { ws, send };
}

async function evaluate(send, expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'page error');
  }
  return result.result.value;
}

async function size(send, width, height) {
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 900,
  });
  await new Promise((resolve) => setTimeout(resolve, 180));
}

const dir = await mkdtemp(path.join(os.tmpdir(), 'portal-library-'));
const child = launch(9341, dir);
try {
  await waitPort(9341);
  const { ws, send } = await connect(9341);
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: ORIGIN });
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    ready = await evaluate(send, `document.body.innerText.includes('Library')`);
    if (ready) break;
  }
  await evaluate(send, `(() => {
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent === 'Library');
    button?.click();
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const widths = [320, 375, 390, 768, 1024, 1440];
  const viewports = [
    ...widths.map((width) => ({ width, height: 900, label: String(width) })),
    { width: 1280, height: 720, label: '1280x720' },
    { width: 1366, height: 768, label: '1366x768' },
    { width: 640, height: 360, label: '1280x720@200%' },
    { width: 683, height: 384, label: '1366x768@200%' },
  ];
  const boxes = [];
  for (const viewport of viewports) {
    await size(send, viewport.width, viewport.height);
    boxes.push(await evaluate(send, `(() => {
      const root = document.documentElement;
      const search = document.querySelector('.library-search input');
      const searchBox = search?.getBoundingClientRect();
      const wide = [...document.querySelectorAll('body *')].filter((el) => {
        const box = el.getBoundingClientRect();
        return box.width > 0 && box.right > root.clientWidth + 1;
      }).slice(0, 5).map((el) => el.tagName + '.' + String(el.className).slice(0, 30));
      return {
        label: ${JSON.stringify(viewport.label)},
        scroll: root.scrollWidth,
        client: root.clientWidth,
        cards: Boolean(document.querySelector('.file-card, .file-cards')),
        table: Boolean(document.querySelector('.library-table')),
        heading: Boolean(document.querySelector('.library-head h2')),
        searchClipped: search ? search.scrollWidth > search.clientWidth + 1 : null,
        searchWide: searchBox ? Math.round(searchBox.width) : 0,
        permanentCreate: Boolean(document.querySelector('input[placeholder="New collection"], label') && [...document.querySelectorAll('label')].some((label) => label.textContent.includes('New collection'))),
        wide,
      };
    })()`));
  }

  await size(send, 1440, 900);
  const behavior = await evaluate(send, `(() => new Promise(async (resolve) => {
    const notes = {};
    const collection = [...document.querySelectorAll('button')].find((item) => item.textContent === '+ Collection');
    collection.focus();
    collection.click();
    await new Promise((r) => setTimeout(r, 150));
    const dialog = document.querySelector('dialog.library-dialog[open]');
    notes.dialogOpen = Boolean(dialog);
    notes.dialogTitle = dialog?.querySelector('h2')?.textContent || '';
    dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    dialog?.close();
    await new Promise((r) => setTimeout(r, 100));
    notes.focusAfterDialog = document.activeElement === collection;

    const filters = [...document.querySelectorAll('button')].find((item) => item.textContent.startsWith('Filters'));
    filters.focus();
    filters.click();
    await new Promise((r) => setTimeout(r, 100));
    notes.filterOpen = Boolean(document.querySelector('.filter-popover'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    notes.filterClosed = !document.querySelector('.filter-popover');
    notes.focusAfterFilter = document.activeElement === filters;

    const search = document.querySelector('.library-search input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(search, '___no-such-library-file___');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));
    notes.empty = document.body.innerText.includes('No files match.');
    setter.call(search, '');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 500));

    const box = document.querySelector('.library-table input[type="checkbox"], .file-card input[type="checkbox"]');
    if (box) {
      box.click();
      await new Promise((r) => setTimeout(r, 100));
      notes.selected = document.body.innerText.includes('selected');
      box.click();
    } else notes.selected = 'no-files';

    const more = document.querySelector('button[aria-label^="More actions"]');
    if (more) {
      more.focus();
      more.click();
      await new Promise((r) => setTimeout(r, 100));
      notes.menu = Boolean(document.querySelector('.file-menu'));
      notes.menuDownloadOutside = Boolean(more.parentElement?.querySelector('a.file-download'));
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      notes.focusAfterMenu = document.activeElement === more;
    } else notes.menu = 'no-files';

    const name = document.querySelector('.filename');
    if (name) {
      const original = name.textContent;
      name.textContent = 'a-very-long-filename-without-spaces-'.repeat(8) + '.txt';
      const tags = name.parentElement?.querySelector('.file-tags') || name.parentElement.appendChild(Object.assign(document.createElement('ul'), { className: 'file-tags' }));
      for (let index = 0; index < 6; index += 1) {
        const chip = document.createElement('li');
        chip.className = 'chip';
        chip.textContent = 'long-tag-name-' + index + '-that-should-wrap';
        tags.appendChild(chip);
      }
      await new Promise((r) => setTimeout(r, 50));
      notes.longScroll = document.documentElement.scrollWidth;
      notes.longClient = document.documentElement.clientWidth;
      name.textContent = original;
    }
    resolve(notes);
  }))()`);

  await size(send, 390, 844);
  const sheet = await evaluate(send, `(() => new Promise(async (resolve) => {
    const filters = [...document.querySelectorAll('button')].find((item) => item.textContent.startsWith('Filters'));
    filters.focus();
    filters.click();
    await new Promise((r) => setTimeout(r, 200));
    const dialog = document.querySelector('dialog.library-sheet');
    resolve({ open: Boolean(dialog?.open), title: dialog?.querySelector('h3')?.textContent || '' });
  }))()`);
  const phone = await evaluate(send, `(() => {
    const search = document.querySelector('.library-search');
    const tools = document.querySelector('.library-tools');
    const searchRect = search.getBoundingClientRect();
    const toolsRect = tools.getBoundingClientRect();
    const input = search.querySelector('input');
    return {
      searchFull: Math.abs(searchRect.width - toolsRect.width) < 2,
      inputSize: getComputedStyle(input).fontSize,
      buttonHeight: Math.round(document.querySelector('.library-nav button').getBoundingClientRect().height),
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    };
  })()`);

  console.log(JSON.stringify({ boxes, behavior, phone, sheet }, null, 2));
  ws.close();
  const overflow = boxes.filter((box) => box.scroll > box.client + 1 || box.searchClipped || box.wide.length > 0);
  if (overflow.length > 0 || !behavior.dialogOpen || !behavior.focusAfterDialog || !behavior.empty || phone.scroll > phone.client + 1 || !sheet.open) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'check failed');
  process.exitCode = 1;
} finally {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 400));
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
