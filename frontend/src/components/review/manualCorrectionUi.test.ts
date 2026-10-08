import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

describe.runIf(process.platform === 'win32')('manual corrections in the isolated built renderer', () => {
  it('persists canonical edits, confirms conflicts/reruns and preserves old results across failure, pause, abandon and late response', async () => {
    const workspace = path.resolve(__dirname, '../../../..')
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-manual-ui-'))
    const version = JSON.parse(await fs.promises.readFile(path.join(workspace, 'package.json'), 'utf8')).version
    const seed = `
      (async () => {
        localStorage.setItem('language', 'en'); localStorage.setItem('theme', 'light');
        localStorage.setItem('delive_last_seen_version', ${JSON.stringify(version)});
        const now = Date.now(), hash = async text => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(b => b.toString(16).padStart(2, '0')).join('');
        const base = { createdAt: now, updatedAt: now, date: '2026-10-07', time: '10:00', status: 'completed', projectIds: ['long-folder'] };
        const padding = 'The remaining original sentences are deliberately unchanged for safe local corrections. '.repeat(4);
        const records = [
          { ...base, id: 'manual', title: 'UI Manual Only', transcript: 'opening alpha beta alpha gamma 👍🏽 decision. ' + padding },
          { ...base, id: 'published', title: 'UI Rejections', transcript: 'start alpha beta gamma finish. ' + padding },
          { ...base, id: 'legacy', title: 'UI Legacy', transcript: 'legacy prefix original. ' + padding, correction: { status: 'done', mode: 'quick', legacy: { correctedText: 'Previous legacy body', source: 'v3-corrected-text' } } },
          { ...base, id: 'many', title: 'UI Many Edits', transcript: Array.from({ length: 120 }, (_, i) => 't' + String(i).padStart(3, '0')).join(' ') + '\\n' + padding.repeat(32) },
          { ...base, id: 'manual-review', title: 'UI Manual Review', transcript: 'review start alpha beta tail. ' + padding },
        ];
        const pub = records[1], sourceHash = await hash(pub.transcript);
        const patch = { id: 'beta', shardId: 's', op: 'replace', sourceStart: 12, sourceEnd: 16, sourceText: 'beta', replacement: 'BETA', sourceTextHash: sourceHash, category: 'asr-substitution', reason: 'Synthetic correction', state: 'applied', origin: 'ai', locationVerified: true };
        const rejected = { ...patch, id: 'reject-alpha', sourceStart: 6, sourceEnd: 11, sourceText: 'alpha', replacement: 'ALPHA', state: 'rejected', rejectionReason: 'patch-conflict', modelIntent: { op: 'replace', oldText: 'alpha', replacement: 'ALPHA', before: 'start ', after: ' beta', category: 'asr-substitution', reason: 'Original model reason' } };
        const placeholder = { ...patch, id: 'reject-historical', sourceStart: 0, sourceEnd: 0, sourceText: '', replacement: 'GAMMA', state: 'rejected', rejectionReason: 'anchor-not-found-or-outside-core', origin: undefined, locationVerified: undefined };
        const corrected = pub.transcript.slice(0, 12) + 'BETA' + pub.transcript.slice(16), outputHash = await hash(corrected);
        pub.correction = { status: 'done', mode: 'quick', published: { id: 'old-publication', formatVersion: 1, revision: 1, baseTranscriptHash: sourceHash, outputTextHash: outputHash, correctedText: corrected, model: 'UI model', completedAt: now, patches: [patch, rejected, placeholder], stats: { applied: 1, reverted: 0, rejected: 2 } } };
        pub.postProcess = { status: 'success', summary: 'Summary before manual changes', sourceKind: 'published-correction', sourceTextHash: outputHash, sourceResultId: 'old-publication' };
        const many = records[3], manyHash = await hash(many.transcript), manyPatches = Array.from({ length: 120 }, (_, i) => ({ ...patch, id: 'bulk-' + i, shardId: 'bulk-' + Math.floor(i / 60), sourceStart: i * 5, sourceEnd: i * 5 + 4, sourceText: 't' + String(i).padStart(3, '0'), replacement: i === 0 ? 'L'.repeat(1000) : 'T' + String(i).padStart(3, '0'), sourceTextHash: manyHash }));
        let manyText = many.transcript; for (const item of [...manyPatches].reverse()) manyText = manyText.slice(0, item.sourceStart) + item.replacement + manyText.slice(item.sourceEnd);
        many.correction = { status: 'done', mode: 'quick', published: { id: 'bulk-publication', formatVersion: 1, revision: 1, baseTranscriptHash: manyHash, outputTextHash: await hash(manyText), correctedText: manyText, model: 'UI model', completedAt: now, patches: manyPatches, stats: { applied: 120, reverted: 0, rejected: 0 } } };
        const review = records[4], reviewHash = await hash(review.transcript), start = review.transcript.indexOf('alpha');
        review.correction = { status: 'reviewing', mode: 'review', draft: {
          runId: 'manual-review-run', trigger: 'manual-review', requestedAt: now, updatedAt: now,
          mode: 'review', status: 'ready-for-review', revision: 1, baseTranscriptHash: reviewHash,
          config: { provider: 'openai-compatible', baseUrl: 'https://ui.invalid/v1', model: 'UI model',
            promptLanguage: 'en', structuredOutput: 'json_schema', credentialRef: 'ai-post-process',
            glossary: [], concurrency: 1, chunkSize: 6000, contextSize: 1000,
            safetyLimits: { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 0.2, maxNetLengthChangeRatio: 0.1 } },
          shards: [], proposedPatches: [{ ...patch, id: 'review-alpha', sourceStart: start, sourceEnd: start+5,
            sourceText: 'alpha', replacement: 'ALPHA', sourceTextHash: reviewHash, state: 'proposed' }],
          rejectedPatches: [{ ...placeholder, id: 'review-rejected', sourceTextHash: reviewHash }],
        } };
        localStorage.setItem('desktoplive_topics', JSON.stringify([{ id: 'long-folder', name: 'Long folder name that must never hide counts or menu controls'.repeat(3), emoji: '', createdAt: now, updatedAt: now }]));
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('delive-app', 4); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction(['sessions', 'settings'], 'readwrite'); for (const record of records) tx.objectStore('sessions').put(record);
          const r = tx.objectStore('settings').get('app_settings'); r.onsuccess = () => tx.objectStore('settings').put({ id: 'app_settings', data: { ...(r.result?.data || {}), autoSavePublishedCorrection: false, aiPostProcess: { enabled: false } } }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
      })()
    `
    const helpers = `
      (async () => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        const wait = async (predicate, label) => { for (let i = 0; i < 500; i++) { if (await predicate()) return; await sleep(20); } throw new Error('Manual UI timeout: ' + label + ': ' + document.body.innerText.slice(-2500)); };
        const button = (text, scope = document) => Array.from(scope.querySelectorAll('button')).find(b => b.getClientRects().length && (b.textContent.trim() === text || b.getAttribute('aria-label') === text));
        const click = async (text, scope = document) => { await wait(() => button(text, scope) && !button(text, scope).disabled, text); const b = button(text, scope); b.scrollIntoView({ block: 'nearest' }); b.focus(); b.click(); await sleep(40); };
        const input = (element, value) => { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };
        const read = async id => { const db = await new Promise(resolve => { const r = indexedDB.open('delive-app', 4); r.onsuccess = () => resolve(r.result); }); const record = await new Promise(resolve => { const r = db.transaction('sessions').objectStore('sessions').get(id); r.onsuccess = () => resolve(r.result); }); db.close(); return record; };
        const open = async title => { const row = () => document.querySelector('[role=button][aria-label="' + title + '"]'); if (!row()?.getClientRects().length && button('Back to list')) await click('Back to list'); await wait(() => row()?.getClientRects().length, title); row().scrollIntoView({ block: 'nearest' }); row().click(); await wait(() => document.querySelector('#session-review-title')?.textContent === title, title + ' selected'); await click('AI Correction'); };
        const dialog = () => document.querySelector('[role=dialog][aria-labelledby=manual-correction-title]');
        const replacement = () => dialog().querySelector('textarea:not([readonly])');
        const locate = async (query, index = 0) => { input(dialog().querySelector('input:not([type=radio])'), query); await wait(() => dialog().querySelectorAll('input[type=radio]').length > index, 'locations for ' + query); dialog().querySelectorAll('input[type=radio]')[index].click(); await sleep(30); };
        const chooseSelection = async (start, end) => { await click('Original selection / insertion point', dialog()); const source = dialog().querySelector('textarea[readonly]'); source.focus(); source.setSelectionRange(start, end); source.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true })); await click(start === end ? 'Use insertion point' : 'Use selection', dialog()); };
        const add = async () => { await click('Add correction'); await wait(dialog, 'manual editor'); };
        const save = async () => { await click('Save and apply', dialog()); await wait(() => !dialog(), 'manual publication'); };
        window.ui = { sleep, assert, wait, button, click, input, read, open, dialog, replacement, locate, chooseSelection, add, save };
        await wait(() => button('Test Configuration'), 'initial settings gate'); await click('Review');
      })()
    `
    const manual = `
      (async () => {
        const { assert, wait, button, click, input, read, open, dialog, replacement, locate, chooseSelection, add, save, sleep } = window.ui;
        let requests = 0; window.fetch = async () => { requests++; throw new Error('Manual-only operation unexpectedly requested AI'); };
        await open('UI Manual Only'); await add();
        input(dialog().querySelector('input:not([type=radio])'), 'alpha'); await wait(() => dialog().querySelectorAll('input[type=radio]').length === 2, 'repeated matches');
        assert(button('Save and apply', dialog()).disabled && !dialog().querySelector('input[type=radio]:checked'), 'repeated search silently chose first location');
        const controls = Array.from(dialog().querySelectorAll('button,input,textarea')).filter(e => !e.disabled && e.getClientRects().length); controls[0].focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })); assert(dialog().contains(document.activeElement), 'editor focus escaped');
        await locate('alpha', 1); input(replacement(), 'ALPHA'); await save();
        const first = await read('manual'), manualId = first.correction.published.patches[0].id;
        assert(first.correction.published.patches[0].sourceStart === first.transcript.lastIndexOf('alpha') && first.correction.published.patches[0].origin === 'manual', 'manual edit used corrected coordinates or first match');
        assert(requests === 0 && button('Run again').disabled, 'manual-only correction requires AI config');
        assert(document.querySelector('[data-correction-workspace]').compareDocumentPosition(document.querySelector('[data-correction-body]')) & Node.DOCUMENT_POSITION_FOLLOWING, 'workspace follows correction body');
        await click('Edit', document.querySelector('[data-correction-patch="' + manualId + '"]')); await wait(dialog, 'edit'); input(replacement(), 'Alpha'); await save();
        assert((await read('manual')).correction.published.patches.length === 1, 'same-range editing duplicated a patch');
        await click('Revert', document.querySelector('[data-correction-patch="' + manualId + '"]')); await wait(async () => (await read('manual')).correction.published.stats.reverted === 1, 'revert');
        await click('Reverted 1'); await click('Apply', document.querySelector('[data-correction-patch="' + manualId + '"]')); await wait(async () => (await read('manual')).correction.published.stats.applied === 1, 'restore'); await click('Applied 1');
        await add(); await locate('beta'); input(replacement(), ''); await save(); assert((await read('manual')).correction.published.patches.some(p => p.op === 'delete'), 'delete not saved');
        await add(); const original = (await read('manual')).transcript; await chooseSelection(original.length, original.length); input(replacement(), '!'); await save(); assert((await read('manual')).correction.published.correctedText.endsWith('!'), 'explicit insertion not saved');
        const stable = JSON.stringify((await read('manual')).correction.published);
        await add(); await chooseSelection(original.indexOf('👍🏽') + 2, original.indexOf('👍🏽') + 2); input(replacement(), 'x'); await click('Save and apply', dialog()); await wait(() => dialog().textContent.includes('splits a complete character'), 'Unicode rejection'); await click('Cancel', dialog());
        await add(); await locate('alpha'); input(replacement(), 'alpha'); await click('Save and apply', dialog()); await wait(() => dialog().textContent.includes('must differ'), 'no-op rejection'); await click('Cancel', dialog());
        await add(); await chooseSelection(0, original.length); input(replacement(), 'smaller text'); await click('Save and apply', dialog()); await wait(() => dialog().textContent.includes('total edit ratio'), 'aggregate safety'); await click('Cancel', dialog());
        assert(JSON.stringify((await read('manual')).correction.published) === stable && requests === 0, 'invalid or cancelled edit changed publication');
        await click('Transcript'); await click('Summary'); await click('AI Correction'); assert(button('Applied 3'), 'manual changes lost across tabs');
        await open('UI Rejections'); await click('Rejected 2');
        await click('Revalidate and apply', document.querySelector('[data-correction-patch=reject-alpha]')); await wait(dialog, 'verified recovery'); assert(!button('Save and apply', dialog()).disabled, 'verified location was not revalidated'); await save(); await wait(() => document.querySelector('[data-correction-patch=reject-alpha]')?.textContent.includes('Manually handled'), 'recovery label');
        await click('Locate and apply', document.querySelector('[data-correction-patch=reject-historical]')); await wait(dialog, 'historical recovery'); assert(button('Save and apply', dialog()).disabled && dialog().textContent.includes('no reliable source range'), 'historical placeholder became a location'); await locate('gamma'); input(replacement(), 'GAMMA'); await save();
        const recovered = await read('published'); assert(recovered.correction.published.stats.rejected === 2 && recovered.correction.published.patches.filter(p => p.recoveredFromPatchId).length === 2, 'recovery lost evidence or created duplicates');
        assert(recovered.postProcess.sourceResultId === 'old-publication' && recovered.postProcess.sourceTextHash !== recovered.correction.published.outputTextHash, 'manual edit silently matched old summary');
        await click('Applied 3'); await add(); await locate('alpha beta'); input(replacement(), 'AB'); const beforeConflict = JSON.stringify((await read('published')).correction.published); await click('Save and apply', dialog()); await wait(() => document.querySelector('#action-dialog-title')?.textContent === 'Replace overlapping corrections', 'conflict confirmation');
        assert(document.querySelector('[role=dialog][aria-labelledby=action-dialog-title]').textContent.includes('BETA'), 'conflict preview omitted overlapping item'); await click('Cancel replacement'); assert(JSON.stringify((await read('published')).correction.published) === beforeConflict, 'conflict cancel mutated');
        await click('Save and apply', dialog()); await click('Revert overlaps and apply'); await wait(() => !dialog(), 'atomic replacement');
        const overlapped = await read('published'); assert(overlapped.correction.published.stats.reverted === 2 && overlapped.correction.published.stats.applied === 2, 'conflict replacement not atomic');
        await click('Reverted 2'); const alpha = overlapped.correction.published.patches.find(p => p.recoveredFromPatchId === 'reject-alpha'); await click('Apply', document.querySelector('[data-correction-patch="' + alpha.id + '"]')); await wait(() => document.querySelector('#action-dialog-title'), 'restore conflict'); await click('Cancel'); assert((await read('published')).correction.published.revision === overlapped.correction.published.revision, 'restore conflict cancelled incorrectly');
        await click('Apply', document.querySelector('[data-correction-patch="' + alpha.id + '"]')); await click('Revert overlaps and restore'); await wait(async () => (await read('published')).correction.published.patches.find(p => p.id === alpha.id).state === 'applied', 'confirmed restore');
        await open('UI Legacy'); assert(!button('Add correction') && document.body.textContent.includes('no trusted patches'), 'Legacy offers unsafe patch editing');
        await open('UI Manual Review'); await add(); await locate('beta'); input(replacement(), 'BETA'); await click('Save candidate', dialog()); await wait(() => !dialog(), 'manual candidate saved');
        const draft = await read('manual-review'); assert(!draft.correction.published && draft.correction.draft.proposedPatches.length === 2, 'manual candidate published before review');
        await click('Review candidate: alpha'); await click('Unselected 1'); const inline = document.querySelector('textarea[aria-label="Suggested replacement"]'); input(inline, 'A'); inline.focus(); await click('Selected 1');
        await click('Transcript'); await click('Summary'); await click('AI Correction'); await wait(() => button('Selected 1') && button('Unselected 1'), 'manual review choices survived unmount');
        await click('Apply 1 locally'); await wait(async () => Boolean((await read('manual-review')).correction.published), 'review publication');
        const reviewed = await read('manual-review'); assert(reviewed.transcript === draft.transcript && reviewed.correction.published.stats.applied === 1 && reviewed.correction.published.stats.reverted === 1 && reviewed.correction.published.stats.rejected === 1 && reviewed.correction.published.correctedText.includes('alpha BETA'), 'Review ignored candidate selection or lost rejection');
        assert(requests === 0, 'manual review called AI');
        return ['manual-only add/edit/revert/restore, repeated locations, insert/delete, Unicode/no-op/aggregate guard', 'canonical immutable original, focus, tabs, rejection evidence and summary mismatch', 'atomic conflict replacement/cancel and restored overlap confirmation', 'manual Review candidates, blur save, selection retention and publication without AI'];
      })()
    `
    const configure = (model: string) => `
      (async () => {
        const db = await new Promise(resolve => { const r = indexedDB.open('delive-app', 4); r.onsuccess = () => resolve(r.result); });
        await new Promise((resolve, reject) => { const tx = db.transaction('settings', 'readwrite'), store = tx.objectStore('settings'), r = store.get('app_settings'); r.onsuccess = () => { const settings = { ...(r.result?.data || {}), autoSavePublishedCorrection: false, aiPostProcess: { enabled: true, provider: 'openai-compatible', baseUrl: 'https://ui.invalid/v1', apiKey: 'ui-test-only', defaultModel: ${JSON.stringify(model)}, model: ${JSON.stringify(model)}, selectedModels: [${JSON.stringify(model)}], availableModels: [${JSON.stringify(model)}], correctionMode: 'quick', enableStreaming: false } }; store.put({ id: 'app_settings', data: settings }); localStorage.setItem('desktoplive_settings', JSON.stringify(settings)); }; tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
      })()
    `
    const transport = `
      (() => {
        window.requests = 0; window.responseMode = 'success'; window.heldRequests = [];
        const response = () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ patches: [{ op: 'replace', oldText: 'alpha', replacement: 'AI-ALPHA', before: 'opening ', after: ' beta', category: 'asr-substitution', reason: 'Synthetic rerun' }] }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        window.fetch = async (_url, options) => { window.requests++; if (window.responseMode === 'fail') return new Response('Synthetic unauthorized', { status: 401 });
          if (window.responseMode.startsWith('hold')) return new Promise((resolve, reject) => { window.heldRequests.push(() => resolve(response())); if (window.responseMode !== 'hold-ignore-abort') options.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }); return response(); };
      })()
    `
    const reruns = `
      (async () => {
        const { assert, wait, click, read, open, button, sleep } = window.ui;
        await open('UI Manual Only'); const previous = (await read('manual')).correction.published, snapshot = JSON.stringify(previous);
        await click('Run again'); await wait(() => document.querySelector('#action-dialog-title')?.textContent === 'Redetect and replace corrections', 'rerun confirm'); await click('Cancel'); assert(window.requests === 0 && !(await read('manual')).correction.draft && JSON.stringify((await read('manual')).correction.published) === snapshot, 'cancel created a task or discarded edits');
        window.responseMode = 'fail'; await click('Run again'); await click('Confirm redetection'); await wait(async () => (await read('manual')).correction.draft?.status === 'blocked-auth', 'failed rerun'); assert(JSON.stringify((await read('manual')).correction.published) === snapshot && document.body.textContent.includes('Previous result (read-only)'), 'failed rerun lost old result');
        await click('Abandon'); await click('Abandon', document.querySelector('[role=dialog][aria-labelledby=action-dialog-title]')); await wait(async () => !(await read('manual')).correction.draft, 'abandon failed draft');
        window.responseMode = 'hold'; await click('Run again'); await click('Confirm redetection'); await wait(() => window.heldRequests.length > 0, 'held request'); assert(document.querySelectorAll('[data-correction-workspace] button').length && !button('Add correction'), 'old publication not read-only');
        await click('Pause'); await wait(async () => (await read('manual')).correction.draft?.status === 'paused', 'pause during start promise'); assert(JSON.stringify((await read('manual')).correction.published) === snapshot, 'pause discarded old edits');
        return ['rerun cancel has zero requests/data changes; failure and pause preserve the exact old publication'];
      })()
    `
    const rebuilt = `
      (async () => {
        const { assert, wait, click, read, open, button } = window.ui; await open('UI Manual Only');
        const paused = await read('manual'), oldRun = paused.correction.draft.runId, publication = JSON.stringify(paused.correction.published);
        await click('Resume'); await click('Cancel'); assert(window.requests === 0 && (await read('manual')).correction.draft.runId === oldRun, 'config-change cancellation rebuilt draft');
        window.responseMode = 'hold-ignore-abort'; await click('Resume'); await click('Confirm redetection'); await wait(() => window.heldRequests.length > 0, 'rebuilt request'); const rebuilt = await read('manual'); assert(rebuilt.correction.draft.runId !== oldRun && JSON.stringify(rebuilt.correction.published) === publication, 'configuration rebuild merged or deleted old result');
        await click('Abandon'); await click('Abandon', document.querySelector('[role=dialog][aria-labelledby=action-dialog-title]')); await wait(async () => !(await read('manual')).correction.draft, 'active abandonment'); window.heldRequests.forEach(resolve => resolve()); await wait(() => !button('Run again').disabled, 'late response drained'); assert(JSON.stringify((await read('manual')).correction.published) === publication, 'late response overwrote old result');
        window.responseMode = 'success'; await click('Run again'); await click('Confirm redetection'); await wait(async () => (await read('manual')).correction.published.id !== paused.correction.published.id && !(await read('manual')).correction.draft, 'new publication'); const result = await read('manual'); assert(result.correction.published.patches.length === 1 && result.correction.published.patches[0].origin === 'ai' && !result.correction.published.correctedText.endsWith('!'), 'successful rerun merged old manual items');
        await open('UI Legacy'); const count = window.requests; await click('Run patch detection'); await click('Cancel'); assert(window.requests === count && (await read('legacy')).correction.legacy.correctedText === 'Previous legacy body', 'Legacy cancel changed state');
        return ['configuration rebuild confirmation/cancel, active abandonment and late-response isolation', 'successful rerun replaces rather than merges the old manual set; Legacy rerun cancel preserves history'];
      })()
    `
    const layout = (theme: string) => `
      (async () => {
        const { assert, wait, click, open, button, sleep } = window.ui;
        const dark = ${JSON.stringify(theme)} === 'dark'; if (document.documentElement.classList.contains('dark') !== dark) await click(dark ? 'Switch to dark mode' : 'Switch to light mode'); await wait(() => document.documentElement.classList.contains('dark') === dark, 'theme');
        await open('UI Many Edits');
        await wait(() => document.querySelector('[data-review-layout]')?.getAttribute('data-review-layout') === (innerWidth >= 1024 ? 'split' : 'single'), 'measured review layout at ' + innerWidth);
        if (innerWidth >= 1024) await wait(() => document.querySelector('[role=separator][aria-controls=review-folders]'), 'measured folder separator at ' + innerWidth);
        const workspace = document.querySelector('[data-correction-workspace]'), list = workspace.querySelector('[aria-label="Correction items"]'), body = document.querySelector('[data-correction-body]');
        assert(workspace.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING, 'bulk list after body'); assert(list.getBoundingClientRect().height <= 290 && list.scrollHeight > list.clientHeight, '120-item list pushes body away');
        body.scrollIntoView({ block: 'start' }); await sleep(50); assert(body.getBoundingClientRect().top < innerHeight, 'body not reachable');
        workspace.parentElement.scrollIntoView({ block: 'start' }); await sleep(50); const filtersTop = workspace.querySelector('[aria-label="Correction status filters"]').getBoundingClientRect().top;
        const last = list.querySelector('[data-correction-patch="bulk-119"] button'); last.focus(); last.scrollIntoView({ block: 'nearest' }); assert(last.getBoundingClientRect().bottom <= list.getBoundingClientRect().bottom + 1, 'keyboard cannot reach last card'); list.scrollTop = 0;
        assert(Math.abs(workspace.querySelector('[aria-label="Correction status filters"]').getBoundingClientRect().top - filtersTop) < 1, 'scrolling item list moved filters');
        assert(document.documentElement.scrollWidth <= innerWidth && workspace.scrollWidth <= workspace.clientWidth && body.scrollWidth <= body.clientWidth, 'long correction overflows at ' + innerWidth + '/' + ${JSON.stringify(theme)});
        if (innerWidth >= 1024) {
          const separator = document.querySelector('[role=separator][aria-controls=review-folders]'); assert(separator, 'desktop folder resize missing');
          if (innerWidth === 1440) { separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })); await sleep(40); }
          const preferred = JSON.parse(localStorage.getItem('delive-review-view')).state.reviewFolderWidth; assert(preferred === 260, 'window clamp overwrote folder preference');
          if (innerWidth === 1024) assert(Number(separator.getAttribute('aria-valuenow')) < preferred, 'narrow window did not clamp actual width');
          const row = document.querySelector('#review-folders button[title^="Long folder"]'); assert(row && row.querySelector('span').getBoundingClientRect().width > 0 && getComputedStyle(row.querySelector('span')).textOverflow === 'ellipsis', 'long folder label absent or not truncated');
          assert(row.nextElementSibling.getBoundingClientRect().right <= row.parentElement.getBoundingClientRect().right + 1, 'long folder name hid menu');
          assert(Math.abs(document.querySelector('[data-review-layout]').getBoundingClientRect().left - document.querySelector('aside').getBoundingClientRect().width) < 1, 'navigation offset mismatch');
        } else {
          await click('Choose folder'); const drawer = document.querySelector('[role=dialog][aria-label=Folders]'); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1; const c = canvas.getContext('2d'); c.fillStyle = getComputedStyle(drawer).backgroundColor; c.fillRect(0,0,1,1); assert(c.getImageData(0,0,1,1).data[3] === 255, 'drawer translucent'); await click('Close folders');
        }
        workspace.parentElement.scrollIntoView({ block: 'start' }); await sleep(50);
        return { width: innerWidth, theme: ${JSON.stringify(theme)}, cards: list.querySelectorAll('article').length, listHeight: list.getBoundingClientRect().height, workspaceToBody: body.getBoundingClientRect().top - workspace.getBoundingClientRect().top, bodyTop: body.getBoundingClientRect().top };
      })()
    `
    const simulatePreviousWidths = `
      (async () => {
        const changes = [], set = (element, styles) => { if (!element) return; changes.push([element, element.getAttribute('style')]); Object.assign(element.style, styles); };
        set(document.querySelector('aside'), { width: '224px' }); set(document.querySelector('div[style*="margin-left"]'), { marginLeft: '224px' });
        set(document.querySelector('#review-folders'), { width: '220px' }); set(document.querySelector('[role=separator][aria-controls=review-folders]'), { display: 'none' });
        set(document.querySelector('nav[aria-label=Settings]'), { width: '192px' }); set(document.querySelector('.max-w-5xl.space-y-6'), { maxWidth: '672px', marginLeft: 'auto', marginRight: 'auto' });
        const label = document.createElement('div'); label.textContent = 'Previous-width simulation (not an old-version screenshot): navigation 224px, folders 220px, settings 192px'; Object.assign(label.style, { position: 'fixed', bottom: '0', left: '0', right: '0', zIndex: '200', padding: '8px', fontSize: '12px', color: '#111', background: '#fff2cc' }); document.body.append(label);
        window.restoreWidthSimulation = () => { for (const [element, style] of changes) { if (style === null) element.removeAttribute('style'); else element.setAttribute('style', style); } label.remove(); };
        await new Promise(resolve => setTimeout(resolve, 350)); return document.querySelector('section[aria-label="Session document"]')?.getBoundingClientRect().width;
      })()
    `
    const script = `
      const { app, BrowserWindow } = require('electron'), fs = require('fs'), path = require('path'); app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
      app.whenReady().then(async () => { let win; try {
        win = new BrowserWindow({ show: false, frame: false, width: 1440, height: 950, webPreferences: { backgroundThrottling: false, preload: ${JSON.stringify(path.join(root, 'preload.cjs'))}, contextIsolation: true, nodeIntegration: false } });
        win.webContents.on('console-message', event => { if (event.level === 'error') console.error('MANUAL_RENDERER', event.message); });
        const url = ${JSON.stringify(path.join(workspace, 'frontend/dist/index.html'))}; await win.loadFile(url); await win.webContents.executeJavaScript(${JSON.stringify(seed)}); await win.loadFile(url); await win.webContents.executeJavaScript(${JSON.stringify(helpers)});
        const results = await win.webContents.executeJavaScript(${JSON.stringify(manual)}); await win.webContents.executeJavaScript(${JSON.stringify(configure('UI model'))}); await win.loadFile(url); await win.webContents.executeJavaScript(${JSON.stringify(helpers)}); await win.webContents.executeJavaScript(${JSON.stringify(transport)}); results.push(...await win.webContents.executeJavaScript(${JSON.stringify(reruns)}));
        await win.webContents.executeJavaScript(${JSON.stringify(configure('UI model changed'))}); await win.loadFile(url); await win.webContents.executeJavaScript(${JSON.stringify(helpers)}); await win.webContents.executeJavaScript(${JSON.stringify(transport)}); results.push(...await win.webContents.executeJavaScript(${JSON.stringify(rebuilt)}));
        await win.webContents.executeJavaScript('(async()=>{await window.ui.click("Expand sidebar"); await window.ui.wait(()=>Math.abs(document.querySelector("aside").getBoundingClientRect().width-176)<0.5,"expanded width"); window.ui.assert(Array.from(document.querySelectorAll("aside nav[role=navigation] button")).every(b=>b.title===b.getAttribute("aria-label")),"truncated navigation lacks full tooltip");})()');
        await win.loadFile(url); await win.webContents.executeJavaScript(${JSON.stringify(helpers)}); await win.webContents.executeJavaScript(${JSON.stringify(transport)});
        await win.webContents.executeJavaScript('(async()=>{window.ui.assert(document.querySelector("aside").getBoundingClientRect().width===176,"existing expanded preference lost on restart"); await window.ui.click("Collapse sidebar"); await window.ui.wait(()=>Math.abs(document.querySelector("aside").getBoundingClientRect().width-56)<0.5,"collapsed navigation settled");})()');
        const capture = process.env.DELIVE_REVIEW_CAPTURE_DIR; if (capture) { fs.mkdirSync(capture, { recursive: true }); win.showInactive(); }
        for (const width of [1440, 1024, 768, 375]) { win.setContentSize(width, 950); for (const theme of ['light', 'dark']) {
          results.push(await win.webContents.executeJavaScript(theme === 'light' ? ${JSON.stringify(layout('light'))} : ${JSON.stringify(layout('dark'))}));
          if (width === 1440 && theme === 'light') {
            const drag = await win.webContents.executeJavaScript('(()=>{const e=document.querySelector("[role=separator][aria-controls=review-folders]"), b=e.getBoundingClientRect(); return {x:Math.round(b.x+b.width/2), y:Math.round(b.y+b.height/2), width:Number(e.getAttribute("aria-valuenow"))};})()');
            win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x, y: drag.y }); win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: drag.x, y: drag.y, clickCount: 1 }); win.webContents.sendInputEvent({ type: 'mouseMove', x: drag.x-45, y: drag.y }); win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: drag.x-45, y: drag.y, clickCount: 1 });
            await win.webContents.executeJavaScript('(async()=>{await window.ui.sleep(100); window.ui.assert(Number(document.querySelector("[role=separator][aria-controls=review-folders]").getAttribute("aria-valuenow"))<260,"native folder drag failed"); await window.ui.click("Reset folder width");})()');
            if (capture) {
              const before = await win.webContents.executeJavaScript(${JSON.stringify(simulatePreviousWidths)}); fs.writeFileSync(path.join(capture, 'correction-1440-previous-width-simulation.png'), (await win.webContents.capturePage()).toPNG());
              const after = await win.webContents.executeJavaScript('(async()=>{window.restoreWidthSimulation(); await window.ui.sleep(350); return document.querySelector("[data-correction-body]").closest("section[aria-label]").getBoundingClientRect().width;})()'); results.push({ comparison: 'previous-width simulation vs current defaults', previousDocumentWidth: before, currentDocumentWidth: after, reclaimedWidth: after-before });
            }
          }
          if (capture) { await win.webContents.executeJavaScript('(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))); await new Promise(r=>setTimeout(r,100));})()'); fs.writeFileSync(path.join(capture, 'correction-' + width + '-' + theme + '.png'), (await win.webContents.capturePage()).toPNG()); }
          if (width === 1440 && theme === 'light') await win.webContents.executeJavaScript('(()=>{document.querySelector("[role=separator][aria-controls=review-folders]").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true}));})()');
          await win.webContents.executeJavaScript('(async()=>{const u=window.ui; await u.click("Settings"); await u.click("AI Post-Processing"); await u.wait(()=>u.button("Fetch Model List"),"AI settings group visible"); const c=document.querySelector(".max-w-5xl.space-y-6"); u.assert(document.documentElement.scrollWidth<=innerWidth && c.scrollWidth<=c.clientWidth,"narrow settings overflow"); u.assert(Math.abs(c.getBoundingClientRect().left-c.parentElement.getBoundingClientRect().left-parseFloat(getComputedStyle(c.parentElement).paddingLeft))<1,"settings not left aligned"); const key=c.querySelector("input[type=password]"), toggle=key.parentElement.querySelector("button"); u.assert(toggle.getBoundingClientRect().right<=key.getBoundingClientRect().right && toggle.getBoundingClientRect().left>=key.getBoundingClientRect().left,"password action drifted outside bounded input"); if(innerWidth>=640) u.assert(document.querySelector("nav[aria-label=Settings]").getBoundingClientRect().width===160,"settings width");})()');
          if (capture) { await win.webContents.executeJavaScript('(async()=>{await Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))); await new Promise(r=>setTimeout(r,100));})()'); fs.writeFileSync(path.join(capture, 'settings-' + width + '-' + theme + '.png'), (await win.webContents.capturePage()).toPNG()); }
          if (capture && width === 1440 && theme === 'light') { await win.webContents.executeJavaScript(${JSON.stringify(simulatePreviousWidths)}); fs.writeFileSync(path.join(capture, 'settings-1440-previous-width-simulation.png'), (await win.webContents.capturePage()).toPNG()); await win.webContents.executeJavaScript('window.restoreWidthSimulation()'); }
          await win.webContents.executeJavaScript('window.ui.click("Review")');
        } }
        if (capture) fs.writeFileSync(path.join(capture, 'acceptance-metrics.json'), JSON.stringify(results, null, 2));
        console.log('MANUAL_UI_RESULT:' + JSON.stringify(results)); win.destroy(); app.quit();
      } catch (error) { console.error(error); win?.destroy(); app.exit(1); } });
    `
    await fs.promises.writeFile(path.join(root, 'preload.cjs'), `const { contextBridge } = require('electron'); contextBridge.exposeInMainWorld('electronAPI', { onApiGetSessions: () => () => {}, onApiGetSessionDetail: () => () => {}, onApiSearchSessions: () => () => {}, onApiGetTopics: () => () => {}, onApiGetTags: () => () => {}, onApiGetRecordingStatus: () => () => {}, apiUpdateOpenApiConfig: async () => {}, getFileStorageStatus: async () => ({ ok: true, status: { configuration: { mediaRoot: 'C:/UI-media', defaultTranscriptDirectory: null, projectTranscriptDirectories: {} }, media: { available: true, writable: true }, transcript: { available: true, writable: true }, projectTranscripts: {}, managedAssetCount: 0, managedBytes: 0, pendingOperationCount: 0, busy: false } }) });`)
    const entry = path.join(root, 'manual-ui.cjs')
    await fs.promises.writeFile(entry, script)
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
        const child = spawn(path.join(workspace, 'node_modules/electron/dist/electron.exe'), [entry], { env, shell: false, windowsHide: true })
        let output = ''; child.stdout.on('data', (data: Buffer) => { output += data.toString('utf8') }); child.stderr.on('data', (data: Buffer) => { output += data.toString('utf8') }); child.on('error', reject); child.on('close', code => resolve({ code, output }))
      })
      expect(result.code, result.output).toBe(0)
      expect(result.output).toContain('MANUAL_UI_RESULT:')
    } finally { await fs.promises.rm(root, { recursive: true, force: true }) }
  }, 120000)
})
