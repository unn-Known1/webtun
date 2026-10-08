'use strict';
const { test, expect } = require('@playwright/test');

const prompt = 'test-workspace $ ';
const dataFrame = text => Buffer.concat([Buffer.from([0]), Buffer.from(text)]);

// Emulate the shell's clear-screen response while using the actual xterm
// renderer and binary WebSocket messages in the browser.
async function terminalPage(page) {
  const sockets = [];
  await page.routeWebSocket('**/ws?*', socket => {
    const state = { inputs: [], output: text => socket.send(dataFrame(text)) };
    socket.onMessage(message => {
      const frame = Buffer.from(message);
      if (frame[0] !== 0) return;
      const input = frame.subarray(1).toString();
      state.inputs.push(input);
      if (input === '\x0c') state.output('\x1b[H\x1b[2J' + prompt);
    });
    sockets.push(state);
  });
  await page.goto('/');
  await page.waitForFunction(() => tabs[0]?.term && tabs[0].ws?.readyState === WebSocket.OPEN);
  return sockets;
}

async function cursorRow(page, index = 0) {
  return page.evaluate(index => tabs[index].term.buffer.active.cursorY, index);
}

test('fresh terminal prompts move above blank startup rows and fit their pane', async ({ page }) => {
  const sockets = await terminalPage(page);
  // tmux uses the alternate screen and asks xterm for its cursor position.
  sockets[0].output('\x1b[?1049h' + '\r\n'.repeat(12) + prompt + '\x1b[6n');
  await expect.poll(() => sockets[0].inputs.filter(input => input === '\x0c').length).toBe(1);
  await expect.poll(() => cursorRow(page)).toBe(0);
  expect(await page.evaluate(() => tabs[0].term.buffer.active.getLine(0).translateToString(true))).toBe(prompt);

  const size = await page.evaluate(() => [tabs[0].term.cols, tabs[0].term.rows]);
  await page.locator('#new-tab-btn').click();
  await page.waitForFunction(() => tabs[1]?.term && tabs[1].ws?.readyState === WebSocket.OPEN);
  sockets[1].output('\r\n'.repeat(12) + prompt);
  await expect.poll(() => cursorRow(page, 1)).toBe(0);
  await expect.poll(() => sockets[1].inputs.filter(input => input === '\x0c').length).toBe(1);

  expect(await page.evaluate(() => {
    fitTerm(tabs[0]);
    return [tabs[0].term.cols, tabs[0].term.rows];
  })).toEqual(size);
  await page.evaluate(() => toggleTiles());
  await expect.poll(() => page.evaluate(() => tabs.every(tab => {
    const screen = tab.term.element.querySelector('.xterm-screen').getBoundingClientRect();
    const wrapper = tab.wrapper.getBoundingClientRect();
    const style = getComputedStyle(tab.wrapper);
    return screen.top >= wrapper.top + parseFloat(style.paddingTop)
      && screen.bottom <= wrapper.bottom - parseFloat(style.paddingBottom) + 1;
  }))).toBe(true);

  sockets[1].output('\r\n'.repeat(5) + prompt);
  await expect.poll(() => cursorRow(page, 1)).toBe(5);
  expect(sockets[1].inputs.filter(input => input === '\x0c')).toHaveLength(1);
});

test('startup messages keep their text and cursor position', async ({ page }) => {
  const sockets = await terminalPage(page);
  sockets[0].output('\r\n'.repeat(12) + 'Welcome to this shell');
  sockets[0].output('\r\n' + prompt);
  await expect.poll(() => cursorRow(page)).toBe(13);
  await page.waitForFunction(() => !tabs[0]._initialPromptPending);
  expect(sockets[0].inputs).not.toContain('\x0c');
  expect(await page.evaluate(() => tabs[0].term.buffer.active.getLine(12).translateToString(true))).toBe('Welcome to this shell');
});

test('typing and mobile keys cancel the startup redraw', async ({ page }) => {
  const sockets = await terminalPage(page);
  await page.evaluate(() => tabs[0].term.focus());
  await page.keyboard.type('echo keep-this');
  await expect.poll(() => sockets[0].inputs.join('')).toBe('echo keep-this');
  sockets[0].output('\r\n'.repeat(12) + prompt + 'echo keep-this');
  await expect.poll(() => cursorRow(page)).toBe(12);
  expect(sockets[0].inputs).not.toContain('\x0c');

  await page.locator('#new-tab-btn').click();
  await page.waitForFunction(() => tabs[1]?.term && tabs[1].ws?.readyState === WebSocket.OPEN);
  await page.evaluate(() => sendKey('\x03'));
  await expect.poll(() => sockets[1].inputs).toContain('\x03');
  sockets[1].output('\r\n'.repeat(12) + prompt);
  await expect.poll(() => cursorRow(page, 1)).toBe(12);
  expect(sockets[1].inputs).not.toContain('\x0c');
});

