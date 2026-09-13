const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';

function createAudioFixture(freq = 0.08) {
  const sampleRate = 16000;
  const length = sampleRate * 90;
  const wav = Buffer.alloc(44 + length * 2);
  wav.write('RIFF');
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(length * 2, 40);
  for (let i = 0; i < length; i++) {
    const envelope = 0.1 + 0.6 * Math.abs(Math.sin(i / sampleRate * 4));
    wav.writeInt16LE(Math.round(Math.sin(i * freq) * envelope * 25000), 44 + i * 2);
  }
  return wav;
}

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, reducedMotion: 'no-preference' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let audioRequests = 0;
    await page.route(/\.(wav|m4a|mp3|ogg|flac|aac)(\?.*)?$/i, route => {
      audioRequests++;
      return route.fulfill({ contentType: 'audio/wav', body: createAudioFixture() });
    });
    await page.goto(baseURL);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => !document.querySelector('#play').disabled);

    assert.deepEqual(await page.locator('.screen button:enabled').evaluateAll(nodes => nodes.map(node => node.id)), ['back', 'play', 'forward']);
    // Status-bar clock starts at RECORDING.time and advances with playback position.
    const clockAt = seconds => page.evaluate(async s => {
      const audio = document.querySelector('#audio');
      audio.currentTime = s;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return document.querySelector('#status-time').innerText;
    }, seconds);
    assert.equal(await clockAt(0), await page.evaluate(() => RECORDING.time));
    assert.equal(await clockAt(60), '12:35');
    assert.equal(await clockAt(0), await page.evaluate(() => RECORDING.time));
    assert.equal(await page.locator('#title').innerText(), await page.evaluate(() => RECORDING.title));
    if (await page.evaluate(() => !!RECORDING.duration)) {
      assert.equal(await page.locator('#duration').innerText(), await page.evaluate(() => RECORDING.duration));
    }
    assert.equal(await page.locator('.battery-number').innerText(), '78');
    assert.equal(await page.locator('.battery-number').evaluate(node => getComputedStyle(node).color), 'rgb(199, 199, 199)');
    assert.equal(await page.locator('dialog, [popover]').count(), 0);
    assert.equal(await page.locator('input:not([type=file])').count(), 0);
    assert.equal(await page.locator('#file').evaluate(node => node.hidden), true);
    // The helper bar lives outside the iOS replica so it never overlaps the screen chrome.
    assert.equal(await page.locator('.helper-bar').evaluate(node => node.closest('.screen') === null), true);

    const initialPeaks = await page.evaluate(() => Array.from(peaks));
    assert.ok(initialPeaks.length > 0 && initialPeaks.some(value => value > 0));
    const canvasImage = () => page.locator('canvas').evaluate(node => node.toDataURL());
    const startImage = await canvasImage();
    const assertIsland = async () => {
      assert.ok(await page.locator('.dynamic-island').isVisible());
      assert.ok(await page.locator('.screen-recording-dot').isVisible());
      const animation = await page.locator('.screen-recording-dot').evaluate(node => ({
        name: getComputedStyle(node).animationName,
        state: node.getAnimations()[0]?.playState,
      }));
      assert.deepEqual(animation, { name: 'recording-breathe', state: 'running' });
    };
    const assertBreathing = async () => {
      const samples = [];
      for (let i = 0; i < 6; i++) {
        samples.push(await page.locator('.screen-recording-dot').evaluate(node => {
          const rect = node.getBoundingClientRect();
          return {
            width: rect.width,
            height: rect.height,
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2,
            red: Number(getComputedStyle(node).backgroundColor.match(/\d+/)[0]),
          };
        }));
        if (i < 5) await page.waitForTimeout(200);
      }
      const reds = samples.map(sample => sample.red);
      assert.ok(Math.max(...reds) - Math.min(...reds) > 20, 'Recording dot must change color');
      for (const sample of samples) {
        assert.equal(sample.width, 12, 'Dot width must stay fixed');
        assert.equal(sample.height, 12, 'Dot height must stay fixed');
        assert.ok(Math.abs(sample.x - samples[0].x) < 0.01, 'Dot center must not drift');
        assert.ok(Math.abs(sample.y - samples[0].y) < 0.01, 'Dot center must not drift');
      }
    };
    await assertIsland();
    await assertBreathing();
    const animationStart = await page.locator('.screen-recording-dot').evaluate(node => node.getAnimations()[0].startTime);

    const inertIds = ['more', 'done', 'transcript', 'replace', 'settings'];
    const clickInertControls = async () => {
      for (const id of inertIds) {
        assert.ok(await page.locator(`#${id}`).isDisabled());
        const box = await page.locator(`#${id}`).boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
    };
    await clickInertControls();
    assert.ok(await page.locator('audio').evaluate(node => node.paused && node.currentTime === 0));
    assert.equal(audioRequests, 1);

    // Skip buttons: forward advances 15s (clamped to duration), back rewinds 15s (clamped to 0).
    await page.locator('audio').evaluate(node => { node.currentTime = 2; });
    await page.getByRole('button', { name: '快进15秒', exact: true }).click();
    assert.ok(await page.locator('audio').evaluate(node => Math.abs(node.currentTime - 17) < 0.05), 'forward should add 15s');
    await page.getByRole('button', { name: '后退15秒', exact: true }).click();
    assert.ok(await page.locator('audio').evaluate(node => Math.abs(node.currentTime - 2) < 0.05), 'back should subtract 15s');
    await page.getByRole('button', { name: '后退15秒', exact: true }).click();
    assert.equal(await page.locator('audio').evaluate(node => node.currentTime), 0, 'back clamps at 0');
    await page.getByRole('button', { name: '快进15秒', exact: true }).click();
    assert.ok(await page.locator('audio').evaluate(node => node.currentTime <= node.duration), 'forward clamps at duration');
    assert.ok(await page.locator('audio').evaluate(node => node.paused), 'skipping does not start playback');
    await page.locator('audio').evaluate(node => { node.currentTime = 0; });

    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.3);
    await assertIsland();
    await assertBreathing();
    await clickInertControls();
    assert.ok(await page.locator('audio').evaluate(node => !node.paused));
    assert.equal(await page.locator('#replace').innerText(), '替换');
    assert.equal(await page.locator('#replace').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(236, 236, 238)');
    assert.equal(await page.locator('.cursor').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(56, 133, 255)');
    assert.notEqual(await canvasImage(), startImage);

    // Freeze the same media instant inside one task to compare play/pause rendering.
    const sameInstant = await page.evaluate(() => {
      audio.pause();
      draw();
      const before = canvas.toDataURL();
      renderPlay();
      return { before, after: canvas.toDataURL() };
    });
    assert.equal(sameInstant.before, sameInstant.after);
    await page.waitForFunction(() => document.querySelector('#play').getAttribute('aria-label') === '播放');
    const stoppedTime = await page.locator('audio').evaluate(node => node.currentTime);
    const stoppedImage = await canvasImage();
    await page.waitForTimeout(250);
    assert.equal(await canvasImage(), stoppedImage);
    assert.equal(await page.locator('audio').evaluate(node => node.currentTime), stoppedTime);
    await assertIsland();
    await assertBreathing();
    assert.equal(await canvasImage(), stoppedImage);
    assert.equal(await page.locator('.screen-recording-dot').evaluate(node => node.getAnimations()[0].startTime), animationStart);

    // Scrubbing: drag the centered waveform to change playback position.
    await page.locator('audio').evaluate(node => { node.currentTime = 3; });
    await page.waitForFunction(() => Math.abs(document.querySelector('audio').currentTime - 3) < 0.05);
    const box = await page.locator('canvas').boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    // Drag right by 150px at 100px/s -> time decreases ~1.5s.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 150, cy, { steps: 8 });
    await page.mouse.up();
    const afterBack = await page.locator('audio').evaluate(node => node.currentTime);
    assert.ok(Math.abs(afterBack - 1.5) < 0.2, `drag right should rewind, got ${afterBack}`);
    assert.equal(await page.locator('#elapsed').innerText(), await page.evaluate(t => format(t, true), afterBack));
    // Drag left advances the position again.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 200, cy, { steps: 8 });
    await page.mouse.up();
    const afterForward = await page.locator('audio').evaluate(node => node.currentTime);
    assert.ok(afterForward - afterBack > 1.5, `drag left should advance, got ${afterForward}`);
    // Dragging far right clamps at zero, never negative.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + box.width * 3, cy, { steps: 10 });
    await page.mouse.up();
    assert.equal(await page.locator('audio').evaluate(node => node.currentTime), 0);
    assert.ok(await page.locator('audio').evaluate(node => node.paused), 'scrubbing while paused stays paused');

    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(time => document.querySelector('audio').currentTime > time + 0.1, stoppedTime);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').paused);
    assert.deepEqual(await page.evaluate(() => Array.from(peaks)), initialPeaks);
    const colors = await page.locator('canvas').evaluate(node => {
      const pixels = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
      let black = 0;
      let red = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i + 3] && pixels[i] < 30 && pixels[i + 1] < 30 && pixels[i + 2] < 30) black++;
        if (pixels[i + 3] && pixels[i] > 180 && pixels[i + 1] < 120 && pixels[i + 2] < 120) red++;
      }
      return { black, red };
    });
    assert.ok(colors.black > 100);
    assert.equal(colors.red, 0);
    assert.equal(audioRequests, 1);

    await page.locator('audio').evaluate(node => { node.currentTime = node.duration - 0.08; });
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').ended);
    await assertIsland();
    assert.equal(await page.locator('.screen-recording-dot').evaluate(node => node.getAnimations()[0].startTime), animationStart);
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('audio').paused && document.querySelector('audio').currentTime < 1);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    assert.equal(await page.evaluate(() => format(3916, true)), '1:05:16.00');

    for (const [width, height] of [[320, 700], [375, 812], [393, 852], [430, 932], [1440, 900]]) {
      await page.setViewportSize({ width, height });
      const layout = await page.evaluate(() => {
        const left = document.querySelector('.status-left').getBoundingClientRect();
        const island = document.querySelector('.dynamic-island').getBoundingClientRect();
        const right = document.querySelector('.status-icons').getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
          overlap: left.right >= island.left || island.right >= right.left,
        };
      });
      assert.equal(layout.overflow, false, `${width}: overflow`);
      assert.equal(layout.overlap, false, `${width}: status overlap`);
      await assertIsland();
    }

    const backgrounds = await page.evaluate(() => ({
      outside: getComputedStyle(document.documentElement).backgroundColor,
      screen: getComputedStyle(document.querySelector('.screen')).backgroundColor,
    }));
    assert.notEqual(backgrounds.outside, backgrounds.screen);

    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.deepEqual(await page.locator('.screen-recording-dot').evaluate(node => ({
      animations: node.getAnimations().length,
      color: getComputedStyle(node).backgroundColor,
      width: node.getBoundingClientRect().width,
    })), { animations: 0, color: 'rgb(255, 69, 58)', width: 12 });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await assertIsland();

    // Helper bar: repo link opens configured URL, and it auto-hides without interaction.
    assert.equal(await page.locator('#repo-link').getAttribute('target'), '_blank');
    assert.equal(await page.locator('#repo-link').getAttribute('rel'), 'noopener noreferrer');
    assert.ok((await page.locator('#repo-link').getAttribute('href')).startsWith('http'));
    // The GitHub glyph must fit inside its viewBox so overflow:hidden does not clip it.
    assert.ok(await page.locator('#repo-link svg').evaluate(svg => {
      const box = svg.viewBox.baseVal;
      const bbox = svg.querySelector('path').getBBox();
      return bbox.x >= box.x - 0.5 && bbox.y >= box.y - 0.5
        && bbox.x + bbox.width <= box.x + box.width + 0.5
        && bbox.y + bbox.height <= box.y + box.height + 0.5;
    }), 'GitHub icon path must fit within its viewBox');
    assert.ok(await page.locator('.helper-bar').evaluate(node => node.closest('.screen') === null));
    // Wait out the initial auto-reveal so the bar is hidden before probing interactions.
    await page.waitForFunction(() => !document.querySelector('.helper-bar').classList.contains('is-visible'), null, { timeout: 6000 });
    // Clicks/taps/keys (without pointer movement) must not summon the bar; only movement does.
    await page.evaluate(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ' }));
      window.dispatchEvent(new TouchEvent('touchstart', { bubbles: true }));
    });
    assert.ok(await page.locator('.helper-bar').evaluate(node => !node.classList.contains('is-visible')), 'Clicks and keys must not reveal the helper bar');
    await page.mouse.move(5, 5);
    await page.mouse.move(6, 6);
    assert.ok(await page.locator('.helper-bar').evaluate(node => node.classList.contains('is-visible')));
    await page.waitForFunction(() => !document.querySelector('.helper-bar').classList.contains('is-visible'), null, { timeout: 6000 });

    // Local upload plays a browser-only file: no network request, new waveform, resettable playback.
    // It swaps only the audio; the title and date text stay unchanged.
    const uploadRequests = audioRequests;
    const titleBefore = await page.locator('#title').innerText();
    const dateBefore = await page.locator('#date').innerText();
    const peaksBefore = await page.evaluate(() => Array.from(peaks));
    await page.locator('#file').setInputFiles({ name: '我的录音.m4a', mimeType: 'audio/mp4', buffer: createAudioFixture(0.02) });
    await page.waitForFunction(before => JSON.stringify(Array.from(peaks)) !== before, JSON.stringify(peaksBefore));
    await page.waitForFunction(() => !document.querySelector('#play').disabled);
    assert.equal(audioRequests, uploadRequests, 'Upload must not hit the network');
    assert.equal(await page.locator('#title').innerText(), titleBefore, 'Upload must not change the title');
    assert.equal(await page.locator('#date').innerText(), dateBefore, 'Upload must not change the date');
    assert.ok(await page.evaluate(() => peaks.length > 0));
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.2);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await assertIsland();

    await page.route(/\.(wav|m4a|mp3|ogg|flac|aac)(\?.*)?$/i, route => route.fulfill({ status: 404, body: '' }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('未找到'));
    assert.ok(await page.locator('#play').isDisabled());
    await assertIsland();
    assert.deepEqual(errors, []);
    console.log('PASS: playback, immutable black waveform, inert controls, fixed status values, breathing dot, reduced motion, distinct backgrounds, five viewports, auto-hiding helper bar, network-free local upload playback and missing audio.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
