const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { PassThrough, Readable } = require('stream');

const pureImage = require('pureimage');
let fontsLoaded = false;
const avatarCache = new Map();

const COLORS = {
  accent: [249, 115, 22],
  background: 'rgb(17, 24, 39)',
  panel: 'rgb(31, 41, 55)',
  panelSoft: 'rgb(30, 41, 59)',
  text: 'rgb(248, 250, 252)',
  muted: 'rgb(148, 163, 184)',
  label: 'rgb(253, 186, 116)',
  subtitle: 'rgb(254, 215, 170)',
  progressTrack: 'rgb(51, 65, 85)',
};

const FONTS = {
  title: { family: 'CardBold', size: 33, lineHeight: 41 },
  subtitle: { family: 'CardRegular', size: 24, lineHeight: 30 },
  date: { family: 'CardRegular', size: 18, lineHeight: 24 },
  label: { family: 'CardBold', size: 18, lineHeight: 24 },
  body: { family: 'CardRegular', size: 26, lineHeight: 33 },
  footer: { family: 'CardRegular', size: 18, lineHeight: 24 },
  badge: { family: 'CardBold', size: 29, lineHeight: 36 },
};

function firstExistingPath(paths) {
  return paths.find((candidatePath) => candidatePath && fs.existsSync(candidatePath)) || null;
}