test('restored and reconnected sessions retain their cursor position', async ({ page }) => {
  const sockets = await terminalPage(page);
  await page.evaluate(() => newTab('Restored', 'existing-session', homeDir));
  await page.waitForFunction(() => tabs[1]?.term && tabs[1].ws?.readyState === WebSocket.OPEN);
  sockets[1].output('\r\n'.repeat(12) + prompt);
  await expect.poll(() => cursorRow(page, 1)).toBe(12);
  expect(sockets[1].inputs).not.toContain('\x0c');

  await page.evaluate(() => connectWebSocket(tabs[0], true));
  await expect.poll(() => sockets.length).toBe(3);
  await page.waitForFunction(() => tabs[0].ws?.readyState === WebSocket.OPEN);
  sockets[2].output('\x1b[H\x1b[2J' + '\r\n'.repeat(12) + prompt);
  await expect.poll(() => cursorRow(page)).toBe(12);
  expect(sockets[2].inputs).not.toContain('\x0c');
});

async function outputLogs(page, socket) {
  socket.output(Array.from({ length: 200 }, (_, i) => 'log line ' + i + '\r\n').join('') + prompt);
  await page.waitForFunction(() => tabs[0].term.buffer.active.baseY > 100);
  await page.waitForFunction(() => !tabs[0]._initialPromptPending);
  await page.evaluate(() => { tabs[0].term.options.smoothScrollDuration = 0; });
  return page.evaluate(() => tabs[0].term.buffer.active.baseY);
}

async function viewportRow(page) {
  return page.evaluate(() => tabs[0].term.buffer.active.viewportY);
}

async function swipeTerminal(page, distance) {
  const screen = await page.locator('.term-wrapper.active .xterm-screen').boundingBox();
  const client = await page.context().newCDPSession(page);
  const x = Math.round(screen.x + screen.width / 2);
  const y = Math.round(screen.y + screen.height / 2);
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + distance }] });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await client.detach();
}

test('wheel scrolling moves shell logs once and leaves shell input untouched', async ({ page }) => {
  const sockets = await terminalPage(page);
  const bottom = await outputLogs(page, sockets[0]);
  const screen = await page.locator('.term-wrapper.active .xterm-screen').boundingBox();
  const height = await page.evaluate(() => xtermCharHeight(tabs[0].term, tabs[0].wrapper));
  await page.mouse.move(screen.x + screen.width / 2, screen.y + screen.height / 2);
  await page.mouse.wheel(0, -height * 3);
  await expect.poll(() => viewportRow(page)).toBeLessThan(bottom);
  expect(await viewportRow(page)).toBeGreaterThanOrEqual(bottom - 3);
  await page.mouse.wheel(0, height * 3);
  await expect.poll(() => viewportRow(page)).toBe(bottom);
  expect(sockets[0].inputs).toEqual([]);
});

test('small trackpad deltas accumulate without jumping a line per event', async ({ page }) => {
  const sockets = await terminalPage(page);
  const bottom = await outputLogs(page, sockets[0]);
  await page.evaluate(async () => {
    const term = tabs[0].term;
    const screen = term.element.querySelector('.xterm-screen');
    const deltaY = -xtermCharHeight(term, tabs[0].wrapper) / 4;
    for (let i = 0; i < 4; i++) {
      screen.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  });
  await expect.poll(() => viewportRow(page)).toBe(bottom - 1);
  expect(sockets[0].inputs).toEqual([]);
});

test('TUI mouse wheel reports are delivered once at the pointed cell', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const sockets = await terminalPage(page);
  sockets[0].output('\x1b[?1049h\x1b[?1000h\x1b[?1006hTUI mouse scrolling');
  await page.waitForFunction(() => tabs[0].term.modes.mouseTrackingMode === 'vt200');
  const screen = await page.locator('.term-wrapper.active .xterm-screen').boundingBox();
  const point = await page.evaluate(() => {
    const cell = xtermCellMetrics(tabs[0].term);
    return { x: cell.actualCellWidth * 4.5, y: cell.actualCellHeight * 3.5 };
  });
  await page.mouse.move(screen.x + point.x, screen.y + point.y);
  await page.mouse.wheel(0, -80);
  await expect.poll(() => sockets[0].inputs.length).toBe(1);
  expect(sockets[0].inputs[0]).toBe('\x1b[<64;5;4M');
  await page.mouse.wheel(0, 80);
  await expect.poll(() => sockets[0].inputs.length).toBe(2);
  expect(sockets[0].inputs[1]).toBe('\x1b[<65;5;4M');
  expect(errors).toEqual([]);
});

