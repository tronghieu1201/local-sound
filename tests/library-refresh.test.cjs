const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');

// Run the production refresh and filtering functions, isolating browser rendering
// and Appwrite I/O so these regressions can run without credentials or a browser.
function productionFunction(name) {
    const pattern = new RegExp(`^    (?:async )?function ${name}\\([^]*?^    }`, 'm');
    const match = appSource.match(pattern);
    assert.ok(match, `Production function ${name} exists`);
    return match[0];
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function songs(count) {
    return Array.from({ length: count }, (_, index) => ({
        id: `song-${index + 1}`,
        title: `Track ${String(index + 1).padStart(2, '0')}`,
        folders: ['Karaoke'],
        categories: ['karaoke'],
        size: index + 1
    }));
}

async function settle() {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function harness() {
    let timerId = 0;
    let now = 0;
    const timers = new Map();
    const requests = [];
    const rendered = [];
    const songListEl = { innerHTML: 'Initial loading indicator' };
    const totalCountEl = { textContent: '' };
    const unfiledCountEl = { textContent: '' };
    const audio = { src: 'https://audio.example/playing.mp3', currentTime: 42, paused: false, volume: 0.75 };
    const context = vm.createContext({
        document: { visibilityState: 'visible', querySelector: () => null, getElementById: () => null },
        navigator: { onLine: true },
        window: { innerWidth: 1280 },
        console: { error() {}, warn() {} },
        setTimeout(callback, delay) {
            const id = ++timerId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        audio,
        songListEl,
        totalCountEl,
        unfiledCountEl,
        nhacdoCountEl: null,
        tghyCountEl: null,
        cookingCountEl: null,
        aloneCountEl: null,
        karaokeCountEl: null,
        giaitriCountEl: null,
        weddingCountEl: null,
        sleepCountEl: null,
        playlistHeadingEl: { textContent: '' },
        playlistCountEl: { textContent: '' },
        fetchAppwriteSongs() {
            const request = deferred();
            requests.push(request);
            return request.promise;
        },
        renderFolders() {},
        getSongCategoriesForUI(song) { return song.categories; },
        isTrghyCategory(categories) { return categories.includes('trghy'); },
        normalizeFolderList(folders) { return folders || []; },
        normalizeFolderValue(value) { return String(value).toLowerCase(); },
        removeAccents(value) { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); },
        loadUserData() { throw new Error('Library refresh must not reload playback preferences'); },
        recordRender(ids) {
            rendered.push(Array.from(ids));
            songListEl.innerHTML = ids.join(',');
        }
    });
    vm.runInContext(`
        const LIBRARY_REFRESH_DELAY_MS = 200;
        let allSongs = [];
        let currentPlaylist = [];
        let currentIndex = -1;
        let currentPlayingSong = null;
        let isPlaying = false;
        let currentTab = 'all';
        let currentFolder = 'all';
        let searchQuery = '';
        let sortOption = 'title-asc';
        let recentSongs = [];
        let songsFetchPromise = null;
        let hasLoadedSongs = false;
        let libraryRefreshReady = false;
        let libraryRefreshTimer = null;
        function renderSongList() { recordRender(currentPlaylist.map(song => song.id)); }
        ${[
            'getCurrentPlayingSong',
            'isSongUnfiled',
            'updateCategoryBadges',
            'sortPlaylist',
            'filterAndRenderSongs',
            'fetchSongs',
            'scheduleLibraryRefresh'
        ].map(productionFunction).join('\n')}
        globalThis.api = {
            fetchSongs,
            scheduleLibraryRefresh,
            enableRefresh() { libraryRefreshReady = true; },
            play(song) { currentPlayingSong = song; isPlaying = true; },
            setView(tab, query, sort) { currentTab = tab; searchQuery = query; sortOption = sort; },
            snapshot() {
                return {
                    count: allSongs.length,
                    playlist: currentPlaylist.map(song => song.id),
                    currentPlayingSong,
                    currentIndex,
                    isPlaying,
                    currentTab,
                    searchQuery,
                    sortOption,
                    hasLoadedSongs
                };
            }
        };
    `, context, { filename: 'production-library-refresh.js' });

    return {
        context, requests, rendered, audio, songListEl, totalCountEl, unfiledCountEl, api: context.api,
        async tick(milliseconds = 200) {
            now += milliseconds;
            for (const [id, timer] of Array.from(timers)) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
            await settle();
        },
        async load(items = songs(5)) {
            const loading = context.api.fetchSongs();
            await settle();
            requests.at(-1).resolve(items);
            await loading;
            context.api.enableRefresh();
        }
    };
}

test('returning to music updates five songs to ten without interrupting playback', async () => {
    const app = harness();
    await app.load();
    app.api.play(songs(5)[2]);
    const playingBefore = { ...app.audio };

    app.context.document.visibilityState = 'hidden';
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 1);
    assert.equal(app.api.snapshot().count, 5);

    app.context.document.visibilityState = 'visible';
    app.api.scheduleLibraryRefresh(); // visibilitychange
    app.api.scheduleLibraryRefresh(); // window focus in the same return
    await app.tick(199);
    assert.equal(app.requests.length, 1);
    await app.tick(1);
    assert.equal(app.requests.length, 2);
    assert.equal(app.totalCountEl.textContent, 5, 'cached library remains visible during request');
    app.requests[1].resolve(songs(10));
    await settle();

    assert.equal(app.api.snapshot().count, 10);
    assert.equal(app.totalCountEl.textContent, 10);
    assert.equal(app.rendered.at(-1).length, 10);
    assert.deepEqual(app.audio, playingBefore);
    assert.equal(app.api.snapshot().currentPlayingSong.id, 'song-3');
    assert.equal(app.api.snapshot().isPlaying, true);
    assert.equal(app.api.snapshot().currentIndex, 2);
});

test('refresh keeps the selected category, search and sort', async () => {
    const app = harness();
    await app.load();
    app.api.setView('karaoke', 'Track 0', 'title-desc');
    const loading = app.api.fetchSongs({ background: true });
    await settle();
    app.requests[1].resolve([...songs(10), { id: 'other', title: 'Track 00', categories: [], folders: [] }]);
    await loading;

    const snapshot = app.api.snapshot();
    assert.equal(snapshot.currentTab, 'karaoke');
    assert.equal(snapshot.searchQuery, 'Track 0');
    assert.equal(snapshot.sortOption, 'title-desc');
    assert.deepEqual(Array.from(snapshot.playlist), Array.from({ length: 9 }, (_, i) => `song-${9 - i}`));
    assert.equal(app.audio.volume, 0.75);
});

test('unfiled view only shows songs that have not been assigned to any folder', async () => {
    const app = harness();
    const unfiledSong = { id: 'unfiled', title: 'Ai Là Người Thương Em', categories: [], folders: [] };
    const assignedSongs = [
        { id: 'nightmare', title: 'Ác Mộng Đẹp', categories: ['trghy'], folders: ['trghy'] },
        { id: 'sedative', title: 'An Thần', categories: ['trghy'], folders: ['trghy'] }
    ];

    await app.load([unfiledSong, ...assignedSongs]);
    assert.equal(app.unfiledCountEl.textContent, 1);

    app.api.setView('unfiled', '', 'title-asc');
    const loading = app.api.fetchSongs({ background: true });
    await settle();
    app.requests[1].resolve([unfiledSong, ...assignedSongs]);
    await loading;

    assert.deepEqual(Array.from(app.api.snapshot().playlist), ['unfiled']);
});

test('scheduling is disabled until initial loading completes, while hidden, and while offline', async () => {
    const app = harness();
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 0);
    await app.load();

    app.context.navigator.onLine = false;
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 1);

    app.context.navigator.onLine = true;
    app.api.scheduleLibraryRefresh();
    app.context.document.visibilityState = 'hidden';
    await app.tick();
    assert.equal(app.requests.length, 1, 'hiding the page during the debounce cancels the request');

    app.context.document.visibilityState = 'visible';
    app.api.scheduleLibraryRefresh();
    app.context.navigator.onLine = false;
    await app.tick();
    assert.equal(app.requests.length, 1, 'going offline during the debounce cancels the request');

    app.context.navigator.onLine = true;
    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 2);
    app.requests[1].resolve(songs(10));
    await settle();
    assert.equal(app.api.snapshot().count, 10);
});

