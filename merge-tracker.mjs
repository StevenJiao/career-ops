#!/usr/bin/env node
/**
 * merge-tracker.mjs — Merge batch tracker additions into applications.md
 *
 * Handles multiple TSV formats:
 * - 9-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes
 * - 8-col: num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport (no notes)
 * - Pipe-delimited (markdown table row): | col | col | ... |
 *
 * Dedup: company normalized + role fuzzy match + report number match
 * If duplicate with higher score → update in-place, update report link
 * Validates status against states.yml (rejects non-canonical, logs warning)
 *
 * Run: node career-ops/merge-tracker.mjs [--dry-run] [--verify]
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, renameSync, existsSync } from 'fs';
import { join, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const CAREER_OPS = dirname(fileURLToPath(import.meta.url));
// Support both layouts: data/applications.md (boilerplate) and applications.md (original)
const APPS_FILE = existsSync(join(CAREER_OPS, 'data/applications.md'))
  ? join(CAREER_OPS, 'data/applications.md')
  : join(CAREER_OPS, 'applications.md');
const ADDITIONS_DIR = join(CAREER_OPS, 'batch/tracker-additions');
const MERGED_DIR = join(ADDITIONS_DIR, 'merged');
const DRY_RUN = process.argv.includes('--dry-run');
const VERIFY = process.argv.includes('--verify');

// Canonical states and aliases
const CANONICAL_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];
const STATUS_RANK = new Map([
  ['Evaluated', 1],
  ['Applied', 2],
  ['Responded', 3],
  ['Interview', 4],
  ['Offer', 5],
  // Terminal-ish states; keep conservative merge rules below instead of rank-only behavior.
  ['Rejected', 90],
  ['Discarded', 90],
  ['SKIP', 10],
]);

function mergeStatus(existingStatusRaw, incomingStatusRaw, { allowTerminalOverride }) {
  const existing = validateStatus(existingStatusRaw);
  const incoming = validateStatus(incomingStatusRaw);

  // Never move away from hard terminal states unless explicitly allowed by caller.
  if (existing === 'Rejected' || existing === 'Discarded') return existing;

  // Allow marking terminal states only when explicitly requested (manual correction / exact match).
  if (incoming === 'Rejected' || incoming === 'Discarded') {
    return allowTerminalOverride ? incoming : existing;
  }

  // SKIP should be reversible (e.g., user decides to apply anyway).
  const existingRank = STATUS_RANK.get(existing) ?? 0;
  const incomingRank = STATUS_RANK.get(incoming) ?? 0;

  // Never downgrade status (Applied -> Evaluated, etc.).
  return incomingRank > existingRank ? incoming : existing;
}

function mergePdf(existingPdfRaw, incomingPdfRaw) {
  const existing = String(existingPdfRaw || '').trim();
  const incoming = String(incomingPdfRaw || '').trim();
  const hasCheck = (s) => s.includes('✅');

  if (hasCheck(existing)) return existing;
  if (hasCheck(incoming)) return incoming;
  return existing || incoming || '❌';
}

function validateStatus(status) {
  const clean = status.replace(/\*\*/g, '').replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim();
  const lower = clean.toLowerCase();

  for (const valid of CANONICAL_STATES) {
    if (valid.toLowerCase() === lower) return valid;
  }

  // Aliases
  const aliases = {
    // Spanish → English
    'evaluada': 'Evaluated', 'condicional': 'Evaluated', 'hold': 'Evaluated', 'evaluar': 'Evaluated', 'verificar': 'Evaluated',
    'aplicado': 'Applied', 'enviada': 'Applied', 'aplicada': 'Applied', 'applied': 'Applied', 'sent': 'Applied',
    'respondido': 'Responded',
    'entrevista': 'Interview',
    'oferta': 'Offer',
    'rechazado': 'Rejected', 'rechazada': 'Rejected',
    'descartado': 'Discarded', 'descartada': 'Discarded', 'cerrada': 'Discarded', 'cancelada': 'Discarded',
    'no aplicar': 'SKIP', 'no_aplicar': 'SKIP', 'skip': 'SKIP', 'monitor': 'SKIP',
    'geo blocker': 'SKIP',
  };

  if (aliases[lower]) return aliases[lower];

  // DUPLICADO/Repost → Discarded
  if (/^(duplicado|dup|repost)/i.test(lower)) return 'Discarded';

  console.warn(`⚠️  Non-canonical status "${status}" → defaulting to "Evaluated"`);
  return 'Evaluated';
}