test('TUIs without mouse tracking receive wheel navigation and restore log scrolling on exit', async ({ page }) => {
  const sockets = await terminalPage(page);
  const bottom = await outputLogs(page, sockets[0]);
  sockets[0].output('\x1b[?1049h\x1b[?1hTUI keyboard scrolling');
  await page.waitForFunction(() => tabs[0].term.buffer.active.type === 'alternate');
  const screen = page.locator('.term-wrapper.active .xterm-screen');
  await screen.dispatchEvent('wheel', { deltaY: -2, deltaMode: 1 });
  await expect.poll(() => sockets[0].inputs.join('')).toBe('\x1bOA\x1bOA');
  await screen.dispatchEvent('wheel', { deltaY: 2, deltaMode: 1 });
  await expect.poll(() => sockets[0].inputs.join('')).toBe('\x1bOA\x1bOA\x1bOB\x1bOB');
  await page.evaluate(() => tabs[0].term.focus());
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => sockets[0].inputs.join('')).toBe('\x1bOA\x1bOA\x1bOB\x1bOB\x1bOA');
  sockets[0].output('\x1b[?1l\x1b[?1049l');
  await page.waitForFunction(() => tabs[0].term.buffer.active.type === 'normal');
  await screen.dispatchEvent('wheel', { deltaY: -3, deltaMode: 1 });
  await expect.poll(() => viewportRow(page)).toBe(bottom - 3);
  expect(sockets[0].inputs.join('')).toBe('\x1bOA\x1bOA\x1bOB\x1bOB\x1bOA');
});

test('touch gestures scroll shell logs without sending input or selecting text', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'Requires a touch viewport');
  const sockets = await terminalPage(page);
  const bottom = await outputLogs(page, sockets[0]);
  const height = await page.evaluate(() => xtermCharHeight(tabs[0].term, tabs[0].wrapper));
  await swipeTerminal(page, height * 4);
  await expect.poll(() => viewportRow(page)).toBeLessThan(bottom);
  expect(await viewportRow(page)).toBeGreaterThanOrEqual(bottom - 4);
  await swipeTerminal(page, -height * 4);
  await expect.poll(() => viewportRow(page)).toBe(bottom);
  expect(await page.evaluate(() => tabs[0].term.hasSelection())).toBe(false);
  expect(sockets[0].inputs).toEqual([]);
});

test('touch gestures navigate TUIs with and without mouse tracking', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'Requires a touch viewport');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const sockets = await terminalPage(page);
  sockets[0].output('\x1b[?1049h\x1b[?1000h\x1b[?1006hTUI touch scrolling');
  await page.waitForFunction(() => tabs[0].term.modes.mouseTrackingMode === 'vt200');
  await swipeTerminal(page, 80);
  await expect.poll(() => sockets[0].inputs.length).toBe(1);
  expect(sockets[0].inputs[0]).toMatch(/^\x1b\[<64;\d+;\d+M$/);
  sockets[0].output('\x1b[?1000l\x1b[?1h');
  await page.waitForFunction(() => tabs[0].term.modes.mouseTrackingMode === 'none');
  await swipeTerminal(page, -80);
  await expect.poll(() => sockets[0].inputs.length).toBe(2);
  expect(sockets[0].inputs[1]).toMatch(/^(\x1bOB)+$/);
  expect(errors).toEqual([]);
});

test('mobile selection controls scroll terminal output up and down', async ({ page }) => {
  test.skip(test.info().project.name !== 'mobile', 'Requires the mobile scroll controls');
  const sockets = await terminalPage(page);
  const bottom = await outputLogs(page, sockets[0]);
  await page.evaluate(() => toggleTermSelect());
  const up = page.locator('#mkey-sel-row [title="Scroll up"]');
  const down = page.locator('#mkey-sel-row [title="Scroll down"]');
  await expect(up).toBeVisible();
  const step = await page.evaluate(() => Math.floor(tabs[0].term.rows / 2));
  await up.click();
  await expect.poll(() => viewportRow(page)).toBe(bottom - step);
  await down.click();
  await expect.poll(() => viewportRow(page)).toBe(bottom);
  expect(sockets[0].inputs).toEqual([]);
});
