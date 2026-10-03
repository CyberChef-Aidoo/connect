import { writeFileSync } from 'node:fs';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const shotPath = process.argv[2];
const base = 'https://127.0.0.1:8443';

const meRes = await fetch(`${base}/api/auth/me`);
const me = await meRes.json();
const cookie = meRes.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
const form = new FormData();
form.append('file', new Blob(['layout']), 'layout-check.txt');
const uploaded = await fetch(`${base}/api/files`, {
  method: 'POST',
  headers: { 'X-CSRF-Token': me.csrfToken, Cookie: cookie },
  body: form,
});
if (!uploaded.ok) throw new Error(`upload ${uploaded.status}`);
const file = await uploaded.json();

const tabRes = await fetch('http://127.0.0.1:9222/json/new?https://127.0.0.1:8443/', { method: 'PUT' });
const tab = await tabRes.json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
function send(method, params = {}) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
ws.addEventListener('message', (event) => {
  const data = JSON.parse(event.data);
  if (!data.id || !pending.has(data.id)) return;
  const waiter = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) waiter.reject(new Error(JSON.stringify(data.error)));
  else waiter.resolve(data.result);
});
await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Page.enable');
await send('Page.navigate', { url: `${base}/` });
await new Promise((resolve) => setTimeout(resolve, 1600));
const ready = await send('Runtime.evaluate', {
  expression: `(() => {
    const box = document.querySelector("input[aria-label='Select every file on this page']");
    if (box) box.click();
    return document.body.innerText.includes('Shared files') && Boolean(document.querySelector('.bulk-actions'));
  })()`,
  returnByValue: true,
});
await new Promise((resolve) => setTimeout(resolve, 300));
const boxes = await send('Runtime.evaluate', {
  expression: `JSON.stringify([...document.querySelectorAll('.bulk-actions button, .bulk-actions a.button')].map((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      text: el.textContent.trim(),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      bg: style.backgroundColor,
    };
  }))`,
  returnByValue: true,
});
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 120, width: 1000, height: 280, scale: 1 },
});
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
console.log(JSON.stringify({ ready: ready.result.value, boxes: JSON.parse(boxes.result.value) }));
ws.close();

await fetch(`${base}/api/files/${file.file.id}`, {
  method: 'DELETE',
  headers: { 'X-CSRF-Token': me.csrfToken, Cookie: cookie },
});
await fetch(`${base}/api/files/${file.file.id}/permanent`, {
  method: 'DELETE',
  headers: { 'X-CSRF-Token': me.csrfToken, Cookie: cookie },
});
