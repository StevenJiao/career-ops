#!/usr/bin/env node
/**
 * fetch-jds.mjs — Batch JD extractor (Playwright)
 *
 * Purpose:
 * - Reuse one Chromium session to fetch many JDs quickly.
 * - Save each JD to `jds/YYYY-MM-DD-<company>-<role>.txt` so pipeline can reference via `local:jds/...`.
 *
 * Usage:
 *   node batch/fetch-jds.mjs --input batch/batch-input.tsv [--outdir jds] [--date YYYY-MM-DD] [--waitms 2500]
 *
 * Expects TSV columns (like batch/batch-runner.sh):
 *   id  url  source  notes
 * Where:
 * - source = company (recommended)
 * - notes  = title/role (recommended)
 */

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'fs/promises';
import { basename, join } from 'path';

function parseArgs(argv) {
  const args = {
    input: null,
    outdir: 'jds',
    date: null,
    waitms: 2500,
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a.startsWith('--input=')) args.input = a.slice('--input='.length);
    else if (a === '--outdir') args.outdir = argv[++i];
    else if (a.startsWith('--outdir=')) args.outdir = a.slice('--outdir='.length);
    else if (a === '--date') args.date = argv[++i];
    else if (a.startsWith('--date=')) args.date = a.slice('--date='.length);
    else if (a === '--waitms') args.waitms = Number(argv[++i]);
    else if (a.startsWith('--waitms=')) args.waitms = Number(a.slice('--waitms='.length));
  }
  return args;
}

function toIsoDate(d) {
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'unknown';
}

function parseTsv(tsv) {
  const lines = tsv.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const cols = line.split('\t');
    if (cols[0] === 'id') continue;
    const [id, url, source, notes] = cols;
    if (!id || !url) continue;
    rows.push({ id: id.trim(), url: url.trim(), company: (source || '').trim(), title: (notes || '').trim() });
  }
  return rows;
}

async function main() {
  const { input, outdir, date, waitms } = parseArgs(process.argv);
  if (!input) {
    console.error('Usage: node batch/fetch-jds.mjs --input batch/batch-input.tsv [--outdir jds] [--date YYYY-MM-DD] [--waitms 2500]');
    process.exit(1);
  }

  const isoDate = toIsoDate(date);
  const tsv = await readFile(input, 'utf-8');
  const rows = parseTsv(tsv);
  if (rows.length === 0) {
    console.error(`No rows found in ${input} (expected TSV with header: id\\turl\\tsource\\tnotes)`);
    process.exit(1);
  }

  await mkdir(outdir, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let ok = 0;
  let failed = 0;

  try {
    for (const row of rows) {
      const companySlug = slugify(row.company || 'company');
      const roleSlug = slugify(row.title || 'role');
      // Include batch row id to prevent overwriting when multiple postings share the same title.
      const outPath = join(outdir, `${isoDate}-${companySlug}-${roleSlug}-${row.id}.txt`);

      try {
        await page.goto(row.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(Number.isFinite(waitms) ? waitms : 2500);
        const payload = await page.evaluate(() => {
          const title = document.title || '';
          const bodyText = (document.body && document.body.innerText) ? document.body.innerText : '';
          return { title, bodyText };
        });

        const text =
          `URL: ${row.url}\n` +
          `TITLE: ${payload.title}\n` +
          `SOURCE_FILE: ${basename(input)}\n` +
          `ID: ${row.id}\n` +
          `COMPANY: ${row.company}\n` +
          `ROLE: ${row.title}\n` +
          `---\n` +
          payload.bodyText.trim() +
          `\n`;

        await writeFile(outPath, text, 'utf-8');
        console.log(`${row.id}\t${row.url}\t${outPath}`);
        ok++;
      } catch (err) {
        console.error(`FAIL\t${row.id}\t${row.url}\t${err?.message || String(err)}`);
        failed++;
      }
    }
  } finally {
    await browser.close();
  }

  if (failed > 0) {
    console.error(`\nDone with errors: ${ok} saved, ${failed} failed`);
    process.exit(1);
  }

  console.error(`\nDone: ${ok} saved`);
}

main().catch((err) => {
  console.error('Fatal:', err?.message || String(err));
  process.exit(1);
});
