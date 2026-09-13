const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:8080';

function createAudioFixture() {
  const sampleRate = 16000;
  const length = sampleRate * 8;
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
    wav.writeInt16LE(Math.round(Math.sin(i * 0.08) * envelope * 25000), 44 + i * 2);
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

    assert.deepEqual(await page.locator('button:enabled').evaluateAll(nodes => nodes.map(node => node.id)), ['play']);
    assert.equal(await page.locator('.status-left > span').innerText(), '16:17');
    assert.equal(await page.locator('.battery-number').innerText(), '78');
    assert.equal(await page.locator('.battery-number').evaluate(node => getComputedStyle(node).color), 'rgb(199, 199, 199)');
    assert.equal(await page.locator('dialog, [popover], input').count(), 0);
    assert.equal(await page.locator('canvas[tabindex]').count(), 0);

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

    const inertIds = ['more', 'done', 'back', 'forward', 'transcript', 'replace', 'settings'];
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

    const box = await page.locator('canvas').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 20, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    assert.equal(await page.locator('audio').evaluate(node => node.currentTime), stoppedTime);

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

    await page.route(/\.(wav|m4a|mp3|ogg|flac|aac)(\?.*)?$/i, route => route.fulfill({ status: 404, body: '' }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#error').textContent.includes('未找到'));
    assert.ok(await page.locator('#play').isDisabled());
    await assertIsland();
    assert.deepEqual(errors, []);
    console.log('PASS: play/pause/resume/replay, immutable black waveform, inert controls, fixed status values, gray battery text, color-only breathing dot with fixed size and position, animation independent of playback, reduced motion, distinct backgrounds, five viewports and missing audio.');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