function normalizeCompany(name) {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function roleFuzzyMatch(a, b) {
  const GENERIC = new Set([
    'software',
    'engineer',
    'engineering',
    'developer',
    'development',
    'product',
    'role',
    'roles',
    // Common role descriptors that are too broad to distinguish postings
    'backend',
    'frontend',
    'fullstack',
    'full',
    'stack',
    'platform',
    'infrastructure',
    'systems',
  ]);

  const SENIORITY = new Set([
    'intern',
    'junior',
    'jr',
    'mid',
    'intermediate',
    'senior',
    'sr',
    'staff',
    'principal',
    'lead',
    'manager',
    'director',
    'head',
    'founding',
  ]);

  const tokenize = (s) => s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.trim())
    .filter(w => w.length > 2 || w === 'ai' || w === 'ml');

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);

  // Avoid collapsing distinct seniority levels into one tracker row
  const seniorityA = new Set(wordsA.filter(w => SENIORITY.has(w)));
  const seniorityB = new Set(wordsB.filter(w => SENIORITY.has(w)));
  const seniorityMismatch = (() => {
    if (seniorityA.size === 0 && seniorityB.size === 0) return false;
    if (seniorityA.size !== seniorityB.size) return true;
    for (const w of seniorityA) if (!seniorityB.has(w)) return true;
    return false;
  })();
  if (seniorityMismatch) return false;

  const overlap = wordsA.filter(w => wordsB.some(wb => wb === w || wb.includes(w) || w.includes(wb)));
  const meaningfulOverlap = overlap.filter(w => !GENERIC.has(w) && !SENIORITY.has(w));

  // Prevent false positives like "Software Engineer, Backend" vs "Software Engineer, Compute"
  // where the only overlap is generic terms.
  if (meaningfulOverlap.length === 0) return false;

  // Prefer being conservative: require 2+ meaningful overlaps OR an exact match
  // on the non-generic token set (handles "Backend Engineer" vs "Backend Software Engineer").
  const nonGenericA = new Set(wordsA.filter(w => !GENERIC.has(w) && !SENIORITY.has(w)));
  const nonGenericB = new Set(wordsB.filter(w => !GENERIC.has(w) && !SENIORITY.has(w)));
  const sameNonGeneric = (() => {
    if (nonGenericA.size !== nonGenericB.size) return false;
    for (const w of nonGenericA) if (!nonGenericB.has(w)) return false;
    return true;
  })();

  // If both sets are empty, we're matching on generic words only — that's too risky.
  if (sameNonGeneric && nonGenericA.size > 0) return true;
  return meaningfulOverlap.length >= 2;
}

function extractReportNum(reportStr) {
  const m = reportStr.match(/\[(\d+)\]/);
  return m ? parseInt(m[1]) : null;
}

function parseScore(s) {
  const m = s.replace(/\*\*/g, '').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : 0;
}

function parseAppLine(line) {
  const parts = line.split('|').map(s => s.trim());
  if (parts.length < 9) return null;
  const num = parseInt(parts[1]);
  if (isNaN(num) || num === 0) return null;
  return {
    num, date: parts[2], company: parts[3], role: parts[4],
    score: parts[5], status: parts[6], pdf: parts[7], report: parts[8],
    notes: parts[9] || '', raw: line,
  };
}

/**
 * Parse a TSV file content into a structured addition object.
 * Handles: 9-col TSV, 8-col TSV, pipe-delimited markdown.
 */