function loadFonts() {
  if (fontsLoaded) {
    return;
  }

  const windowsDirectory = process.env.WINDIR || 'C:\\Windows';
  const regularFontPath = firstExistingPath([
    path.join(windowsDirectory, 'Fonts', 'segoeui.ttf'),
    path.join(windowsDirectory, 'Fonts', 'arial.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf',
  ]);
  const boldFontPath = firstExistingPath([
    path.join(windowsDirectory, 'Fonts', 'segoeuib.ttf'),
    path.join(windowsDirectory, 'Fonts', 'arialbd.ttf'),
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
    regularFontPath,
  ]);

  if (!regularFontPath || !boldFontPath) {
    throw new Error('No usable system font was found for readable card rendering.');
  }

  pureImage.registerFont(regularFontPath, 'CardRegular').loadSync();
  pureImage.registerFont(boldFontPath, 'CardBold').loadSync();
  fontsLoaded = true;
}

function cardText(value) {
  return String(value ?? '')
    .replace(/<@!?(\d+)>/g, '@User')
    .replace(/<@&(\d+)>/g, '@Role')
    .replace(/<#(\d+)>/g, '#Channel')
    .replace(/[\r\t]+/g, ' ')
    .replace(/[^\x20-\x7e\n]/g, '?')
    .trim();
}

function colorToCss(color, fallback = COLORS.accent) {
  const source = Array.isArray(color) && color.length >= 3 ? color : fallback;
  const [red, green, blue] = source.map((part) => Math.max(0, Math.min(255, Number(part) || 0)));
  return `rgb(${red}, ${green}, ${blue})`;
}

function setFont(context, family, size) {
  context.font = `${size}pt ${family}`;
}

function measureText(context, text, family, size) {
  setFont(context, family, size);
  return context.measureText(text).width || 0;
}

function wrapText(context, value, family, size, maxWidth) {
  const text = cardText(value);
  if (!text) {
    return [''];
  }

  const lines = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let currentLine = '';

    for (const word of words) {
      const nextLine = currentLine ? `${currentLine} ${word}` : word;
      if (measureText(context, nextLine, family, size) <= maxWidth) {
        currentLine = nextLine;
        continue;
      }

      if (currentLine) {
        lines.push(currentLine);
        currentLine = '';
      }

      if (measureText(context, word, family, size) <= maxWidth) {
        currentLine = word;
        continue;
      }

      let fragment = '';
      for (const character of word) {
        const nextFragment = `${fragment}${character}`;
        if (measureText(context, nextFragment, family, size) <= maxWidth) {
          fragment = nextFragment;
          continue;
        }

        if (fragment) {
          lines.push(fragment);
        }
        fragment = character;
      }
      currentLine = fragment;
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [''];
}

function truncateToWidth(context, value, family, size, maxWidth) {
  const text = cardText(value);
  if (measureText(context, text, family, size) <= maxWidth) {
    return text;
  }

  let output = text;
  while (output.length > 0 && measureText(context, `${output}...`, family, size) > maxWidth) {
    output = output.slice(0, -1);
  }
  return `${output.trimEnd()}...`;
}

function fillRoundedRect(context, x, y, width, height, radius, fillStyle) {
  const roundedRadius = Math.max(0, Math.min(radius, Math.floor(Math.min(width, height) / 2)));
  context.fillStyle = fillStyle;
  context.beginPath();
  context.moveTo(x + roundedRadius, y);
  context.lineTo(x + width - roundedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + roundedRadius);
  context.lineTo(x + width, y + height - roundedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - roundedRadius, y + height);
  context.lineTo(x + roundedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - roundedRadius);
  context.lineTo(x, y + roundedRadius);
  context.quadraticCurveTo(x, y, x + roundedRadius, y);
  context.fill();
}

function drawLines(context, lines, x, y, family, size, lineHeight, fillStyle, maxLines = Infinity) {
  setFont(context, family, size);
  context.fillStyle = fillStyle;
  let cursorY = y;
  for (const line of lines.slice(0, maxLines)) {
    context.fillText(line, x, cursorY);
    cursorY += lineHeight;
  }
  return cursorY;
}

function normalizeProgress(progress) {
  if (!progress || typeof progress.percent !== 'number' || !Number.isFinite(progress.percent)) {
    return null;
  }

  return Math.max(0, Math.min(1, progress.percent));
}

function drawProgressBar(context, x, y, width, height, percent, accentColor) {
  const clamped = Math.max(0, Math.min(1, percent));
  fillRoundedRect(context, x, y, width, height, Math.floor(height / 2), COLORS.progressTrack);

  if (clamped <= 0) {
    return;
  }

  const inset = 4;
  const innerWidth = Math.max(0, width - inset * 2);
  const innerHeight = Math.max(0, height - inset * 2);
  const rawFillWidth = clamped >= 1 ? innerWidth : Math.floor(innerWidth * clamped);
  const fillWidth = Math.min(innerWidth, Math.max(innerHeight, rawFillWidth));
  fillRoundedRect(context, x + inset, y + inset, fillWidth, innerHeight, Math.floor(innerHeight / 2), accentColor);
}

function fetchUrlBuffer(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (!url || redirectCount > 3) {
      reject(new Error('Avatar URL could not be loaded.'));
      return;
    }

    const request = https.get(url, {
      headers: { 'User-Agent': 'Voice Bot image renderer' },
      timeout: 3500,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        fetchUrlBuffer(response.headers.location, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`Avatar request failed with status ${response.statusCode}`));
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.on('timeout', () => request.destroy(new Error('Avatar request timed out')));
    request.on('error', reject);
  });
}

async function loadAvatar(avatarUrl) {
  if (!avatarUrl) {
    return null;
  }

  if (avatarCache.has(avatarUrl)) {
    return avatarCache.get(avatarUrl);
  }

  try {
    const avatarBuffer = await fetchUrlBuffer(avatarUrl);
    const stream = Readable.from(avatarBuffer);
    const isJpeg = avatarBuffer[0] === 0xff && avatarBuffer[1] === 0xd8;
    const avatarImage = isJpeg
      ? await pureImage.decodeJPEGFromStream(stream)
      : await pureImage.decodePNGFromStream(stream);
    avatarCache.set(avatarUrl, avatarImage);
    return avatarImage;
  } catch {
    return null;
  }
}

function drawAvatar(context, avatarImage, x, y, size, accentColor) {
  context.fillStyle = accentColor;
  context.beginPath();
  context.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  context.fill();

  if (!avatarImage) {
    return false;
  }

  context.save();
  context.beginPath();
  context.arc(x + size / 2, y + size / 2, size / 2 - 3, 0, Math.PI * 2);
  context.clip();
  context.drawImage(avatarImage, x, y, size, size);
  context.restore();
  return true;
}

async function encodeImage(image, format = 'png') {
  return new Promise((resolve, reject) => {
    const outputStream = new PassThrough();
    const chunks = [];
    outputStream.on('data', (chunk) => chunks.push(chunk));
    outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    outputStream.on('error', reject);

    if (format === 'jpeg' || format === 'jpg') {
      pureImage.encodeJPEGToStream(image, outputStream, 88).catch(reject);
      return;
    }

    pureImage.encodePNGToStream(image, outputStream).catch(reject);
  });
}

function outputFormatFromPath(outputPath) {
  return /\.jpe?g$/i.test(outputPath || '') ? 'jpeg' : 'png';
}

async function renderCard(card, format = 'png') {
  loadFonts();

  const width = 1125;
  const padding = 45;
  const contentWidth = width - padding * 2;
  const topBarHeight = 14;
  const avatarTop = 44;
  const avatarSize = 87;
  const headerTextOffset = 109;
  const panelInset = 21;
  const accentColor = colorToCss(card.color);
  const measureImage = pureImage.make(1, 1);
  const measureContext = measureImage.getContext('2d');
  const descriptionLines = card.description
    ? wrapText(measureContext, card.description, FONTS.body.family, FONTS.body.size, contentWidth - 56)
    : [];
  const rows = (card.fields || [])
    .filter((field) => field && (field.name || field.value))
    .map((field) => {
      const labelLines = wrapText(measureContext, field.name, FONTS.label.family, FONTS.label.size, contentWidth - 56);
      const valueLines = wrapText(measureContext, field.value, FONTS.body.family, FONTS.body.size, contentWidth - 56);
      const progress = normalizeProgress(field.progress);
      const height = 26 +
        (labelLines.length * FONTS.label.lineHeight) +
        11 +
        (valueLines.length * FONTS.body.lineHeight) +
        (progress !== null ? 44 : 0) +
        17;
      return { labelLines, valueLines, progress, height };
    });

  const timestampText = new Date().toLocaleString('en-GB');
  const timestampInFooter = card.timestampPlacement === 'footer';
  const showHeaderTimestamp = !timestampInFooter && card.showHeaderTimestamp !== false;
  const footerLeft = card.footerLeft || card.footer || (timestampInFooter ? timestampText : null);
  const footerRight = card.footerRight || null;
  const descriptionHeight = descriptionLines.length > 0
    ? 24 + (descriptionLines.length * FONTS.body.lineHeight)
    : 0;
  const rowsHeight = rows.reduce((total, row) => total + row.height + 17, 0);
  const footerHeight = footerLeft || footerRight ? 57 : 0;
  const layoutBase = showHeaderTimestamp ? 174 : 155;
  const height = Math.max(390, layoutBase + descriptionHeight + rowsHeight + footerHeight + padding);
  const image = pureImage.make(width, height);
  const context = image.getContext('2d');

  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);
  context.fillStyle = accentColor;
  context.fillRect(0, 0, width, topBarHeight);

  const avatarImage = await loadAvatar(card.avatarUrl);
  const drewAvatar = drawAvatar(context, avatarImage, padding, avatarTop, avatarSize, accentColor);
  if (!drewAvatar) {
    const badge = (cardText(card.badge) || 'BOT').slice(0, 3).toUpperCase();
    setFont(context, FONTS.badge.family, FONTS.badge.size);
    context.fillStyle = COLORS.text;
    context.fillText(badge, padding + 18, 95);
  }

  setFont(context, FONTS.title.family, FONTS.title.size);
  context.fillStyle = COLORS.text;
  context.fillText(
    truncateToWidth(measureContext, card.title || 'Voice Room Bot', FONTS.title.family, FONTS.title.size, contentWidth - headerTextOffset),
    padding + headerTextOffset,
    74
  );

  if (card.subtitle) {
    setFont(context, FONTS.subtitle.family, FONTS.subtitle.size);
    context.fillStyle = COLORS.subtitle;
    context.fillText(
      truncateToWidth(measureContext, card.subtitle, FONTS.subtitle.family, FONTS.subtitle.size, contentWidth - headerTextOffset),
      padding + headerTextOffset,
      113
    );
  }

  if (showHeaderTimestamp) {
    setFont(context, FONTS.date.family, FONTS.date.size);
    context.fillStyle = COLORS.muted;
    context.fillText(timestampText, padding + headerTextOffset, 143);
  }

  let cursorY = showHeaderTimestamp ? 174 : 155;
  if (descriptionLines.length > 0) {
    fillRoundedRect(context, padding, cursorY, contentWidth, descriptionHeight, 14, COLORS.panelSoft);
    drawLines(context, descriptionLines, padding + panelInset, cursorY + 39, FONTS.body.family, FONTS.body.size, FONTS.body.lineHeight, COLORS.text);
    cursorY += descriptionHeight + 18;
  }

  for (const row of rows) {
    fillRoundedRect(context, padding, cursorY, contentWidth, row.height, 14, COLORS.panel);
    context.fillStyle = accentColor;
    context.fillRect(padding, cursorY + 6, 8, row.height - 12);
    drawLines(context, row.labelLines, padding + panelInset, cursorY + 35, FONTS.label.family, FONTS.label.size, FONTS.label.lineHeight, COLORS.label);
    const valueY = cursorY + 35 + (row.labelLines.length * FONTS.label.lineHeight) + 17;
    const textBottom = drawLines(context, row.valueLines, padding + panelInset, valueY, FONTS.body.family, FONTS.body.size, FONTS.body.lineHeight, COLORS.text);

    if (row.progress !== null) {
      drawProgressBar(context, padding + panelInset, textBottom + 9, contentWidth - (panelInset * 2), 24, row.progress, accentColor);
    }

    cursorY += row.height + 17;
  }

  const footerY = height - 26;
  if (footerLeft) {
    setFont(context, FONTS.footer.family, FONTS.footer.size);
    context.fillStyle = COLORS.muted;
    context.fillText(
      truncateToWidth(measureContext, footerLeft, FONTS.footer.family, FONTS.footer.size, contentWidth / 2),
      padding,
      footerY
    );
  }

  if (footerRight) {
    const footerText = truncateToWidth(measureContext, footerRight, FONTS.footer.family, FONTS.footer.size, contentWidth / 2);
    const footerWidth = measureText(measureContext, footerText, FONTS.footer.family, FONTS.footer.size);
    setFont(context, FONTS.footer.family, FONTS.footer.size);
    context.fillStyle = COLORS.muted;
    context.fillText(footerText, width - padding - footerWidth, footerY);
  }

  return encodeImage(image, format);
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (inputPath === '--worker') {
    await runWorker(outputPath);
    return;
  }

  if (!inputPath || !outputPath) {
    throw new Error('Usage: node render-readable-card.js <input-json> <output-png> or node render-readable-card.js --worker <queue-dir>');
  }

  const card = JSON.parse(fs.readFileSync(inputPath, 'utf8').replace(/^\uFEFF/, ''));
  const outputDirectory = path.dirname(outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const image = await renderCard(card, outputFormatFromPath(outputPath));
  fs.writeFileSync(outputPath, image);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
}

async function processWorkerRequest(requestPath) {
  let errorPath = `${requestPath}.err`;

  try {
    const request = readJsonFile(requestPath);
    const outputPath = request.outputPath;
    errorPath = request.errorPath || errorPath;

    if (!request.card || !outputPath) {
      throw new Error('Worker request is missing card or outputPath.');
    }

    const image = await renderCard(request.card, outputFormatFromPath(outputPath));
    const tempOutputPath = `${outputPath}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(tempOutputPath, image);
    fs.renameSync(tempOutputPath, outputPath);
  } catch (error) {
    fs.writeFileSync(errorPath, `${error.stack || error.message || error}${os.EOL}`, 'utf8');
  } finally {
    fs.rmSync(requestPath, { force: true });
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runWorker(queueDir) {
  if (!queueDir) {
    throw new Error('Worker mode requires a queue directory.');
  }

  loadFonts();
  fs.mkdirSync(queueDir, { recursive: true });
  const pending = new Set();
  const parentPid = Number(process.env.READABLE_CARD_WORKER_PARENT_PID) || null;

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  while (true) {
    if (parentPid && process.ppid !== parentPid) {
      process.exit(0);
    }

    const requestPaths = fs.readdirSync(queueDir)
      .filter((fileName) => fileName.endsWith('.json'))
      .map((fileName) => path.join(queueDir, fileName));

    for (const requestPath of requestPaths) {
      if (pending.has(requestPath)) {
        continue;
      }

      pending.add(requestPath);
      processWorkerRequest(requestPath)
        .catch((error) => {
          const errorPath = `${requestPath}.err`;
          fs.writeFileSync(errorPath, `${error.stack || error.message || error}${os.EOL}`, 'utf8');
        })
        .finally(() => pending.delete(requestPath));
    }

    await delay(40);
  }
}

main().catch((error) => {
  fs.writeSync(2, `${error.stack || error.message || error}${os.EOL}`);
  process.exit(1);
});
