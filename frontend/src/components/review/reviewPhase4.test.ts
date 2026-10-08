import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { spawn } from 'child_process'

describe.runIf(process.platform === 'win32')('built review UI interactions in isolated Electron', () => {
  it('opens summaries, filters folders and tags, preserves search/date, manages topics and uses a narrow drawer', async () => {
    const workspace = path.resolve(__dirname, '../../../..')
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kilo', 'delive-review-ui-'))
    const entry = path.join(root, 'review-ui.cjs')
    const version = JSON.parse(await fs.promises.readFile(path.join(workspace, 'package.json'), 'utf8')).version
    const seed = `
      (async () => {
        localStorage.setItem('language', 'en');
        localStorage.setItem('delive_last_seen_version', ${JSON.stringify(version)});
        const now = Date.now(), today = new Date().toISOString().slice(0, 10), yesterday = new Date(now - 86400000).toISOString().slice(0, 10);
        const topic = (id, parentId) => ({ id, parentId, name: id, emoji: '', createdAt: now, updatedAt: now });
        localStorage.setItem('desktoplive_topics', JSON.stringify([topic('UI Root'), topic('UI Child', 'UI Root'), topic('UI Other')]));
        const base = { createdAt: now, updatedAt: now, date: today, time: '09:00', transcript: 'UI transcript', status: 'completed' };
        const records = [
          { ...base, id: 'ui-summary', title: 'UI Summary', projectIds: ['UI Root', 'UI Child'], tagIds: ['tag-a'], postProcess: { status: 'success', summary: 'UI unique summary' } },
          { ...base, id: 'ui-pending', title: 'UI Pending', date: yesterday, projectIds: ['UI Child'], tagIds: ['tag-b'], postProcess: { status: 'pending' } },
          { ...base, id: 'ui-empty', title: 'UI Empty', projectIds: [] },
          { ...base, id: 'ui-failed', title: 'UI Failed', projectIds: ['UI Other'], postProcess: { status: 'error', error: 'UI failure marker' } },
          { ...base, id: 'ui-orphan', title: 'UI Orphan', projectIds: ['missing-ui-topic'] },
        ];
        const reviewed = records[0];
        reviewed.transcript = 'UI transcript\\nUI missing speaker\\nUI final segment';
        reviewed.segments = [
          { text: 'UI transcript', speakerId: 'speaker-1', startMs: 0, endMs: 1000 },
          { text: 'UI missing speaker', startMs: 1000, endMs: 2000 },
          { text: 'UI final segment', speakerId: 'speaker-1', startMs: 2000, endMs: 3000 },
        ];
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reviewed.transcript)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
        reviewed.correction = { status: 'reviewing', mode: 'review', draft: {
          runId: 'UI-run', revision: 1, trigger: 'manual-review', mode: 'review', status: 'ready-for-review', baseTranscriptHash: hash,
          config: { model: 'UI model', baseUrl: 'https://ui.invalid/v1', promptLanguage: 'en', structuredOutput: 'prompt-json', chunkSize: 4000, contextSize: 500, concurrency: 1, credentialRef: 'ai-post-process', safetyLimits: { maxPatchTextLength: 1000, maxPatchesPerShard: 100, maxCumulativeEditRatio: 1, maxNetLengthChangeRatio: 1 } },
          shards: [], proposedPatches: [{ id: 'UI-patch', shardId: 'UI-shard', op: 'replace', sourceStart: 3, sourceEnd: 13, sourceText: 'transcript', replacement: 'text', sourceTextHash: hash, category: 'asr-substitution', reason: 'UI review candidate', state: 'proposed' }], rejectedPatches: [], requestedAt: now, updatedAt: now,
        } };
        reviewed.askHistory = [
          { id: 'UI-default-turn', conversationId: 'default', question: 'UI default question', answer: 'UI default answer', createdAt: now - 2, status: 'success' },
          { id: 'UI-sidebar-turn', conversationId: 'side-panel-ui-summary', question: 'UI sidebar question', answer: 'UI sidebar answer', createdAt: now - 1, status: 'success' },
        ];
        const largeTokens = Array.from({ length: 2000 }, (_, index) => ({ text: 'synthetic word ', isFinal: true, startMs: index * 100, endMs: index * 100 + 100 }));
        for (let i = 0; i < 100; i++) records.push({ ...base, id: 'large-library-' + i, title: i === 0 ? 'Long title ' + 'readable narrow session title '.repeat(30) : 'Large synthetic record ' + i,
          projectIds: ['unknown-large-topic'], tagIds: i === 0 ? ['tag-long'] : [], tokens: largeTokens, transcript: largeTokens.map(token => token.text).join('') });
        const db = await new Promise((resolve, reject) => { const request = indexedDB.open('delive-app', 4); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        await new Promise((resolve, reject) => {
          const tx = db.transaction(['sessions', 'tags', 'settings'], 'readwrite');
          for (const record of records) tx.objectStore('sessions').put(record);
          tx.objectStore('tags').put({ id: 'all_tags', data: [{ id: 'tag-a', name: 'UI Tag A', color: 'blue' }, { id: 'tag-b', name: 'UI Tag B', color: 'red' }, { id: 'tag-long', name: 'LongTag'.repeat(40), color: 'green' }] });
          const settings = tx.objectStore('settings').get('app_settings');
          settings.onsuccess = () => tx.objectStore('settings').put({ id: 'app_settings', data: { ...(settings.result?.data || {}), autoSavePublishedCorrection: false, aiPostProcess: { enabled: true, model: 'UI model', baseUrl: 'https://ui.invalid/v1', apiKey: 'ui-test-only', enableStreaming: false } } });
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
        });
        db.close();
      })()
    `
    const interactions = `
      (async () => {
        const results = [];
        const assert = (value, message) => { if (!value) throw new Error(message); };
        const wait = async (predicate, label = '') => { for (let i = 0; i < 1000; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); } throw new Error('UI wait timed out: ' + label + ': ' + document.body.innerText.slice(-2000)); };
        const buttons = () => Array.from(document.querySelectorAll('button'));
        const button = text => buttons().find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
        const click = async text => { await wait(() => button(text), text); button(text).focus(); button(text).click(); await new Promise(resolve => setTimeout(resolve, 30)); };
        const records = () => Array.from(document.querySelectorAll('[role=button]'));
        const selectedTab = () => document.querySelector('[role=tab][aria-selected=true]')?.textContent;
        const panel = () => document.querySelector('[role=tabpanel]').textContent;
        const open = async title => { await wait(() => records().some(r => r.textContent.includes(title))); records().find(r => r.textContent.includes(title)).click(); await wait(() => selectedTab() === 'Summary'); };
        await wait(() => button('Test Configuration'));
        await click('Review'); await wait(() => selectedTab() === 'Summary', 'default reading');
        assert(!document.querySelector('[data-heatmap]'), 'activity was not collapsed by default');
        await wait(() => document.querySelector('[data-review-layout=split]'), 'desktop measurement');
        assert(document.querySelector('nav[aria-label=Folders]').getClientRects().length, 'default folders hidden');
        assert(document.querySelector('aside').getBoundingClientRect().width === 56, 'default navigation is not compact');
        assert(document.querySelector('[data-review-layout]').getBoundingClientRect().left === 56, 'navigation offset leaves a blank strip');
        const folderSeparator = document.querySelector('[role=separator][aria-controls=review-folders]');
        assert(Number(folderSeparator.getAttribute('aria-valuenow')) === 176, 'folder default width changed');
        folderSeparator.focus(); folderSeparator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        await wait(() => Number(folderSeparator.getAttribute('aria-valuenow')) === 260, 'folder keyboard maximum');
        assert(JSON.parse(localStorage.getItem('delive-review-view')).state.reviewFolderWidth === 260, 'folder preference not independent');
        await click('Reset folder width');
        const separator = document.querySelector('[role=separator][aria-controls=review-session-list]'); assert(separator, 'list separator missing');
        separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        await wait(() => Number(separator.getAttribute('aria-valuenow')) === 280, 'keyboard minimum');
        separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        await wait(() => Number(separator.getAttribute('aria-valuenow')) === 300, 'keyboard increment');
        assert(JSON.parse(localStorage.getItem('delive-review-view')).state.reviewListWidth === 300, 'width not persisted');
        await click('Reset list width');
        await click('UI Root2');
        await wait(() => records().length === 2).catch(() => { throw new Error('parent scope not deduplicated: ' + document.body.innerText); });
        await open('UI Summary'); assert(panel().includes('UI unique summary'), 'existing summary missing');
        const headerButtons = () => Array.from(document.querySelector('#session-review-title').closest('div.flex.items-center.justify-between').querySelectorAll('button'));
        const edit = headerButtons().find(button => (button.getAttribute('aria-label') || '').toLowerCase() === 'edit title');
        edit.focus(); edit.click();
        await wait(() => Array.from(document.querySelectorAll('input')).some(input => (input.getAttribute('aria-label') || '').toLowerCase() === 'edit title'), 'title editor');
        const titleInput = Array.from(document.querySelectorAll('input')).find(input => (input.getAttribute('aria-label') || '').toLowerCase() === 'edit title');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(titleInput, 'UI Summary Edited'); titleInput.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 30)); titleInput.closest('form').requestSubmit();
        await wait(() => document.querySelector('#session-review-title')?.textContent === 'UI Summary Edited', 'title saved');
        const links = buttons().find(button => button.textContent.trim() === 'Manage topic links');
        links.focus(); links.click(); await wait(() => links.getAttribute('aria-expanded') === 'true');
        const childChoice = Array.from(links.parentElement.parentElement.querySelectorAll('label')).find(label => label.textContent.trim() === 'UI Child').querySelector('input');
        childChoice.click(); await wait(() => !childChoice.checked && !childChoice.disabled);
        childChoice.click(); await wait(() => childChoice.checked && !childChoice.disabled); links.click();
        results.push('large library: title editor/save and topic popup/toggle remain responsive');
        await click('Transcript');
        assert(panel().includes('UI transcript') && panel().includes('UI missing speaker') && panel().includes('UI final segment') && panel().includes('Unknown speaker'), 'mixed speaker segment lost');
        assert(!buttons().some(b => b.title === 'Jump to timestamp'), 'non-functional timestamp button remained');
        await click('Summary'); await click('AI Correction');
        const candidate = () => button('Review candidate: transcript'); await wait(() => candidate()?.getAttribute('aria-pressed') === 'true', 'review initialized'); candidate().click();
        await click('Unselected 1');
        const replacement = document.querySelector('textarea[aria-label="Suggested replacement"]'); replacement.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(replacement, 'transcript'); replacement.dispatchEvent(new Event('input', { bubbles: true }));
        await click('Transcript'); await click('Summary'); await click('AI Correction');
        await click('Unselected 1');
        assert(candidate().getAttribute('aria-pressed') === 'false', 'deselection lost after tab unmount');
        assert(document.querySelector('textarea[aria-label="Suggested replacement"]').value === 'transcript', 'unsaved edit lost after unmount');
        await click('AI Correction'); await click('AI Correction'); await click('Unselected 1'); assert(candidate().getAttribute('aria-pressed') === 'false', 'fold reset selection');
        await click('Abandon'); await wait(() => document.querySelector('#action-dialog-title')?.textContent === 'Abandon correction task?'); await click('Cancel'); assert(candidate(), 'cancel abandoned correction');
        let requests = 0; const originalFetch = window.fetch;
        window.fetch = async () => { requests++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'UI synthetic answer', citations: [] }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
        await click('Transcript'); buttons().find(b => b.title === 'Open AI Panel').click(); await wait(() => button('Continue in Q&A'));
        await click('Clear history'); await click('Cancel'); assert(panel().includes('UI sidebar answer'), 'cancel cleared sidebar thread');
        await click('Continue in Q&A'); await wait(() => selectedTab() === 'Chat', 'chat continuation'); assert(panel().includes('UI sidebar answer') && !panel().includes('UI default answer'), 'continuation opened wrong thread');
        await click('Delete: UI sidebar question'); await click('Cancel'); assert(panel().includes('UI sidebar answer'), 'cancel deleted conversation');
        await click('New Conversation'); await click('Fill in question: What are the main conclusions from this session?');
        assert(requests === 0 && panel().includes('Question filled in, not sent'), 'quick question sent automatically');
        const textarea = document.querySelector('textarea'); textarea.focus();
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }));
        textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        assert(requests === 0 && textarea.value, 'composition or Shift+Enter sent question');
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await wait(() => panel().includes('UI synthetic answer'), 'explicit Enter'); assert(requests === 1, 'Enter sent duplicate requests'); window.fetch = originalFetch;
        results.push('mixed speaker completeness, review retention, cancel protection, thread continuation and synthetic composition guards');
        await open('UI Pending');
        assert(!panel().includes('UI unique summary'), 'old summary leaked');
        assert(panel().includes('Generating'), 'pending summary not visible');
        await click('UI Other1'); await wait(() => panel().includes('UI failure marker'), 'folder fallback'); assert(!panel().includes('Generating'), 'out-of-folder detail retained');
        await open('UI Failed'); assert(panel().includes('UI failure marker'), 'failed summary fallback');
        await click('Unclassified1'); assert(records().length === 1 && !records()[0].textContent.includes('UI Orphan'), 'orphan counted unclassified');
        await open('UI Empty');
        assert(selectedTab() === 'Summary' && panel().includes('Generate AI Briefing'), 'empty summary has no action');
        await click('Transcript'); buttons().find(b => b.title === 'Open AI Panel').click();
        let sideRequests = 0; const originalSideFetch = window.fetch;
        window.fetch = async () => { sideRequests++; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'UI sidebar synthetic answer', citations: [] }) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
        await click('Fill in question: Summarize this transcript'); assert(sideRequests === 0 && panel().includes('Question filled in, not sent'), 'sidebar quick action auto-sent');
        const sideInput = document.querySelector('textarea'); sideInput.focus();
        sideInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        sideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
        sideInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        sideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        assert(sideRequests === 0, 'sidebar composition sent request');
        sideInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        await wait(() => panel().includes('UI sidebar synthetic answer'), 'sidebar explicit Enter'); assert(sideRequests === 1, 'sidebar Enter did not send once'); window.fetch = originalSideFetch;
        results.push('summary states/switching, descendants, orphan/unclassified, detail scope');
        await click('Back to list'); await new Promise(resolve => setTimeout(resolve, 100)); assert(!document.querySelector('[role=tab]'), 'explicit close reopened document'); await click('UI Root2');
        const input = document.querySelector('input[type=text]');
        const setInput = value => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
        setInput('UI Summary'); await wait(() => records().length === 1);
        assert(!document.querySelector('[data-heatmap]'), 'topic showed activity');
        await click('All History105'); await click('Activity overview');
        assert(document.querySelector('[data-heatmap] strong')?.textContent === '105', 'search truncated heatmap');
        const date = new Date().toISOString().slice(0, 10);
        buttons().find(b => b.getAttribute('aria-label')?.startsWith(date + ':')).click();
        await wait(() => button('Clear search, date and tags')); assert(input.value === 'UI Summary', 'date replaced text search');
        await click('Activity overview'); assert(!document.querySelector('[data-heatmap]') && button('Clear date filter: ' + date), 'collapsed activity hid date filter');
        await click('UI Other1'); assert(input.value === 'UI Summary' && records().length === 0, 'folder discarded filters');
        await click('Clear search, date and tags'); await click('UI Root2'); await click('UI Tag A');
        await wait(() => records().length === 1);
        await click('All History1'); await click('Activity overview');
        assert(document.querySelector('[data-heatmap] strong')?.textContent === '1', 'tag ignored by heatmap');
        await click('Clear search, date and tags');
        await click('UI Root2');
        results.push('AND search/tag/date, preserved filters, independent heatmap');
        buttons().find(b => b.getAttribute('aria-label') === 'Manage topic: UI Root').click();
        const topicPanel = () => document.querySelector('nav[aria-label=Folders] section[aria-label^="Manage topic:"]');
        const chooseTopicDirectory = () => Array.from(topicPanel().querySelectorAll('button')).find(b => b.textContent.trim() === 'Choose directory');
        const selectTopic = async name => { buttons().find(b => b.title === name).click(); await new Promise(resolve => setTimeout(resolve, 50)); };
        await wait(() => topicPanel()?.querySelector('h3')?.textContent === 'UI Root', 'root management panel');
        chooseTopicDirectory().click(); await wait(() => topicPanel().textContent.includes('C:/UI-topic-UI Root'), 'root directory');
        await selectTopic('UI Child');
        assert(topicPanel()?.querySelector('h3')?.textContent === 'UI Child', 'DIAGNOSTIC selected=' + document.querySelector('nav[aria-label=Folders] button[aria-current=page]')?.title + ' managing=' + topicPanel()?.querySelector('h3')?.textContent);
        chooseTopicDirectory().click(); await wait(() => topicPanel().textContent.includes('C:/UI-topic-UI Child'), 'child directory');
        await selectTopic('UI Root');
        await wait(() => topicPanel().textContent.includes('C:/UI-topic-UI Root'), 'root directory preserved');
        const choices = await window.electronAPI.getTestDirectoryRequests();
        assert(choices.slice(0, 2).map(item => item.projectId).join('|') === 'UI Root|UI Child', 'directory requests used wrong topic ID');
        await window.electronAPI.holdNextTestDirectoryChoice();
        chooseTopicDirectory().click(); await wait(() => chooseTopicDirectory().disabled, 'pending root picker');
        await selectTopic('UI Child');
        await wait(() => topicPanel().textContent.includes('C:/UI-topic-UI Child'), 'child during pending root picker');
        assert(!chooseTopicDirectory().disabled, 'pending state leaked into child panel');
        await window.electronAPI.releaseTestDirectoryChoice();
        await new Promise(resolve => setTimeout(resolve, 50));
        assert(topicPanel().querySelector('h3').textContent === 'UI Child' && topicPanel().textContent.includes('C:/UI-topic-UI Child'), 'late root picker response replaced child state');
        await click('Unclassified1'); assert(!topicPanel(), 'unclassified retained management target');
        buttons().find(b => b.getAttribute('aria-label') === 'Manage topic: UI Child').click();
        await wait(() => topicPanel()?.querySelector('h3')?.textContent === 'UI Child');
        assert(document.querySelector('nav[aria-label=Folders] button[aria-current=page]')?.title === 'UI Child', 'manage button did not synchronize highlight');
        await click('All History105'); assert(!topicPanel(), 'all history retained management target');
        await selectTopic('UI Root'); assert(!topicPanel(), 'closed management panel reopened on browsing');
        buttons().find(b => b.getAttribute('aria-label') === 'Manage topic: UI Root').click();
        results.push('cross-topic directories, synchronized management/highlight and isolated late picker response');
        await click('Edit Topic');
        const dialog = document.querySelector('[role=dialog]');
        const dialogControls = Array.from(dialog.querySelectorAll('button,input,textarea,select')).filter(control => !control.disabled && control.getClientRects().length);
        dialogControls[0].focus(); document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
        assert(document.activeElement === dialogControls[dialogControls.length - 1], 'topic dialog focus escaped');
        const nameInput = dialog.querySelector('input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(nameInput, 'UI Renamed Root'); nameInput.dispatchEvent(new Event('input', { bubbles: true }));
        await click('Save'); assert(button('UI Renamed Root2'), 'rename lost folder membership');
        await click('Archive topic'); await click('Archived'); assert(button('UI Renamed Root2'), 'archived topic inaccessible');
        await click('Restore topic'); results.push('archive view and restore');
        await click('Settings');
        assert(document.querySelector('nav[aria-label=Settings]').getBoundingClientRect().width === 160, 'settings navigation is not compact');
        const aiNavigation = buttons().find(button => button.textContent.trim().toLowerCase() === 'ai post-processing');
        aiNavigation.focus(); aiNavigation.click();
        await wait(() => document.body.textContent.includes('Configure transcript directories'), 'AI settings rendered');
        assert(!document.querySelector('[role=switch][aria-label="Automatically Save Published Corrections"]'), 'AI has duplicate save control');
        const lowerSettings = Array.from(document.querySelectorAll('p')).find(node => node.textContent.includes('Configure transcript directories'));
        lowerSettings.scrollIntoView({ block: 'center' }); await new Promise(resolve => requestAnimationFrame(resolve));
        assert(lowerSettings.getBoundingClientRect().height > 0, 'lower AI settings did not render');
        const dataNavigation = buttons().find(button => button.textContent.trim() === 'Data Management'); dataNavigation.click();
        await wait(() => document.querySelector('[role=switch][aria-label="Automatically Save Published Corrections"]'), 'central auto-save control');
        const autoSave = document.querySelector('[role=switch][aria-label="Automatically Save Published Corrections"]');
        const previous = autoSave.getAttribute('aria-checked'); autoSave.click(); await wait(() => autoSave.getAttribute('aria-checked') !== previous, 'immediate toggle');
        assert(JSON.parse(localStorage.getItem('desktoplive_settings')).autoSavePublishedCorrection === true, 'auto-save waited for Save button');
        await click('Choose directory'); await wait(() => document.body.textContent.includes('C:/UI-transcripts'), 'native role directory');
        await click('Choose directory'); assert(document.body.textContent.includes('C:/UI-transcripts'), 'cancelled picker changed directory');
        autoSave.click();
        const beforeImport = localStorage.getItem('desktoplive_settings');
        const openImport = async () => {
          const files = new DataTransfer(); files.items.add(new File([JSON.stringify({ version: '3', sessions: [], tags: [], topics: [], settings: {} })], 'ui-backup.json', { type: 'application/json' }));
          const fileInput = document.querySelector('input[type=file]'); fileInput.files = files.files; fileInput.dispatchEvent(new Event('change', { bubbles: true }));
          await wait(() => document.querySelector('#action-dialog-title')?.textContent === 'Choose import mode', 'import confirmation');
        };
        await openImport();
        assert(document.querySelector('[role=dialog]').textContent.includes('Cancel: make no changes') && button('Overwrite import').classList.contains('bg-destructive'), 'import semantics remain ambiguous');
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(() => !document.querySelector('[role=dialog]'), 'import Escape'); assert(document.body.textContent.includes('Data Management'), 'Escape closed settings rather than import confirmation');
        await openImport(); await click('Cancel'); assert(localStorage.getItem('desktoplive_settings') === beforeImport, 'cancel mutated settings');
        await click('Review'); results.push('large library: AI lower settings scroll and return to Review');
        return results;
      })()
    `
    const narrow = `
      (async () => {
        const button = text => Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === text || b.getAttribute('aria-label') === text);
        for (let i = 0; i < 250 && !button('Choose folder'); i++) await new Promise(resolve => setTimeout(resolve, 20));
        if (!button('Choose folder')) throw new Error('narrow layout did not switch');
        const drawerBackground = theme => {
          const drawer = document.querySelector('[role=dialog][aria-label=Folders]');
          if (!drawer) throw new Error('folder drawer missing');
          const background = getComputedStyle(drawer).backgroundColor;
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          const context = canvas.getContext('2d'); context.fillStyle = background; context.fillRect(0, 0, 1, 1);
          const alpha = context.getImageData(0, 0, 1, 1).data[3];
          console.log('DRAWER_DIAGNOSTIC:' + JSON.stringify({ theme, background, alpha }));
          if (alpha !== 255) throw new Error(theme + ' folder drawer must be opaque: ' + background);
          const backdrop = drawer.previousElementSibling;
          if (!backdrop || getComputedStyle(backdrop).backgroundColor !== 'rgba(0, 0, 0, 0.4)' || Number(getComputedStyle(backdrop).zIndex) >= Number(getComputedStyle(drawer).zIndex)) throw new Error('drawer backdrop contract changed');
          return background;
        };
        button('Choose folder').focus(); button('Choose folder').click(); await new Promise(resolve => setTimeout(resolve, 50));
        if (!document.querySelector('[role=dialog][aria-label=Folders]')) throw new Error('folder drawer missing');
        const darkBackground = drawerBackground('dark');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await new Promise(resolve => setTimeout(resolve, 50));
        if (document.querySelector('[role=dialog][aria-label=Folders]') || document.activeElement !== button('Choose folder')) throw new Error('drawer Escape/focus restore failed: ' + document.activeElement?.outerHTML);
        button('Switch to light mode').click();
        for (let i = 0; i < 250 && document.documentElement.classList.contains('dark'); i++) await new Promise(resolve => setTimeout(resolve, 20));
        if (document.documentElement.classList.contains('dark')) throw new Error('light theme did not apply');
        button('Choose folder').focus(); button('Choose folder').click(); await new Promise(resolve => setTimeout(resolve, 50));
        if (drawerBackground('light') === darkBackground) throw new Error('drawer ignored theme colors');
        document.querySelector('[role=dialog][aria-label=Folders]').previousElementSibling.click(); await new Promise(resolve => setTimeout(resolve, 50));
        if (document.querySelector('[role=dialog][aria-label=Folders]') || document.activeElement !== button('Choose folder')) throw new Error('drawer backdrop/focus restore failed');
        button('Choose folder').focus(); button('Choose folder').click(); await new Promise(resolve => setTimeout(resolve, 50));
        button('Unclassified1').click(); await new Promise(resolve => setTimeout(resolve, 50));
        if (document.querySelector('[role=dialog][aria-label=Folders]')) throw new Error('drawer did not close');
        if (!document.body.textContent.includes('UI Empty')) throw new Error('mobile list inaccessible');
        button('Back to list').click(); await new Promise(resolve => setTimeout(resolve, 50));
        if (document.querySelector('[role=tab]')) throw new Error('mobile return reopened detail');
        if (document.documentElement.scrollWidth > window.innerWidth) throw new Error('narrow layout overflow');
        const input = document.querySelector('input[type=text]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'UI Empty'); input.dispatchEvent(new Event('input', { bubbles: true }));
        for (let i = 0; i < 50; i++) { if (JSON.parse(localStorage.getItem('delive-review-filters'))?.state.searchQuery === 'UI Empty') break; await new Promise(resolve => setTimeout(resolve, 20)); }
        await new Promise(resolve => setTimeout(resolve, 50));
        if (!document.querySelector('#review-session-list').getClientRects().length || !input.getClientRects().length) throw new Error('automatic selection hid narrow search');
        return 'opaque dark/light drawer, unchanged backdrop/Escape and narrow list';
      })()
    `
    const layout = `
      (async () => {
        const buttons = () => Array.from(document.querySelectorAll('button'));
        buttons().find(b => b.textContent.trim() === 'All History105').click();
        await new Promise(resolve => setTimeout(resolve, 100));
        const row = Array.from(document.querySelectorAll('[role=button]')).find(node => node.getAttribute('aria-label')?.startsWith('Long title'));
        row.click(); row.scrollIntoView({ block: 'center' }); await new Promise(resolve => setTimeout(resolve, 50));
        const separator = document.querySelector('[role=separator][aria-controls=review-session-list]');
        separator.focus(); separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        const title = row.querySelector('span[title]'), preview = row.querySelector('p.line-clamp-2');
        if (!title || getComputedStyle(title).webkitLineClamp !== '2' || title.scrollHeight <= title.clientHeight) throw new Error('long title not actually clamped');
        if (!preview || getComputedStyle(preview).webkitLineClamp !== '2' || preview.getBoundingClientRect().height > 41) throw new Error('preview not actually limited to two lines');
        if (row.scrollWidth > row.clientWidth || document.documentElement.scrollWidth > innerWidth) throw new Error('narrow list overflow');
        const tag = document.querySelector('button[title="' + 'LongTag'.repeat(40) + '"]');
        if (!tag || tag.scrollWidth > tag.clientWidth || getComputedStyle(tag.querySelector('span')).textOverflow !== 'ellipsis') throw new Error('long tag overflow');
        separator.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 50));
        const documentPanel = document.querySelector('section[aria-label="Session document"]');
        if (documentPanel.getBoundingClientRect().width < 479) throw new Error('resizing squeezed document');
        buttons().find(b => b.textContent.trim() === 'Reset list width').click();
        await new Promise(resolve => setTimeout(resolve, 50));
        const box = separator.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: Number(separator.getAttribute('aria-valuenow')) };
      })()
    `
    const deletion = `
      (async () => {
        const wait = async predicate => { for(let i=0;i<250;i++){ if(predicate())return; await new Promise(resolve=>setTimeout(resolve,20)); } throw new Error('deletion fallback timed out'); };
        const title = () => document.querySelector('#session-review-title')?.textContent;
        document.querySelector('[role=button][aria-label="UI Orphan"]').click(); await wait(()=>title()==='UI Orphan');
        const remove = () => document.querySelector('#session-review-title').closest('div.flex.items-center.justify-between').querySelector('button[aria-label=Delete]').click();
        remove(); await wait(()=>document.querySelector('[role=dialog]'));
        Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent==='Cancel').click(); await wait(()=>!document.querySelector('[role=dialog]'));
        if(title()!=='UI Orphan')throw new Error('cancel cleared selected record');
        remove(); await wait(()=>document.querySelector('[role=dialog]'));
        Array.from(document.querySelectorAll('[role=dialog] button')).find(button=>button.textContent==='Delete').click();
        await wait(()=>title() && title()!=='UI Orphan' && !document.querySelector('[role=button][aria-label="UI Orphan"]'));
        return 'cancel retained selected record; deletion selected next visible record';
      })()
    `
    const dark = `
      (async () => {
        const original = document.startViewTransition;
        let finished;
        if (original) document.startViewTransition = (...args) => { const transition = original.apply(document, args); finished = transition.finished; return transition; };
        Array.from(document.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Switch to dark mode').click();
        for(let i=0;i<250&&!document.documentElement.classList.contains('dark');i++) await new Promise(resolve=>setTimeout(resolve,20));
        if(!document.documentElement.classList.contains('dark'))throw new Error('dark theme not applied');
        if (finished) await finished;
        document.startViewTransition = original;
        await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
      })()
    `
    const script = `
      const { app, BrowserWindow } = require('electron'); const fs = require('fs');
      fs.mkdirSync(${JSON.stringify(path.join(root, 'profile'))}, { recursive: true }); app.setPath('userData', ${JSON.stringify(path.join(root, 'profile'))});
      app.whenReady().then(async () => { let win; try {
        win = new BrowserWindow({ show: false, width: 1400, height: 1000, webPreferences: { backgroundThrottling: false, preload: ${JSON.stringify(path.join(root, 'preload.cjs'))}, contextIsolation: true, nodeIntegration: false } });
        win.webContents.on('console-message', event => { if (event.level === 'error') console.error('UI_RENDERER', event.message); });
        await win.loadFile(${JSON.stringify(path.join(workspace, 'frontend/dist/index.html'))});
        await win.webContents.executeJavaScript(${JSON.stringify(seed)});
        await win.loadFile(${JSON.stringify(path.join(workspace, 'frontend/dist/index.html'))});
        if (process.env.DELIVE_REVIEW_CAPTURE_DIR) win.showInactive();
        const result = await win.webContents.executeJavaScript(${JSON.stringify(interactions)});
        const resize = await win.webContents.executeJavaScript(${JSON.stringify(layout)});
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(resize.x), y: Math.round(resize.y) });
        win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x: Math.round(resize.x), y: Math.round(resize.y), clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(resize.x + 50), y: Math.round(resize.y) });
        win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: Math.round(resize.x + 50), y: Math.round(resize.y), clickCount: 1 });
        const resizedWidth = await win.webContents.executeJavaScript('(async () => { await new Promise(resolve=>setTimeout(resolve,100)); return Number(document.querySelector("[role=separator][aria-controls=review-session-list]").getAttribute("aria-valuenow")); })()');
        if (resizedWidth <= resize.width) throw new Error('native pointer drag did not resize');
        if (process.env.DELIVE_REVIEW_CAPTURE_DIR) fs.writeFileSync(require('path').join(process.env.DELIVE_REVIEW_CAPTURE_DIR, 'review-settings-desktop-light.png'), (await win.webContents.capturePage()).toPNG());
        await win.webContents.executeJavaScript(${JSON.stringify(dark)});
        if (process.env.DELIVE_REVIEW_CAPTURE_DIR) fs.writeFileSync(require('path').join(process.env.DELIVE_REVIEW_CAPTURE_DIR, 'review-settings-desktop-dark.png'), (await win.webContents.capturePage()).toPNG());
        const deleted = await win.webContents.executeJavaScript(${JSON.stringify(deletion)});
        win.setSize(700, 850);
        const mobile = await win.webContents.executeJavaScript(${JSON.stringify(narrow)});
        await win.webContents.executeJavaScript('(async () => { await new Promise(resolve=>setTimeout(resolve,500)); })()');
        if (process.env.DELIVE_REVIEW_CAPTURE_DIR) fs.writeFileSync(require('path').join(process.env.DELIVE_REVIEW_CAPTURE_DIR, 'review-settings-narrow.png'), (await win.webContents.capturePage()).toPNG());
        await win.loadFile(${JSON.stringify(path.join(workspace, 'frontend/dist/index.html'))});
        const refreshed = await win.webContents.executeJavaScript(
          '(async () => { const buttons = () => Array.from(document.querySelectorAll("button")); for(let i=0;i<250;i++){ if(buttons().some(button=>button.textContent.trim()==="Test Configuration")) break; await new Promise(resolve=>setTimeout(resolve,20)); } const review=buttons().find(button=>button.textContent.trim()==="Review"||button.getAttribute("aria-label")==="Review"); review.focus(); review.click(); await new Promise(resolve=>setTimeout(resolve,100)); const current=document.querySelector("nav[aria-label=Folders] button[aria-current=page]"); if(!current?.textContent.startsWith("Unclassified")||document.querySelector("input[type=text]")?.value!=="UI Empty"||document.querySelectorAll("[role=button]").length!==1)throw new Error("refresh lost folder/search state"); return "refresh retains folder/search"; })()'
        );
        console.log('UI_RESULT:' + JSON.stringify([...result, 'long titles/two-line previews, native pointer drag, keyboard bounds and dark theme', deleted, mobile, refreshed])); win.destroy(); app.quit();
      } catch (error) { console.error(error); win?.destroy(); app.exit(1); } });
    `
    await fs.promises.writeFile(path.join(root, 'preload.cjs'), `
      const { contextBridge } = require('electron');
      const status = { configuration: { mediaRoot: 'C:/UI-media', defaultTranscriptDirectory: null, projectTranscriptDirectories: {} }, media: { available: true, writable: true }, transcript: { available: true, writable: true }, projectTranscripts: {}, managedAssetCount: 0, managedBytes: 0, pendingOperationCount: 0, busy: false };
      const directoryRequests = []; let holdNext = false, releaseChoice;
      contextBridge.exposeInMainWorld('electronAPI', {
        onApiGetSessions: () => () => {}, onApiGetSessionDetail: () => () => {}, onApiSearchSessions: () => () => {},
        onApiGetTopics: () => () => {}, onApiGetTags: () => () => {}, onApiGetRecordingStatus: () => () => {},
        apiUpdateOpenApiConfig: async () => {},
        getFileStorageStatus: async () => ({ ok: true, status }),
        getTestDirectoryRequests: async () => directoryRequests,
        holdNextTestDirectoryChoice: async () => { holdNext = true; },
        releaseTestDirectoryChoice: async () => { releaseChoice?.(); },
        chooseTranscriptDirectory: async target => {
          directoryRequests.push(target);
          if (target.kind === 'project-transcript' && target.projectId) {
            status.configuration.projectTranscriptDirectories[target.projectId] = 'C:/UI-topic-' + target.projectId;
            status.projectTranscripts[target.projectId] = { available: true, writable: true };
            const result = { ok: true, status: JSON.parse(JSON.stringify(status)) };
            if (holdNext) { holdNext = false; await new Promise(resolve => { releaseChoice = resolve; }); }
            return result;
          }
          if (target.kind !== 'default-transcript') throw new Error('invalid directory role');
          if (status.configuration.defaultTranscriptDirectory) return null;
          status.configuration.defaultTranscriptDirectory = 'C:/UI-transcripts'; return { ok: true, status };
        },
        savePublishedMarkdown: async () => { throw new Error('UI test must not auto-publish'); }
      });
    `)
    await fs.promises.writeFile(entry, script)
    try {
      const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const env = { ...process.env }
        delete env.ELECTRON_RUN_AS_NODE
        const child = spawn(path.join(workspace, 'node_modules/electron/dist/electron.exe'), [entry], { env, shell: false, windowsHide: true })
        let output = ''
        child.stdout.on('data', (data: Buffer) => { output += data.toString('utf8') })
        child.stderr.on('data', (data: Buffer) => { output += data.toString('utf8') })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, output }))
      })
      expect(result.code, result.output).toBe(0)
      expect(result.output).toContain('UI_RESULT:')
    } finally { await fs.promises.rm(root, { recursive: true, force: true }) }
  }, 60000)
})

describe('ActivityHeatmap translations', () => {
  it('heatmap i18n keys exist in both locales', async () => {
    const { en } = await import('../../i18n/locales/en')
    const { zh } = await import('../../i18n/locales/zh')
    const keys = ['title', 'total', 'thisMonth', 'streak', 'totalDuration', 'days', 'less', 'more', 'noRecordings', 'recording', 'dayMon', 'dayWed', 'dayFri']
    for (const key of keys) {
      expect((en.heatmap as Record<string, unknown>)[key]).toBeTruthy()
      expect((zh.heatmap as Record<string, unknown>)[key]).toBeTruthy()
    }
  })
})