function parseTsvContent(content, filename) {
  content = content.trim();
  if (!content) return null;

  let parts;
  let addition;

  // Detect pipe-delimited (markdown table row)
  if (content.startsWith('|')) {
    parts = content.split('|').map(s => s.trim()).filter(Boolean);
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed pipe-delimited ${filename}: ${parts.length} fields`);
      return null;
    }
    // Format: num | date | company | role | score | status | pdf | report | notes
    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      score: parts[4],
      status: validateStatus(parts[5]),
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
  } else {
    // Tab-separated
    parts = content.split('\t');
    if (parts.length < 8) {
      console.warn(`⚠️  Skipping malformed TSV ${filename}: ${parts.length} fields`);
      return null;
    }

    // Detect column order: some TSVs have (status, score), others have (score, status)
    // Heuristic: if col4 looks like a score and col5 looks like a status, they're swapped
    const col4 = parts[4].trim();
    const col5 = parts[5].trim();
    const col4LooksLikeScore = /^\d+\.?\d*\/5$/.test(col4) || col4 === 'N/A' || col4 === 'DUP';
    const col5LooksLikeScore = /^\d+\.?\d*\/5$/.test(col5) || col5 === 'N/A' || col5 === 'DUP';
    const col4LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)/i.test(col4);
    const col5LooksLikeStatus = /^(evaluated|applied|responded|interview|offer|rejected|discarded|skip|evaluada|aplicado|respondido|entrevista|oferta|rechazado|descartado|no aplicar|cerrada|duplicado|repost|condicional|hold|monitor)/i.test(col5);

    let statusCol, scoreCol;
    if (col4LooksLikeStatus && !col4LooksLikeScore) {
      // Standard format: col4=status, col5=score
      statusCol = col4; scoreCol = col5;
    } else if (col4LooksLikeScore && col5LooksLikeStatus) {
      // Swapped format: col4=score, col5=status
      statusCol = col5; scoreCol = col4;
    } else if (col5LooksLikeScore && !col4LooksLikeScore) {
      // col5 is definitely score → col4 must be status
      statusCol = col4; scoreCol = col5;
    } else {
      // Default: standard format (status before score)
      statusCol = col4; scoreCol = col5;
    }

    addition = {
      num: parseInt(parts[0]),
      date: parts[1],
      company: parts[2],
      role: parts[3],
      status: validateStatus(statusCol),
      score: scoreCol,
      pdf: parts[6],
      report: parts[7],
      notes: parts[8] || '',
    };
  }

  if (isNaN(addition.num) || addition.num === 0) {
    console.warn(`⚠️  Skipping ${filename}: invalid entry number`);
    return null;
  }

  return addition;
}

// ---- Main ----

// Read applications.md
if (!existsSync(APPS_FILE)) {
  console.log('No applications.md found. Nothing to merge into.');
  process.exit(0);
}
const appContent = readFileSync(APPS_FILE, 'utf-8');
const appLines = appContent.split('\n');
const existingApps = [];
let maxNum = 0;

for (const line of appLines) {
  if (line.startsWith('|') && !line.includes('---') && !line.includes('Empresa')) {
    const app = parseAppLine(line);
    if (app) {
      existingApps.push(app);
      if (app.num > maxNum) maxNum = app.num;
    }
  }
}

console.log(`📊 Existing: ${existingApps.length} entries, max #${maxNum}`);

// Read tracker additions
if (!existsSync(ADDITIONS_DIR)) {
  console.log('No tracker-additions directory found.');
  process.exit(0);
}

const tsvFiles = readdirSync(ADDITIONS_DIR).filter(f => f.endsWith('.tsv'));
if (tsvFiles.length === 0) {
  console.log('✅ No pending additions to merge.');
  process.exit(0);
}

// Sort files numerically for deterministic processing
tsvFiles.sort((a, b) => {
  // Use only the leading numeric prefix before the first dash.
  // Avoid accidental digit capture from the rest of the filename (e.g., "3d", dates, etc.).
  const getPrefix = (name) => {
    const head = name.split('-')[0] || '';
    return /^\d+$/.test(head) ? parseInt(head, 10) : 0;
  };
  const numA = getPrefix(a);
  const numB = getPrefix(b);
  return numA - numB;
});

console.log(`📥 Found ${tsvFiles.length} pending additions`);

let added = 0;
let updated = 0;
let skipped = 0;
const newLines = [];

for (const file of tsvFiles) {
  const content = readFileSync(join(ADDITIONS_DIR, file), 'utf-8').trim();
  const addition = parseTsvContent(content, file);
  if (!addition) { skipped++; continue; }

  // Check for duplicate by:
  // 1. Exact report number match
  // 2. Company + role fuzzy match
  const reportNum = extractReportNum(addition.report);
  let duplicate = null;
  let duplicateReason = null;

  if (reportNum) {
    // Check if this report number already exists
    duplicate = existingApps.find(app => {
      const existingReportNum = extractReportNum(app.report);
      return existingReportNum === reportNum;
    });
    if (duplicate) duplicateReason = 'reportNum';
  }
  if (!duplicate) {
    // Exact entry number match
    duplicate = existingApps.find(app => app.num === addition.num);
    if (duplicate) duplicateReason = 'entryNum';
  }

  if (!duplicate) {
    // Company + role fuzzy match
    const normCompany = normalizeCompany(addition.company);
    duplicate = existingApps.find(app => {
      if (normalizeCompany(app.company) !== normCompany) return false;
      return roleFuzzyMatch(addition.role, app.role);
    });
    if (duplicate) duplicateReason = 'fuzzy';
  }
  if (duplicate) {
    const newScore = parseScore(addition.score);
    const oldScore = parseScore(duplicate.score);

    const shouldForceUpdate = duplicateReason === 'reportNum' || duplicateReason === 'entryNum';

    if (shouldForceUpdate || newScore > oldScore) {
      console.log(`???? ${shouldForceUpdate ? "Correct" : "Update"}: #${duplicate.num} ${addition.company} ??? ${addition.role} (${oldScore}???${newScore})`);
      const lineIdx = appLines.indexOf(duplicate.raw);
      if (lineIdx >= 0) {
        const note = shouldForceUpdate
          ? addition.notes
          : `Re-eval ${addition.date} (${oldScore}???${newScore}). ${addition.notes}`;
        const mergedStatus = mergeStatus(duplicate.status, addition.status, { allowTerminalOverride: shouldForceUpdate });
        const mergedPdf = mergePdf(duplicate.pdf, addition.pdf);
        const updatedLine = `| ${duplicate.num} | ${addition.date} | ${addition.company} | ${addition.role} | ${addition.score} | ${mergedStatus} | ${mergedPdf} | ${addition.report} | ${note} |`;
        appLines[lineIdx] = updatedLine;
        updated++;
      }
    } else {
      console.log(`??????  Skip: ${addition.company} ??? ${addition.role} (existing #${duplicate.num} ${oldScore} >= new ${newScore})`);
      skipped++;
    }
  } else {
    // New entry — use the number from the TSV
    const entryNum = addition.num > maxNum ? addition.num : ++maxNum;
    if (addition.num > maxNum) maxNum = addition.num;

    const newLine = `| ${entryNum} | ${addition.date} | ${addition.company} | ${addition.role} | ${addition.score} | ${addition.status} | ${addition.pdf} | ${addition.report} | ${addition.notes} |`;
    newLines.push(newLine);
    added++;
    console.log(`➕ Add #${entryNum}: ${addition.company} — ${addition.role} (${addition.score})`);
  }
}

// Insert new lines after the header (line index of first data row)
if (newLines.length > 0) {
  // Find header separator (|---|...) and insert after it
  let insertIdx = -1;
  for (let i = 0; i < appLines.length; i++) {
    if (appLines[i].includes('---') && appLines[i].startsWith('|')) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx >= 0) {
    appLines.splice(insertIdx, 0, ...newLines);
  }
}

// Write back
if (!DRY_RUN) {
  writeFileSync(APPS_FILE, appLines.join('\n'));

  // Move processed files to merged/
  if (!existsSync(MERGED_DIR)) mkdirSync(MERGED_DIR, { recursive: true });
  for (const file of tsvFiles) {
    renameSync(join(ADDITIONS_DIR, file), join(MERGED_DIR, file));
  }
  console.log(`\n✅ Moved ${tsvFiles.length} TSVs to merged/`);
}

console.log(`\n📊 Summary: +${added} added, 🔄${updated} updated, ⏭️${skipped} skipped`);
if (DRY_RUN) console.log('(dry-run — no changes written)');

// Optional verify
if (VERIFY && !DRY_RUN) {
  console.log('\n--- Running verification ---');
  try {
    execFileSync('node', [join(CAREER_OPS, 'verify-pipeline.mjs')], { stdio: 'inherit' });
  } catch (e) {
    process.exit(1);
  }
}
