#!/usr/bin/env node

/**
 * fetch-jd.mjs — Extract job posting text with Playwright
 *
 * Purpose: Reliable JD extraction for SPA-heavy job boards (Ashby, Workday, etc.).
 * Keeps logic small and reusable; evaluation/reporting happens elsewhere.
 *
 * Usage:
 *   node batch/fetch-jd.mjs <url> [--out path.txt] [--waitms 2500]
 *
 * Exit codes:
 *   0 success
 *   1 failure
 */

import { chromium } from 'playwright';
import { writeFile } from 'fs/promises';

function parseArgs(argv) {
  const args = { url: null, out: null, waitms: 2500 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!args.url && !a.startsWith('--')) {
      args.url = a;
      continue;
    }
    if (a === '--out') {
      args.out = argv[++i];
      continue;
    }
    if (a.startsWith('--out=')) {
      args.out = a.slice('--out='.length);
      continue;
    }
    if (a === '--waitms') {
      args.waitms = Number(argv[++i]);
      continue;
    }
    if (a.startsWith('--waitms=')) {
      args.waitms = Number(a.slice('--waitms='.length));
      continue;
    }
  }
  return args;
}

async function main() {
  const { url, out, waitms } = parseArgs(process.argv);
  if (!url) {
    console.error('Usage: node batch/fetch-jd.mjs <url> [--out path.txt] [--waitms 2500]');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(Number.isFinite(waitms) ? waitms : 2500);

    const payload = await page.evaluate(() => {
      const title = document.title || '';
      const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
      return { title, bodyText };
    });

    const text =
      `URL: ${url}\n` +
      `TITLE: ${payload.title}\n` +
      `---\n` +
      payload.bodyText.trim() +
      `\n`;

    if (out) {
      await writeFile(out, text, 'utf-8');
      console.log(out);
    } else {
      process.stdout.write(text);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err?.message || String(err));
  process.exit(1);
});