test('simultaneous background refreshes share one network request', async () => {
    const app = harness();
    await app.load();
    const first = app.api.fetchSongs({ background: true });
    const second = app.api.fetchSongs({ background: true });
    const third = app.api.fetchSongs({ background: true });
    await settle();
    assert.equal(app.requests.length, 2);
    app.requests[1].resolve(songs(10));
    await Promise.all([first, second, third]);
    assert.equal(app.api.snapshot().count, 10);
    assert.equal(app.rendered.length, 2);
});

test('refresh failure preserves the displayed library and can recover on the next return', async () => {
    const app = harness();
    await app.load();
    const previousMarkup = app.songListEl.innerHTML;
    const loading = app.api.fetchSongs({ background: true });
    await settle();
    app.requests[1].reject(new Error('Network unavailable'));
    await loading;
    assert.equal(app.api.snapshot().count, 5);
    assert.equal(app.songListEl.innerHTML, previousMarkup);
    assert.equal(app.totalCountEl.textContent, 5);
    assert.equal(app.rendered.length, 1);

    app.api.scheduleLibraryRefresh();
    await app.tick();
    assert.equal(app.requests.length, 3);
    app.requests[2].resolve(songs(10));
    await settle();
    assert.equal(app.api.snapshot().count, 10);
});

test('an initial network error displays an error and subsequent refresh recovers', async () => {
    const app = harness();
    const loading = app.api.fetchSongs();
    await settle();
    app.requests[0].reject(new Error('Network unavailable'));
    await loading;
    assert.equal(app.api.snapshot().hasLoadedSongs, false);
    assert.match(app.songListEl.innerHTML, /Không thể kết nối danh sách bài hát/);

    app.api.enableRefresh();
    app.api.scheduleLibraryRefresh();
    await app.tick();
    app.requests[1].resolve(songs(5));
    await settle();
    assert.equal(app.api.snapshot().hasLoadedSongs, true);
    assert.equal(app.api.snapshot().count, 5);
});

test('admin mutation reload fetches again after an older request already in flight', async () => {
    const app = harness();
    await app.load();
    const olderRefresh = app.api.fetchSongs({ background: true });
    await settle();
    const afterUpload = app.api.fetchSongs();
    await settle();
    assert.equal(app.requests.length, 2, 'foreground reload waits for the current request');

    app.requests[1].resolve(songs(7));
    await olderRefresh;
    await settle();
    assert.equal(app.requests.length, 3, 'post-upload reload must fetch a fresh server snapshot');
    app.requests[2].resolve(songs(10));
    await afterUpload;
    assert.equal(app.api.snapshot().count, 10);
});
