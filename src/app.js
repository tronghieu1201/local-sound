/* ==========================================================================
   LocalSound - Cloud Music Player Frontend Logic
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
    // --- Cloud-only browser configuration ---
    const APPWRITE_CONFIG = Object.freeze({
        endpoint: 'https://sgp.cloud.appwrite.io/v1',
        projectId: '6ab3a652002e667289ab',
        databaseId: '6ab3c1c70002db082d00',
        tableId: 'songs',
        bucketId: '6ab3a724003a859f835a',
        functionId: 'song-admin',
        // Keep this aligned with the maximum file size configured for the
        // Appwrite Storage bucket.
        maxUploadBytes: 50 * 1024 * 1024,
        // Set this to the admin user's Appwrite $id. It is public, but must not
        // be guessed or replaced with an email/password.
        adminUserId: '6ab3f33c001d0e271d16'
    });
    const APPWRITE_PAGE_SIZE = 100;
    const ASSET_BASE_PATH = window.location.pathname.includes('/src/') ? '../assets/' : 'assets/';

    console.info('[LocalSound] Cloud-only mode enabled: Appwrite Auth + TablesDB + Storage');

    // --- State Variables ---
    let allSongs = [];
    let currentPlaylist = [];
    let currentIndex = -1;
    let currentPlayingSong = null;
    let isPlaying = false;
    let appwriteServices = null;
    let currentAuthUser = null;
    let isAdmin = false;

    function getCurrentPlayingSong() {
        if (currentPlayingSong) return currentPlayingSong;
        if (currentIndex >= 0 && currentPlaylist[currentIndex]) {
            return currentPlaylist[currentIndex];
        }
        return null;
    }

    // Playback loop modes: 'sequential' (theo thứ tự), 'one' (lặp 1 bài), 'shuffle' (ngẫu nhiên)
    let loopMode = 'sequential';

    // Tabs: 'all', 'karaoke', 'cooking', 'sleep', 'xxx', 'recent'
    let currentTab = 'all';
    let currentFolder = 'all';
    let searchQuery = '';
    let sortOption = 'title-asc';

    // Safely restore Mobile Tab state from localStorage
    let savedMobileTab = 'for-you';
    try {
        const storedTab = localStorage.getItem('local_music_mobile_tab');
        if (storedTab === 'library' || storedTab === 'for-you') {
            savedMobileTab = storedTab;
        }
    } catch (e) { }
    let mobileTab = savedMobileTab;

    // Note page state
    let noteText = '';
    let noteList = [];

    let recentSongs = [];
    try {
        const rawRecent = localStorage.getItem('local_music_recent');
        if (rawRecent && rawRecent !== 'undefined' && rawRecent !== 'null') {
            recentSongs = JSON.parse(rawRecent) || [];
        }
    } catch (e) { recentSongs = []; }
    if (!Array.isArray(recentSongs)) recentSongs = [];

    // Sleep Timer
    let sleepTimerInterval = null;
    let sleepTimerEndTime = null;

    // Web Audio Context & Nodes
    let audioCtx = null;
    let analyserNode = null;
    let sourceNode = null;
    let eqBands = [];
    const eqFrequencies = [60, 230, 910, 3600, 14000];

    // --- DOM Elements ---
    const audio = document.getElementById('audio-player');
    if (audio) {
        audio.crossOrigin = 'anonymous';
    }
    const playBtn = document.getElementById('play-btn');
    const playIcon = document.getElementById('play-icon');
    const pauseIcon = document.getElementById('pause-icon');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');

    const modeCycleBtn = document.getElementById('mode-cycle-btn');
    const modeIcon = document.getElementById('mode-icon');
    const modeLabel = document.getElementById('mode-label');

    const seekSlider = document.getElementById('seek-slider');
    const seekFill = document.getElementById('seek-fill');
    const currentTimeEl = document.getElementById('current-time');
    const durationTimeEl = document.getElementById('duration-time');

    const volumeSlider = document.getElementById('volume-slider');
    const volumeFill = document.getElementById('volume-fill');
    const muteBtn = document.getElementById('mute-btn');
    const volIcon = document.getElementById('vol-icon');
    const muteIcon = document.getElementById('mute-icon');

    const currentTitle = document.getElementById('current-title');
    const currentTags = document.getElementById('current-tags');
    const vinylDisc = document.getElementById('vinyl-disc');
    const vinylArt = document.getElementById('vinyl-art');

    const songListEl = document.getElementById('song-list');
    const totalCountEl = document.getElementById('total-count');
    const nhacdoCountEl = document.getElementById('nhacdo-count');
    const tghyCountEl = document.getElementById('tghy-count');
    const cookingCountEl = document.getElementById('cooking-count');
    const karaokeCountEl = document.getElementById('karaoke-count');
    const sleepCountEl = document.getElementById('sleep-count');

    const playlistCountEl = document.getElementById('playlist-count');
    const playlistHeadingEl = document.getElementById('current-playlist-heading');
    const searchInput = document.getElementById('search-input');
    const clearSearchBtn = document.getElementById('clear-search');
    const sortSelect = document.getElementById('sort-select');
    const folderListEl = document.getElementById('folder-list');

    // Visualizer Canvas
    const canvas = document.getElementById('visualizer-canvas');
    const canvasCtx = canvas ? canvas.getContext('2d') : null;

    // Modals, Timers & Power Saver Elements
    const eqModal = document.getElementById('eq-modal');
    const timerModal = document.getElementById('timer-modal');
    const shortcutModal = document.getElementById('shortcut-modal');
    const timerBadgeText = document.getElementById('timer-badge-text');
    const powerSaverBtn = document.getElementById('power-saver-btn');
    const powerSaverBadge = document.getElementById('power-saver-badge');
    const powerSaverOverlay = document.getElementById('power-saver-overlay');
    const authModal = document.getElementById('auth-modal');
    const authControls = document.getElementById('auth-controls');
    const authLoginBtn = document.getElementById('auth-login-btn');
    const authCloseBtn = document.getElementById('close-auth');
    const authForm = document.getElementById('admin-login-form');
    const authEmailInput = document.getElementById('admin-email');
    const authPasswordInput = document.getElementById('admin-password');
    const authErrorEl = document.getElementById('auth-error');
    const adminSession = document.getElementById('admin-session');
    const adminUserLabel = document.getElementById('admin-user-label');
    const adminUploadBtn = document.getElementById('admin-upload-btn');
    const adminLogoutBtn = document.getElementById('admin-logout-btn');
    const uploadPlaceholderModal = document.getElementById('upload-placeholder-modal');
    const closeUploadPlaceholder = document.getElementById('close-upload-placeholder');
    const adminUploadForm = document.getElementById('admin-upload-form');
    const adminUploadFileInput = document.getElementById('admin-upload-file');
    const adminUploadFileMeta = document.getElementById('admin-upload-file-meta');
    const adminUploadStatus = document.getElementById('admin-upload-status');
    const adminUploadSubmit = document.getElementById('admin-upload-submit');

    // Power Saver & Screen WakeLock State
    let isPowerSaverON = false;
    let wakeLock = null;

    // --- Initialization ---
    init();

    async function init() {
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        setupEventListeners();
        await initializeAuth();
        initBatteryAPI();
        initNotesLogic();
        await fetchSongs();
    }

    function resizeCanvas() {
        if (canvas && canvas.parentElement) {
            canvas.width = canvas.parentElement.clientWidth;
            canvas.height = canvas.parentElement.clientHeight;
        }
    }

    // --- Audio Context Setup ---
    function initAudioContext() {
        if (audioCtx) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContext();
            analyserNode = audioCtx.createAnalyser();
            analyserNode.fftSize = 128;

            sourceNode = audioCtx.createMediaElementSource(audio);

            let lastNode = sourceNode;
            eqBands = eqFrequencies.map(freq => {
                const filter = audioCtx.createBiquadFilter();
                if (freq <= 230) filter.type = 'lowshelf';
                else if (freq >= 3600) filter.type = 'highshelf';
                else filter.type = 'peaking';
                filter.frequency.value = freq;
                filter.Q.value = 1.0;
                filter.gain.value = 0;

                lastNode.connect(filter);
                lastNode = filter;
                return filter;
            });

            lastNode.connect(analyserNode);
            analyserNode.connect(audioCtx.destination);

            drawVisualizer();
        } catch (e) {
            console.warn('Web Audio API không khởi tạo được:', e);
        }
    }

    // --- Toast Notification Helper ---
    function showToast(message, type = 'info') {
        if (window.innerWidth <= 768 && message.includes('Đang phát')) {
            return;
        }
        const container = document.getElementById('toast-container');
        if (!container) return;
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        toast.innerHTML = message;
        container.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            toast.style.transform = 'scale(0.85)';
            toast.style.transition = 'all 0.3s ease';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // --- Battery Manager API ---
    let batteryManager = null;

    async function initBatteryAPI() {
        if ('getBattery' in navigator) {
            try {
                batteryManager = await navigator.getBattery();
                updateBatteryUI();

                batteryManager.addEventListener('chargingchange', () => {
                    updateBatteryUI();
                    if (batteryManager.charging && isPowerSaverON) {
                        showToast('⚡ Máy đã kết nối sạc nguồn! Tự động tắt chế độ tiết kiệm pin.', 'warning');
                        togglePowerSaverMode(false);
                    }
                });

                batteryManager.addEventListener('levelchange', updateBatteryUI);
            } catch (e) {
                console.warn('Battery API không hỗ trợ:', e);
            }
        } else {
            updateBatteryUI();
        }
    }

    function updateBatteryUI() {
        const psBatteryLevel = document.getElementById('ps-battery-level');
        if (!psBatteryLevel) return;
        if (batteryManager) {
            const pct = Math.round(batteryManager.level * 100);
            if (batteryManager.charging) {
                psBatteryLevel.innerHTML = `⚡ ${pct}% • Đang sạc nguồn`;
            } else {
                psBatteryLevel.innerHTML = `🔋 ${pct}% • Tiết kiệm pin`;
            }
        } else {
            psBatteryLevel.innerHTML = `🔋 Tiết kiệm pin`;
        }
    }

    async function requestWakeLock() {
        if ('wakeLock' in navigator) {
            try {
                wakeLock = await navigator.wakeLock.request('screen');
            } catch (err) {
                console.warn('WakeLock không khởi tạo được:', err);
            }
        }
    }

    function releaseWakeLock() {
        if (wakeLock !== null) {
            wakeLock.release().then(() => { wakeLock = null; }).catch(() => { });
        }
    }

    async function updateWakeLockState() {
        const isAudioActive = !audio.paused && audio.currentTime > 0 && !audio.ended;
        const shouldKeepAwake = isPowerSaverON || isPlaying || isAudioActive;

        if (shouldKeepAwake) {
            if (wakeLock === null) {
                await requestWakeLock();
            }
        } else {
            if (wakeLock !== null) {
                releaseWakeLock();
            }
        }
    }

    document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') {
            await updateWakeLockState();
            if (audioCtx && audioCtx.state === 'suspended' && isPlaying) {
                try { await audioCtx.resume(); } catch (e) { }
            }
        }
    });

    audio.addEventListener('play', () => {
        isPlaying = true;
        updateWakeLockState();
        updateMediaSession();
    });

    audio.addEventListener('pause', () => {
        isPlaying = false;
        updateWakeLockState();
        updateMediaSession();
    });

    async function togglePowerSaverMode(forceState, skipSave = false, userTriggered = false) {
        // If user tries to turn ON, verify battery charging status
        const targetState = (forceState !== undefined) ? Boolean(forceState) : !isPowerSaverON;

        if (targetState === true) {
            if (batteryManager && batteryManager.charging) {
                showToast('⚡ Máy đang cắm sạc trực tiếp. Không cần bật chế độ tiết kiệm pin!', 'warning');
                if (isPowerSaverON) {
                    isPowerSaverON = false;
                    applyPowerSaverUI(false);
                }
                return;
            }
        }

        isPowerSaverON = targetState;
        applyPowerSaverUI(isPowerSaverON);

        if (userTriggered) {
            if (isPowerSaverON) {
                showToast('⚡ Đã BẬT Tiết kiệm pin (Màn hình tối OLED, giữ nhạc phát mượt)', 'success');
            } else {
                showToast('💡 Đã TẮT Tiết kiệm pin (Khôi phục màn hình sáng bình thường)', 'info');
            }
        }

        if (!skipSave) {
            saveUserData();
        }
    }

    function applyPowerSaverUI(isOn) {
        updateBatteryUI();

        const psTrackName = document.getElementById('ps-track-name');
        const psPlayBtn = document.getElementById('ps-play-btn');

        if (currentIndex >= 0 && currentPlaylist[currentIndex] && psTrackName) {
            psTrackName.textContent = `🎵 ${currentPlaylist[currentIndex].title}`;
        }
        if (psPlayBtn) {
            psPlayBtn.textContent = isPlaying ? '⏸️' : '▶️';
        }

        if (powerSaverBtn && powerSaverBadge && powerSaverOverlay) {
            if (isOn) {
                powerSaverBtn.classList.add('active');
                powerSaverBadge.textContent = 'ON';
                powerSaverBtn.title = 'Tiết kiệm pin & Giữ màn hình (Đang BẬT)';
                powerSaverOverlay.classList.remove('hidden');
                document.body.classList.add('power-saver-active');
            } else {
                powerSaverBtn.classList.remove('active');
                powerSaverBadge.textContent = 'OFF';
                powerSaverBtn.title = 'Tiết kiệm pin & Giữ màn hình (Đang TẮT)';
                powerSaverOverlay.classList.add('hidden');
                document.body.classList.remove('power-saver-active');
            }
        }
        updateWakeLockState();
    }

    function applyUserData(data) {
        if (!data) return;
        if (Array.isArray(data.recent)) {
            recentSongs = data.recent;
        }
        if (data.loopMode) {
            loopMode = data.loopMode;
            updateLoopModeButtonUI();
        }
        if (data.volume !== undefined) {
            const v = parseFloat(data.volume);
            if (!isNaN(v)) {
                audio.volume = v;
                if (volumeSlider) volumeSlider.value = v;
                if (volumeFill) volumeFill.style.width = `${v * 100}%`;
            }
        }
        if (typeof data.noteText === 'string') {
            noteText = data.noteText;
            const editor = document.getElementById('note-text-editor');
            if (editor) editor.value = noteText;
        }
        if (Array.isArray(data.noteList)) {
            noteList = data.noteList;
            renderChecklist();
        }
    }

    // --- Browser Preference Persistence ---
    async function loadUserData() {
        try {
            const savedUserData = localStorage.getItem('local_music_user_data');
            if (savedUserData) {
                applyUserData(JSON.parse(savedUserData));
            }
        } catch (err) {
            console.warn('Lỗi đọc tùy chọn trình duyệt:', err);
        }
    }

    async function saveUserData() {
        try {
            const payload = {
                recent: recentSongs,
                volume: audio.volume,
                loopMode: loopMode,
                powerSaver: isPowerSaverON,
                noteText: noteText,
                noteList: noteList
            };

            // Save browser preferences immediately for the next session
            try {
                localStorage.setItem('local_music_user_data', JSON.stringify(payload));
                localStorage.setItem('local_music_recent', JSON.stringify(recentSongs));
            } catch (e) { }
        } catch (err) {
            console.warn('Lỗi ghi tùy chọn trình duyệt:', err);
        }
    }

    // --- Appwrite Auth & Cloud Services ---
    function createAppwriteServices() {
        if (appwriteServices) return appwriteServices;

        const sdk = window.Appwrite;
        const required = ['Client', 'Account', 'TablesDB', 'Storage', 'Functions', 'ID'];
        const missing = required.filter((name) => !sdk || !sdk[name]);
        if (missing.length > 0) {
            throw new Error(`Appwrite Web SDK chưa được tải đủ: thiếu ${missing.join(', ')}.`);
        }

        const client = new sdk.Client()
            .setEndpoint(APPWRITE_CONFIG.endpoint)
            .setProject(APPWRITE_CONFIG.projectId);

        appwriteServices = {
            client,
            account: new sdk.Account(client),
            tablesDB: new sdk.TablesDB(client),
            storage: new sdk.Storage(client),
            functions: new sdk.Functions(client),
            ID: sdk.ID,
            Query: sdk.Query || null,
            ExecutionMethod: sdk.ExecutionMethod || null
        };
        return appwriteServices;
    }

    function updateAdminUI() {
        if (authControls) authControls.classList.remove('hidden');
        if (authLoginBtn) authLoginBtn.classList.toggle('hidden', isAdmin);
        if (adminSession) adminSession.classList.toggle('hidden', !isAdmin);
        if (adminUserLabel) {
            adminUserLabel.textContent = isAdmin
                ? (currentAuthUser?.email || currentAuthUser?.$id || 'Admin')
                : '';
        }
    }

    function setAuthError(message) {
        if (!authErrorEl) return;
        authErrorEl.textContent = message || '';
        authErrorEl.classList.toggle('hidden', !message);
    }

    async function initializeAuth() {
        updateAdminUI();
        if (!APPWRITE_CONFIG.adminUserId) {
            console.warn('[LocalSound] APPWRITE_CONFIG.adminUserId đang rỗng; login vẫn mở để debug nhưng không user nào được coi là Admin.');
        }
        if (!window.Appwrite) return;

        try {
            const { account } = createAppwriteServices();
            const user = await account.get();
            currentAuthUser = user;
            isAdmin = Boolean(APPWRITE_CONFIG.adminUserId && user?.$id === APPWRITE_CONFIG.adminUserId);
            if (!isAdmin) {
                currentAuthUser = null;
            }
        } catch (err) {
            currentAuthUser = null;
            isAdmin = false;
            if (err?.code !== 401) {
                console.warn('[LocalSound] Không kiểm tra được Appwrite session:', err);
            }
        }
        updateAdminUI();
    }

    async function loginAdmin(email, password) {
        if (!APPWRITE_CONFIG.adminUserId) {
            throw new Error('Chưa cấu hình Admin User ID trong APPWRITE_CONFIG.adminUserId.');
        }

        const { account } = createAppwriteServices();
        await account.createEmailPasswordSession({ email, password });
        const user = await account.get();

        if (user?.$id !== APPWRITE_CONFIG.adminUserId) {
            await account.deleteSession({ sessionId: 'current' }).catch(() => { });
            throw new Error('Tài khoản này không có quyền Admin.');
        }

        currentAuthUser = user;
        isAdmin = true;
        updateAdminUI();
    }

    async function logoutAdmin() {
        try {
            const { account } = createAppwriteServices();
            await account.deleteSession({ sessionId: 'current' });
        } catch (err) {
            if (err?.code !== 401) {
                console.warn('[LocalSound] Đăng xuất Appwrite không hoàn tất:', err);
            }
        }
        currentAuthUser = null;
        isAdmin = false;
        updateAdminUI();
    }

    function buildAppwritePaginationQueries(Query, limit, offset) {
        if (Query && typeof Query.limit === 'function' && typeof Query.offset === 'function') {
            return [Query.limit(limit), Query.offset(offset)];
        }
        return [`limit(${limit})`, `offset(${offset})`];
    }

    function getFirstRowValue(row, keys) {
        for (const key of keys) {
            const value = row?.[key];
            if (value !== undefined && value !== null && String(value).trim() !== '') {
                return value;
            }
        }
        return '';
    }

    function normalizeCloudPath(value) {
        return String(value || '')
            .replace(/\\/g, '/')
            .replace(/^\.\//, '');
    }

    function getAppwriteFileViewUrl(storage, fileId) {
        return String(storage.getFileView({
            bucketId: APPWRITE_CONFIG.bucketId,
            fileId
        }));
    }

    function mapAppwriteRow(row, storage) {
        const rowId = String(row?.$id || row?.rowId || '').trim();
        const fileId = String(getFirstRowValue(row, [
            'fileId', 'fileID', 'storageFileId', 'storage_file_id', 'file_id', 'audioFileId', 'audio_file_id'
        ]) || '').trim();

        if (!rowId || !fileId) {
            console.warn('[LocalSound] Bỏ qua Appwrite row thiếu $id hoặc fileId:', row);
            return null;
        }

        const rawFilename = String(getFirstRowValue(row, [
            'filename', 'fileName', 'originalName', 'name'
        ]) || fileId).trim();
        const normalizedFilename = normalizeCloudPath(rawFilename);
        const filename = normalizedFilename.split('/').pop() || fileId;
        const rawFolder = String(getFirstRowValue(row, [
            'folder', 'directory', 'directoryName'
        ]) || '').trim();
        const folder = rawFolder && normalizeFolderValue(rawFolder) !== normalizeFolderValue('Tất cả')
            ? rawFolder
            : null;

        return {
            id: rowId,
            rowId,
            filename,
            title: String(getFirstRowValue(row, ['title', 'songTitle']) || filename.replace(/\.[^.]+$/, '')),
            url: getAppwriteFileViewUrl(storage, fileId),
            size: Number(getFirstRowValue(row, ['size', 'sizeOriginal', 'fileSize'])) || 0,
            folder
        };
    }

    async function fetchAppwriteSongs() {
        const { tablesDB, storage, Query } = createAppwriteServices();
        const rows = [];
        let offset = 0;

        while (true) {
            const response = await tablesDB.listRows({
                databaseId: APPWRITE_CONFIG.databaseId,
                tableId: APPWRITE_CONFIG.tableId,
                queries: buildAppwritePaginationQueries(Query, APPWRITE_PAGE_SIZE, offset)
            });
            const page = Array.isArray(response?.rows) ? response.rows : [];
            rows.push(...page);
            offset += page.length;
            if (page.length === 0 || page.length < APPWRITE_PAGE_SIZE) break;
            if (Number.isFinite(response?.total) && rows.length >= response.total) break;
        }

        const songs = rows.map((row) => mapAppwriteRow(row, storage)).filter(Boolean);
        songs.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'vi', { sensitivity: 'base' }));
        console.info(`[LocalSound] Appwrite loaded ${songs.length} songs from ${rows.length} rows.`);
        return songs;
    }

    async function executeCloudDelete(rowId) {
        if (!isAdmin) throw new Error('Bạn cần đăng nhập Admin để xoá bài hát.');

        const { functions, ExecutionMethod } = createAppwriteServices();
        const execution = await functions.createExecution({
            functionId: APPWRITE_CONFIG.functionId,
            body: JSON.stringify({ rowId }),
            async: false,
            xpath: '/',
            method: ExecutionMethod?.POST || 'POST',
            headers: { 'content-type': 'application/json' }
        });

        const status = Number(execution?.responseStatusCode || 0);
        let responseBody = {};
        try {
            responseBody = execution?.responseBody ? JSON.parse(execution.responseBody) : {};
        } catch {
            responseBody = {};
        }

        if (execution?.status === 'failed' || (status && (status < 200 || status >= 300)) || responseBody.success !== true) {
            throw new Error(responseBody.error || execution?.errors || 'Appwrite Function xoá bài hát thất bại.');
        }
        return responseBody;
    }

    function setUploadStatus(message, type = '') {
        if (!adminUploadStatus) return;
        adminUploadStatus.textContent = message || '';
        adminUploadStatus.classList.toggle('hidden', !message);
        adminUploadStatus.classList.toggle('is-error', type === 'error');
        adminUploadStatus.classList.toggle('is-success', type === 'success');
        adminUploadStatus.classList.toggle('is-uploading', type === 'uploading');
    }

    function updateUploadFileMeta() {
        const file = adminUploadFileInput?.files?.[0];
        if (!adminUploadFileMeta) return;

        if (!file) {
            adminUploadFileMeta.textContent = '';
            adminUploadFileMeta.classList.add('hidden');
            return;
        }

        adminUploadFileMeta.textContent = `${file.name} · ${formatFileSize(file.size)}`;
        adminUploadFileMeta.classList.remove('hidden');
    }

    function validateUploadFile(file) {
        if (!file) {
            throw new Error('Vui lòng chọn một file MP3.');
        }
        if (!/\.mp3$/i.test(file.name)) {
            throw new Error('Chỉ được upload file có phần mở rộng .mp3.');
        }
        if (!Number.isFinite(file.size) || file.size <= 0) {
            throw new Error('File MP3 không được rỗng.');
        }
        if (file.size > APPWRITE_CONFIG.maxUploadBytes) {
            throw new Error(`File vượt quá giới hạn bucket (${formatFileSize(APPWRITE_CONFIG.maxUploadBytes)}).`);
        }
    }

    async function uploadCloudSong({ file }) {
        if (!isAdmin) {
            throw new Error('Bạn cần đăng nhập Admin để upload bài hát.');
        }

        validateUploadFile(file);
        const filename = file.name;
        const cleanTitle = filename.replace(/\.[^.]+$/, '').trim();
        if (!cleanTitle) {
            throw new Error('Không thể tạo title từ tên file MP3.');
        }

        const { storage, tablesDB, ID } = createAppwriteServices();
        const uploadedFile = await storage.createFile({
            bucketId: APPWRITE_CONFIG.bucketId,
            fileId: ID.unique(),
            file
        });
        const fileId = String(uploadedFile?.$id || '').trim();

        if (!fileId) {
            throw new Error('Appwrite upload thành công nhưng không trả về fileId.');
        }

        try {
            const createdRow = await tablesDB.createRow({
                databaseId: APPWRITE_CONFIG.databaseId,
                tableId: APPWRITE_CONFIG.tableId,
                rowId: ID.unique(),
                data: {
                    title: cleanTitle,
                    filename,
                    fileId,
                    folder: null,
                    size: file.size,
                    active: true
                }
            });

            return {
                rowId: String(createdRow?.$id || '').trim(),
                fileId
            };
        } catch (rowError) {
            let cleanupError = null;
            try {
                await storage.deleteFile({
                    bucketId: APPWRITE_CONFIG.bucketId,
                    fileId
                });
            } catch (error) {
                cleanupError = error;
                console.error('[LocalSound] Không thể rollback file upload sau khi tạo row thất bại:', error);
            }

            const rowMessage = rowError?.message || 'Appwrite TablesDB từ chối tạo row.';
            const cleanupMessage = cleanupError
                ? ' Không thể tự động xóa file orphan; hãy kiểm tra Storage.'
                : ' File đã được rollback.';
            throw new Error(`Tạo row bài hát thất bại: ${rowMessage}.${cleanupMessage}`);
        }
    }

    async function updateCloudSongFolder(song, catName, isCurrentlyActive) {
        if (!isAdmin) {
            throw new Error('Bạn cần đăng nhập Admin để đổi folder bài hát.');
        }
        if (!song?.rowId) {
            throw new Error('Bài hát thiếu Appwrite rowId, không thể cập nhật folder.');
        }

        const nextFolder = isCurrentlyActive ? null : (CLOUD_CATEGORY_FOLDERS[catName] || null);
        if (!nextFolder && !isCurrentlyActive) {
            throw new Error('Folder category không hợp lệ.');
        }

        const { tablesDB } = createAppwriteServices();
        await tablesDB.updateRow({
            databaseId: APPWRITE_CONFIG.databaseId,
            tableId: APPWRITE_CONFIG.tableId,
            rowId: song.rowId,
            data: { folder: nextFolder }
        });

        await fetchSongs();
        return nextFolder;
    }

    async function changeSongCategory(song, catName, isCurrentlyActive) {
        return updateCloudSongFolder(song, catName, isCurrentlyActive);
    }

    // --- Fetch Songs ---
    async function fetchSongs() {
        try {
            const loadedSongs = await fetchAppwriteSongs();

            allSongs = Array.isArray(loadedSongs) ? loadedSongs : [];

            try {
                await loadUserData();
            } catch (e) {
                console.warn('Không tải được tùy chọn trình duyệt:', e);
            }

            if (totalCountEl) totalCountEl.textContent = allSongs.length;
            updateCategoryBadges();
            renderFolders();
            filterAndRenderSongs();
        } catch (error) {
            console.error('Lỗi khi kết nối danh sách bài hát:', error);
            if (songListEl) {
                songListEl.innerHTML = `<div class="loading-spinner">Không thể kết nối danh sách bài hát.</div>`;
            }
        }
    }

    // --- Helper to Remove Vietnamese Accents for Search ---
    function removeAccents(str) {
        if (!str) return '';
        return str
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .toLowerCase();
    }

    // --- Category Management & Helper ---
    function isTrghyCategory(cats) {
        if (!Array.isArray(cats)) return false;
        return cats.includes('trghy') || cats.includes('tghy') || cats.includes('xxx');
    }

    const CLOUD_CATEGORY_FOLDERS = Object.freeze({
        nhacdo: 'Nhạc Đỏ',
        trghy: 'trghy',
        tghy: 'trghy',
        xxx: 'trghy',
        cooking: 'Nấu Ăn',
        karaoke: 'Karaoke',
        sleep: 'Đi Ngủ'
    });

    function normalizeFolderValue(value) {
        return removeAccents(String(value || '').trim()).toLowerCase();
    }

    function isCloudCategoryActive(song, catName) {
        const expectedFolder = CLOUD_CATEGORY_FOLDERS[catName];
        if (!song || !expectedFolder) return false;
        return normalizeFolderValue(song.folder) === normalizeFolderValue(expectedFolder);
    }

    function getSongCategoriesForUI(song) {
        if (!song) return [];
        return ['nhacdo', 'trghy', 'cooking', 'karaoke', 'sleep']
            .filter((catName) => isCloudCategoryActive(song, catName));
    }

    function isSongCategoryActive(song, catName) {
        if (!song) return false;
        return isCloudCategoryActive(song, catName);
    }

    function updateCategoryBadges() {
        let nhacdoCount = 0;
        let tghyCount = 0;
        let cookingCount = 0;
        let karaokeCount = 0;
        let sleepCount = 0;

        allSongs.forEach(song => {
            if (!song) return;
            const cats = getSongCategoriesForUI(song);
            const folder = (song.folder || '').toLowerCase();
            if (cats.includes('nhacdo')) nhacdoCount++;
            if (isTrghyCategory(cats)) tghyCount++;
            if (cats.includes('cooking') || folder.includes('cooking')) cookingCount++;
            if (cats.includes('karaoke')) karaokeCount++;
            if (cats.includes('sleep') || folder.includes('sleep')) sleepCount++;
        });

        if (nhacdoCountEl) nhacdoCountEl.textContent = nhacdoCount;
        if (tghyCountEl) tghyCountEl.textContent = tghyCount;
        if (cookingCountEl) cookingCountEl.textContent = cookingCount;
        if (karaokeCountEl) karaokeCountEl.textContent = karaokeCount;
        if (sleepCountEl) sleepCountEl.textContent = sleepCount;
    }

    // --- Folder Navigation ---
    function renderFolders() {
        const folders = [...new Set(allSongs.map(s => s ? s.folder : null).filter(Boolean))];
        folderListEl.innerHTML = `
            <button class="folder-item active" data-folder="all">
                <span class="folder-dot"></span> Tất cả (${allSongs.length})
            </button>
        `;

        folders.forEach(folder => {
            if (folder !== 'Tất cả') {
                const count = allSongs.filter(s => s && s.folder === folder).length;
                const btn = document.createElement('button');
                btn.className = 'folder-item';
                btn.dataset.folder = folder;
                btn.innerHTML = `<span class="folder-dot"></span> ${folder} (${count})`;
                folderListEl.appendChild(btn);
            }
        });

        folderListEl.querySelectorAll('.folder-item').forEach(btn => {
            btn.addEventListener('click', () => {
                folderListEl.querySelectorAll('.folder-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentFolder = btn.dataset.folder;
                filterAndRenderSongs();
            });
        });
    }

    // --- Filter & Render Songs ---
    function filterAndRenderSongs() {
        const activeSong = getCurrentPlayingSong();
        currentPlaylist = [...allSongs];

        // Filter by Category Tab
        const playerStage = document.querySelector('.player-stage');
        const playlistSection = document.querySelector('.playlist-section');
        const notesSection = document.getElementById('notes-section');

        if (currentTab === 'note') {
            if (playerStage) playerStage.classList.add('hidden');
            if (playlistSection) playlistSection.classList.add('hidden');
            if (notesSection) notesSection.classList.remove('hidden');
            return;
        } else {
            if (playerStage) playerStage.classList.remove('hidden');
            if (playlistSection) playlistSection.classList.remove('hidden');
            if (notesSection) notesSection.classList.add('hidden');
        }

        const isMobile = window.innerWidth <= 768;

        if (currentTab === 'nhacdo') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('nhacdo'));
            playlistHeadingEl.textContent = isMobile ? 'Nhạc Đỏ' : 'Danh Sách Bài Hát Nhạc Đỏ';
        } else if (currentTab === 'tghy' || currentTab === 'trghy') {
            currentPlaylist = currentPlaylist.filter(s => s && isTrghyCategory(getSongCategoriesForUI(s)));
            playlistHeadingEl.textContent = isMobile ? 'trghy' : 'Danh Sách Bài Hát trghy';
        } else if (currentTab === 'cooking') {
            currentPlaylist = currentPlaylist.filter(s => s && (getSongCategoriesForUI(s).includes('cooking') || (s.folder || '').toLowerCase().includes('cooking')));
            playlistHeadingEl.textContent = isMobile ? 'Nấu Ăn' : 'Danh Sách Bài Hát Nấu Ăn';
        } else if (currentTab === 'karaoke') {
            currentPlaylist = currentPlaylist.filter(s => s && getSongCategoriesForUI(s).includes('karaoke'));
            playlistHeadingEl.textContent = isMobile ? 'Karaoke' : 'Danh Sách Bài Hát Karaoke';
        } else if (currentTab === 'sleep') {
            currentPlaylist = currentPlaylist.filter(s => s && (getSongCategoriesForUI(s).includes('sleep') || (s.folder || '').toLowerCase().includes('sleep')));
            playlistHeadingEl.textContent = isMobile ? 'Đi Ngủ' : 'Danh Sách Bài Hát Đi Ngủ';
        } else if (currentTab === 'recent') {
            const recentArr = Array.isArray(recentSongs) ? recentSongs : [];
            currentPlaylist = recentArr.map(id => allSongs.find(s => s && s.id === id)).filter(Boolean);
            playlistHeadingEl.textContent = 'Vừa Nghe Gần Đây';
        } else {
            playlistHeadingEl.textContent = isMobile ? 'Tất Cả' : 'Tất Cả Bài Hát (A - Z)';
        }

        // Filter by Folder
        if (currentFolder !== 'all') {
            currentPlaylist = currentPlaylist.filter(s => s && s.folder === currentFolder);
        }

        // Filter & Autocomplete Search Query (Incremental Match)
        if (searchQuery.trim() !== '') {
            const rawQ = searchQuery.toLowerCase().trim();
            const normalizedQ = removeAccents(rawQ);

            currentPlaylist = currentPlaylist.filter(s => {
                if (!s || !s.title) return false;
                const titleLower = s.title.toLowerCase();
                const titleNorm = removeAccents(s.title);
                return titleLower.includes(rawQ) || titleNorm.includes(normalizedQ);
            });
            playlistHeadingEl.textContent = `Kết quả tìm kiếm cho "${searchQuery}"`;
        }

        // Sort Playlist
        sortPlaylist();

        // Re-sync currentIndex to match currently playing song
        if (activeSong) {
            const newIdx = currentPlaylist.findIndex(s => s && s.id === activeSong.id);
            if (newIdx !== -1) {
                currentIndex = newIdx;
            }
        }

        playlistCountEl.textContent = `${currentPlaylist.length} bài hát`;
        renderSongList();
    }

    function sortPlaylist() {
        if (sortOption === 'title-asc') {
            currentPlaylist.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'vi', { sensitivity: 'base' }));
        } else if (sortOption === 'title-desc') {
            currentPlaylist.sort((a, b) => (b.title || '').localeCompare(a.title || '', 'vi', { sensitivity: 'base' }));
        } else if (sortOption === 'size-desc') {
            currentPlaylist.sort((a, b) => (b.size || 0) - (a.size || 0));
        }
    }

    function renderSongList() {
        if (!songListEl) return;
        if (currentPlaylist.length === 0) {
            songListEl.innerHTML = `<div class="loading-spinner">Không tìm thấy bài hát nào phù hợp</div>`;
            return;
        }

        songListEl.innerHTML = '';
        const categoryNameMap = {
            nhacdo: 'Nhạc Đỏ',
            tghy: 'trghy',
            cooking: 'Nấu Ăn',
            karaoke: 'Karaoke',
            sleep: 'Đi Ngủ'
        };

        const activeSong = getCurrentPlayingSong();

        currentPlaylist.forEach((song, index) => {
            if (!song || !song.title) return;
            const isCurrent = activeSong && activeSong.id === song.id;
            const canEditCategories = isAdmin;

            const songDiv = document.createElement('div');
            songDiv.className = `song-item ${isCurrent ? 'active' : ''}`;

            // Highlight Search Term in Title
            let displayTitle = escapeHtml(song.title);
            if (searchQuery.trim() !== '') {
                const q = searchQuery.trim();
                const regex = new RegExp(`(${q})`, 'gi');
                displayTitle = displayTitle.replace(regex, `<span class="highlight-text">$1</span>`);
            }

            const hasNhacdo = isSongCategoryActive(song, 'nhacdo');
            const hasTghy = isSongCategoryActive(song, 'trghy');
            const hasCooking = isSongCategoryActive(song, 'cooking');
            const hasKaraoke = isSongCategoryActive(song, 'karaoke');
            const hasSleep = isSongCategoryActive(song, 'sleep');

            const categoryTagButtons = canEditCategories ? `
                    <button class="cat-tag-btn ${hasNhacdo ? 'active' : ''}" data-cat="nhacdo" title="Nhạc Đỏ"><span class="icon-cat icon-nhacdo"></span></button>
                    <button class="cat-tag-btn ${hasTghy ? 'active' : ''}" data-cat="tghy" title="trghy"><span class="icon-cat icon-tghy"></span></button>
                    <button class="cat-tag-btn ${hasCooking ? 'active' : ''}" data-cat="cooking" title="Nấu ăn"><span class="icon-cat icon-cooking"></span></button>
                    <button class="cat-tag-btn ${hasKaraoke ? 'active' : ''}" data-cat="karaoke" title="Karaoke"><span class="icon-cat icon-karaoke"></span></button>
                    <button class="cat-tag-btn ${hasSleep ? 'active' : ''}" data-cat="sleep" title="Đi ngủ"><span class="icon-cat icon-sleep"></span></button>
                ` : '';

            const songActions = canEditCategories ? `
                <div class="song-actions-wrapper">
                    <button class="btn-song-more" title="Tùy chọn">⋮</button>
                    <div class="song-dropdown-menu hidden">
                        <div class="dropdown-header-label">Danh mục</div>
                        <button class="dropdown-item dropdown-cat-item ${hasNhacdo ? 'active' : ''}" data-cat="nhacdo">
                            <span class="icon-cat icon-nhacdo"></span> <span>Nhạc Đỏ</span> ${hasNhacdo ? '<span class="cat-check">✓</span>' : ''}
                        </button>
                        <button class="dropdown-item dropdown-cat-item ${hasTghy ? 'active' : ''}" data-cat="tghy">
                            <span class="icon-cat icon-tghy"></span> <span>trghy</span> ${hasTghy ? '<span class="cat-check">✓</span>' : ''}
                        </button>
                        <button class="dropdown-item dropdown-cat-item ${hasCooking ? 'active' : ''}" data-cat="cooking">
                            <span class="icon-cat icon-cooking"></span> <span>Nấu Ăn</span> ${hasCooking ? '<span class="cat-check">✓</span>' : ''}
                        </button>
                        <button class="dropdown-item dropdown-cat-item ${hasKaraoke ? 'active' : ''}" data-cat="karaoke">
                            <span class="icon-cat icon-karaoke"></span> <span>Karaoke</span> ${hasKaraoke ? '<span class="cat-check">✓</span>' : ''}
                        </button>
                        <button class="dropdown-item dropdown-cat-item ${hasSleep ? 'active' : ''}" data-cat="sleep">
                            <span class="icon-cat icon-sleep"></span> <span>Đi Ngủ</span> ${hasSleep ? '<span class="cat-check">✓</span>' : ''}
                        </button>
                        ${isAdmin ? '<div class="dropdown-divider"></div><button class="dropdown-item danger btn-delete-song">🗑️ Xoá bài hát</button>' : ''}
                    </div>
                </div>
            ` : '';

            songDiv.innerHTML = `
                <div class="song-index">${isCurrent && isPlaying ? '▶' : index + 1}</div>
                <div class="song-main-info">
                    <span class="song-title-text">${displayTitle}</span>
                </div>
                <div class="song-tags-container">${categoryTagButtons}</div>
                ${songActions}
            `;

            // Click item to play
            songDiv.addEventListener('click', (e) => {
                if (e.target.closest('.cat-tag-btn') || e.target.closest('.song-actions-wrapper')) return;
                playTrack(index);
            });

            // Toggle category tags from row buttons (Instant add, Confirmation on remove)
            const handleCategoryToggle = (catName, isCurrentlyActive) => {
                const catLabel = categoryNameMap[catName] || catName;
                const applyChange = async () => {
                    try {
                        await changeSongCategory(song, catName, isCurrentlyActive);
                        showToast(
                            isCurrentlyActive
                                ? `Đã bỏ bài hát khỏi danh sách ${catLabel}`
                                : `Đã thêm bài hát vào danh sách ${catLabel}`,
                            isCurrentlyActive ? 'info' : 'success'
                        );
                    } catch (error) {
                        console.error('[LocalSound] Cloud folder update failed:', error);
                        showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    }
                };

                if (isCurrentlyActive) {
                    showConfirmModal({
                        title: '⚠️ Xác nhận bỏ khỏi danh sách',
                        message: `Bạn có thật sự muốn bỏ bài hát "${song.title}" khỏi danh sách ${catLabel} không?`,
                        confirmText: 'Đồng ý bỏ',
                        isDanger: true,
                        onConfirm: () => { void applyChange(); }
                    });
                } else {
                    void applyChange();
                }
            };

            songDiv.querySelectorAll('.cat-tag-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const catName = btn.dataset.cat;
                    const isCurrentlyActive = btn.classList.contains('active');
                    handleCategoryToggle(catName, isCurrentlyActive);
                });
            });

            // Toggle category tags from 3-dots dropdown menu
            const dropdownMenu = songDiv.querySelector('.song-dropdown-menu');
            if (dropdownMenu) {
                dropdownMenu.querySelectorAll('.dropdown-cat-item').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        const catName = btn.dataset.cat;
                        const isCurrentlyActive = btn.classList.contains('active');
                        dropdownMenu.classList.add('hidden');
                        handleCategoryToggle(catName, isCurrentlyActive);
                    });
                });
            }

            // 3-Dots Action Menu & Song Deletion
            const moreBtn = songDiv.querySelector('.btn-song-more');
            const deleteBtn = songDiv.querySelector('.btn-delete-song');

            if (moreBtn && dropdownMenu) {
                moreBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    document.querySelectorAll('.song-dropdown-menu').forEach(menu => {
                        if (menu !== dropdownMenu) menu.classList.add('hidden');
                    });
                    dropdownMenu.classList.toggle('hidden');
                });
            }

            if (deleteBtn) {
                deleteBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (dropdownMenu) dropdownMenu.classList.add('hidden');

                    showConfirmModal({
                        title: '⚠️ Xoá bài hát',
                        message: `Bài hát "${song.title}" sẽ bị xoá vĩnh viễn`,
                        confirmText: 'Xoá vĩnh viễn',
                        isDanger: true,
                        onConfirm: () => {
                            deleteSong(song);
                        }
                    });
                });
            }

            songListEl.appendChild(songDiv);
        });
    }

    // --- Delete Song API Handler ---
    async function deleteSong(song) {
        if (!song || !song.id) return;
        if (!isAdmin) {
            showToast('Bạn cần đăng nhập Admin để xoá bài hát.', 'warning');
            return;
        }

        if (!song.rowId) {
            showToast('Bài hát này thiếu Appwrite rowId, không thể xoá an toàn.', 'warning');
            return;
        }

        try {
            await executeCloudDelete(song.rowId);
        } catch (err) {
            console.error('[LocalSound] Cloud delete failed:', err);
            showToast(`Xoá thất bại: ${err?.message || 'Appwrite Function không phản hồi.'}`, 'warning');
            return;
        }

        if (currentIndex >= 0 && currentPlaylist[currentIndex]?.id === song.id) {
            audio.pause();
            isPlaying = false;
            audio.src = '';
            currentIndex = -1;
            if (currentTitle) currentTitle.textContent = 'Chọn một bài hát để bắt đầu';
        }

        allSongs = allSongs.filter(s => s && s.id !== song.id);

        if (totalCountEl) totalCountEl.textContent = allSongs.length;
        updateCategoryBadges();
        renderFolders();
        filterAndRenderSongs();
        updatePlayerUI();

        showToast(`Đã xoá bài hát "${song.title}" vĩnh viễn trên Appwrite.`, 'success');
    }

    // --- Helper Confirmation Modal ---
    function showConfirmModal({ title, message, confirmText = 'Xác nhận', isDanger = false, onConfirm }) {
        const confirmModal = document.getElementById('confirm-modal');
        const titleEl = document.getElementById('confirm-modal-title');
        const messageEl = document.getElementById('confirm-modal-message');
        const okBtn = document.getElementById('confirm-modal-ok');
        const cancelBtn = document.getElementById('confirm-modal-cancel');
        const closeBtn = document.getElementById('close-confirm');

        if (!confirmModal || !messageEl || !okBtn) return;

        if (titleEl) titleEl.textContent = title || '⚠️ Xác nhận';
        messageEl.textContent = message || '';
        okBtn.textContent = confirmText;

        if (isDanger) {
            okBtn.style.background = '#ef4444';
            okBtn.style.boxShadow = '0 0 12px rgba(239, 68, 68, 0.4)';
        } else {
            okBtn.style.background = 'var(--gradient-accent)';
            okBtn.style.boxShadow = '0 0 12px var(--primary-glow)';
        }

        const cleanup = () => {
            confirmModal.classList.remove('active');
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            if (closeBtn) closeBtn.onclick = null;
        };

        okBtn.onclick = () => {
            cleanup();
            if (typeof onConfirm === 'function') onConfirm();
        };

        cancelBtn.onclick = cleanup;
        if (closeBtn) closeBtn.onclick = cleanup;

        confirmModal.classList.add('active');
    }

    // --- Audio Player Logic ---
    function playTrack(index) {
        if (index < 0 || index >= currentPlaylist.length) return;

        currentIndex = index;
        const song = currentPlaylist[currentIndex];
        if (!song || !song.url) return;

        currentPlayingSong = song;
        audio.src = song.url;
        audio.play().then(() => {
            isPlaying = true;
            updatePlayerUI();
            initAudioContext();
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            addToRecent(song.id);
        }).catch(err => {
            console.error('Không thể phát bài hát:', err);
        });
    }

    function togglePlayPause() {
        if (currentIndex === -1 && currentPlaylist.length > 0) {
            playTrack(0);
            return;
        }

        if (isPlaying) {
            audio.pause();
            isPlaying = false;
        } else {
            initAudioContext();
            if (audioCtx && audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            audio.play();
            isPlaying = true;
        }
        updatePlayerUI();
    }

    function playNextTrack() {
        if (currentPlaylist.length === 0) return;

        if (loopMode === 'shuffle') {
            let nextIdx = Math.floor(Math.random() * currentPlaylist.length);
            if (currentPlaylist.length > 1 && nextIdx === currentIndex) {
                nextIdx = (currentIndex + 1) % currentPlaylist.length;
            }
            playTrack(nextIdx);
        } else {
            let nextIdx = currentIndex + 1;
            if (nextIdx >= currentPlaylist.length) {
                nextIdx = 0;
            }
            playTrack(nextIdx);
        }
    }

    function playPrevTrack() {
        if (currentPlaylist.length === 0) return;

        if (audio.currentTime > 3) {
            audio.currentTime = 0;
            return;
        }

        let prevIdx = currentIndex - 1;
        if (prevIdx < 0) {
            prevIdx = currentPlaylist.length - 1;
        }
        playTrack(prevIdx);
    }

    // Auto-Advance Next Track on Ended
    audio.addEventListener('ended', () => {
        if (loopMode === 'one') {
            audio.currentTime = 0;
            audio.play();
        } else {
            playNextTrack();
        }
    });

    // Seek Bar Logic
    let isSeeking = false;
    const seekWrapper = document.getElementById('progress-wrapper');
    const seekTooltip = document.getElementById('seek-tooltip');

    audio.addEventListener('timeupdate', () => {
        if (!isNaN(audio.duration) && audio.duration > 0) {
            durationTimeEl.textContent = formatTime(audio.duration);
            if (!isSeeking) {
                const percent = (audio.currentTime / audio.duration) * 100;
                seekSlider.value = percent;
                seekFill.style.width = `${percent}%`;
                currentTimeEl.textContent = formatTime(audio.currentTime);
            }
            if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
                try {
                    navigator.mediaSession.setPositionState({
                        duration: audio.duration,
                        playbackRate: audio.playbackRate || 1,
                        position: audio.currentTime
                    });
                } catch (e) { }
            }
        }
    });

    if (seekSlider) {
        seekSlider.addEventListener('mousedown', () => { isSeeking = true; if (seekWrapper) seekWrapper.classList.add('active'); });
        seekSlider.addEventListener('touchstart', () => { isSeeking = true; if (seekWrapper) seekWrapper.classList.add('active'); });

        seekSlider.addEventListener('input', () => {
            isSeeking = true;
            const percent = parseFloat(seekSlider.value);
            seekFill.style.width = `${percent}%`;
            if (!isNaN(audio.duration) && audio.duration > 0) {
                const targetTime = (percent / 100) * audio.duration;
                currentTimeEl.textContent = formatTime(targetTime);
            }
        });
    }

    const commitSeek = () => {
        if (isSeeking) {
            if (!isNaN(audio.duration) && audio.duration > 0) {
                const percent = parseFloat(seekSlider.value);
                audio.currentTime = (percent / 100) * audio.duration;
            }
            isSeeking = false;
            if (seekWrapper) seekWrapper.classList.remove('active');
        }
    };

    if (seekSlider) {
        seekSlider.addEventListener('change', commitSeek);
        seekSlider.addEventListener('mouseup', commitSeek);
        seekSlider.addEventListener('touchend', commitSeek);
    }

    if (seekWrapper) {
        seekWrapper.addEventListener('click', (e) => {
            if (e.target === seekSlider) return;
            if (!isNaN(audio.duration) && audio.duration > 0) {
                const rect = seekWrapper.getBoundingClientRect();
                const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                const percent = (offsetX / rect.width) * 100;
                const targetTime = (percent / 100) * audio.duration;
                seekSlider.value = percent;
                seekFill.style.width = `${percent}%`;
                audio.currentTime = targetTime;
                currentTimeEl.textContent = formatTime(targetTime);
            }
        });

        seekWrapper.addEventListener('mousemove', (e) => {
            if (seekTooltip && !isNaN(audio.duration) && audio.duration > 0) {
                const rect = seekWrapper.getBoundingClientRect();
                const offsetX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
                const hoverPercent = offsetX / rect.width;
                const hoverTime = hoverPercent * audio.duration;

                seekTooltip.textContent = formatTime(hoverTime);
                seekTooltip.style.left = `${offsetX}px`;
                seekTooltip.classList.remove('hidden');
            }
        });

        seekWrapper.addEventListener('mouseleave', () => {
            if (seekTooltip) seekTooltip.classList.add('hidden');
        });
    }

    // Volume Logic
    if (volumeSlider) {
        volumeSlider.addEventListener('input', () => {
            const vol = parseFloat(volumeSlider.value);
            audio.volume = vol;
            volumeFill.style.width = `${vol * 100}%`;
            audio.muted = vol === 0;
            updateVolumeIcons();
        });
    }

    if (muteBtn) {
        muteBtn.addEventListener('click', () => {
            audio.muted = !audio.muted;
            if (audio.muted) {
                volumeFill.style.width = '0%';
            } else {
                volumeFill.style.width = `${audio.volume * 100}%`;
            }
            updateVolumeIcons();
        });
    }

    function updateVolumeIcons() {
        if (audio.muted || audio.volume === 0) {
            if (volIcon) volIcon.classList.add('hidden');
            if (muteIcon) muteIcon.classList.remove('hidden');
        } else {
            if (volIcon) volIcon.classList.remove('hidden');
            if (muteIcon) muteIcon.classList.add('hidden');
        }
    }

    // --- Mobile View Navigation Logic ---
    function setMobileTab(tab) {
        mobileTab = tab;
        try {
            localStorage.setItem('local_music_mobile_tab', tab);
        } catch (e) { }

        // Reset scroll position before and after class change to prevent sticky/fixed elements from being pushed off-screen
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;

        document.body.classList.remove('mobile-view-for-you', 'mobile-view-library');
        document.body.classList.add('mobile-view-' + tab);

        // Ensure scroll reset is applied after class switch across all containers
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
        const appContainer = document.querySelector('.app-container');
        if (appContainer) appContainer.scrollTop = 0;
        const mainContent = document.querySelector('.main-content');
        if (mainContent) mainContent.scrollTop = 0;

        const mobileTabForYou = document.getElementById('mobile-tab-for-you');
        const mobileTabLibrary = document.getElementById('mobile-tab-library');
        if (mobileTabForYou) mobileTabForYou.classList.toggle('active', tab === 'for-you');
        if (mobileTabLibrary) mobileTabLibrary.classList.toggle('active', tab === 'library');

        updateMiniPlayerVisibility();
    }

    function updateMiniPlayerVisibility() {
        const mobileMiniPlayer = document.getElementById('mobile-mini-player');
        if (!mobileMiniPlayer) return;
        const song = getCurrentPlayingSong();
        if (mobileTab === 'library' && song) {
            mobileMiniPlayer.classList.remove('hidden');
        } else {
            mobileMiniPlayer.classList.add('hidden');
        }
    }

    function updateMiniPlayerUI() {
        const miniPlayIcon = document.getElementById('mini-play-icon');
        const miniPauseIcon = document.getElementById('mini-pause-icon');
        const miniDisc = document.getElementById('mini-disc');
        const miniTitle = document.getElementById('mini-title');
        const miniArtist = document.getElementById('mini-artist');

        const song = getCurrentPlayingSong();
        if (song) {
            if (miniTitle) miniTitle.textContent = song.title;
            if (miniArtist) miniArtist.textContent = song.folder || 'LocalSound';
        }

        if (isPlaying) {
            if (miniPlayIcon) miniPlayIcon.classList.add('hidden');
            if (miniPauseIcon) miniPauseIcon.classList.remove('hidden');
            if (miniDisc) miniDisc.classList.add('playing');
        } else {
            if (miniPlayIcon) miniPlayIcon.classList.remove('hidden');
            if (miniPauseIcon) miniPauseIcon.classList.add('hidden');
            if (miniDisc) miniDisc.classList.remove('playing');
        }
        updateMiniPlayerVisibility();
    }

    // --- UI Update Helpers ---
    function updatePlayerUI() {
        if (isPlaying) {
            if (playIcon) playIcon.classList.add('hidden');
            if (pauseIcon) pauseIcon.classList.remove('hidden');
            if (vinylDisc) vinylDisc.classList.add('playing');
        } else {
            if (playIcon) playIcon.classList.remove('hidden');
            if (pauseIcon) pauseIcon.classList.add('hidden');
            if (vinylDisc) vinylDisc.classList.remove('playing');
        }

        const psTrackName = document.getElementById('ps-track-name');
        const psPlayBtn = document.getElementById('ps-play-btn');
        if (psPlayBtn) psPlayBtn.textContent = isPlaying ? '⏸️' : '▶️';

        const song = getCurrentPlayingSong();
        if (song) {
            const vinylImg = document.getElementById('vinyl-img');
            if (currentTitle) currentTitle.textContent = song.title;
            if (vinylArt && (!vinylImg || vinylImg.classList.contains('hidden'))) {
                vinylArt.textContent = '🎵';
            }
            if (psTrackName) psTrackName.textContent = `🎵 ${song.title}`;
            updateCurrentTrackTags();
        }

        updateMiniPlayerUI();
        updateHeartUI();
        updateMediaSession();
        renderSongList();
    }

    function updateMediaSession() {
        if (!('mediaSession' in navigator)) return;

        const song = getCurrentPlayingSong();
        if (song) {
            try {
                navigator.mediaSession.metadata = new MediaMetadata({
                    title: song.title || 'LocalSound',
                    artist: song.folder || 'LocalSound Music',
                    album: 'LocalSound Cloud Music',
                    artwork: [
                        { src: `${ASSET_BASE_PATH}logo/logo.png`, sizes: '96x96', type: 'image/png' },
                        { src: `${ASSET_BASE_PATH}logo/logo.png`, sizes: '128x128', type: 'image/png' },
                        { src: `${ASSET_BASE_PATH}logo/logo.png`, sizes: '192x192', type: 'image/png' },
                        { src: `${ASSET_BASE_PATH}logo/logo.png`, sizes: '512x512', type: 'image/png' }
                    ]
                });
            } catch (e) {
                console.warn('MediaSession metadata error:', e);
            }
        }

        navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    }

    function updateHeartUI() {
        const pmFavBtn = document.getElementById('pm-fav-btn');
        const pmFavTitle = document.getElementById('pm-fav-title');
        const pmFavLabel = document.getElementById('pm-fav-label');

        const song = getCurrentPlayingSong();

        const catDisplayMap = {
            nhacdo: { iconHtml: '<span class="icon-cat icon-nhacdo" style="margin-right: 4px;"></span>', label: 'Nhạc Đỏ', color: '#00d9f5' },
            sleep: { iconHtml: '<span class="icon-cat icon-sleep" style="margin-right: 4px;"></span>', label: 'Đi Ngủ', color: '#a855f7' },
            cooking: { iconHtml: '<span class="icon-cat icon-cooking" style="margin-right: 4px;"></span>', label: 'Nấu Ăn', color: '#f59e0b' },
            karaoke: { iconHtml: '<span class="icon-cat icon-karaoke" style="margin-right: 4px;"></span>', label: 'Karaoke', color: '#ec4899' },
            trghy: { iconHtml: '<span class="icon-cat icon-trghy" style="margin-right: 4px;"></span>', label: '<span class="icon-cat icon-trghy"></span>', color: '#ef4444' },
            tghy: { iconHtml: '<span class="icon-cat icon-trghy" style="margin-right: 4px;"></span>', label: '<span class="icon-cat icon-trghy"></span>', color: '#ef4444' },
            xxx: { iconHtml: '<span class="icon-cat icon-trghy" style="margin-right: 4px;"></span>', label: '<span class="icon-cat icon-trghy"></span>', color: '#ef4444' }
        };

        if (song) {
            const cats = getSongCategoriesForUI(song);
            let activeCatKey = null;

            const priorityKeys = ['nhacdo', 'sleep', 'cooking', 'karaoke', 'trghy', 'tghy', 'xxx'];
            for (let key of priorityKeys) {
                if (cats.includes(key)) {
                    activeCatKey = key;
                    break;
                }
            }

            if (activeCatKey && catDisplayMap[activeCatKey]) {
                const info = catDisplayMap[activeCatKey];
                if (pmFavBtn) pmFavBtn.classList.add('active');
                if (pmFavTitle) {
                    pmFavTitle.innerHTML = `${info.iconHtml} Danh sách:`;
                    pmFavTitle.style.color = 'var(--text-main)';
                }
                if (pmFavLabel) {
                    pmFavLabel.innerHTML = info.label;
                    pmFavLabel.style.color = info.color;
                }
            } else {
                if (pmFavBtn) pmFavBtn.classList.remove('active');
                if (pmFavTitle) {
                    pmFavTitle.innerHTML = 'Danh sách:';
                    pmFavTitle.style.color = 'var(--text-dim)';
                }
                if (pmFavLabel) {
                    pmFavLabel.textContent = 'Chưa lưu';
                    pmFavLabel.style.color = 'var(--text-dim)';
                }
            }
        } else {
            if (pmFavBtn) pmFavBtn.classList.remove('active');
            if (pmFavTitle) {
                pmFavTitle.innerHTML = 'Danh sách:';
                pmFavTitle.style.color = 'var(--text-dim)';
            }
            if (pmFavLabel) {
                pmFavLabel.textContent = 'Chưa lưu';
                pmFavLabel.style.color = 'var(--text-dim)';
            }
        }
    }

    function openCategoryPickerModal() {
        const song = getCurrentPlayingSong();
        if (!song) return;
        if (!isAdmin) {
            showToast('Chỉ Admin mới được chỉnh folder bài hát.', 'warning');
            return;
        }
        const modal = document.getElementById('cat-picker-modal');
        const songNameEl = document.getElementById('cat-picker-song-name');
        const optionsEl = document.getElementById('cat-picker-options');
        const closeBtn = document.getElementById('close-cat-picker');

        if (!modal || !optionsEl) return;

        if (songNameEl) songNameEl.textContent = `🎵 ${song.title}`;

        const categories = [
            { key: 'nhacdo', label: '<span class="icon-cat icon-nhacdo" style="margin-right: 6px;"></span> Nhạc Đỏ' },
            { key: 'sleep', label: '<span class="icon-cat icon-sleep" style="margin-right: 6px;"></span> Đi Ngủ' },
            { key: 'cooking', label: '<span class="icon-cat icon-cooking" style="margin-right: 6px;"></span> Nấu Ăn' },
            { key: 'karaoke', label: '<span class="icon-cat icon-karaoke" style="margin-right: 6px;"></span> Karaoke' },
            { key: 'trghy', label: '<span class="icon-cat icon-trghy"></span>' }
        ];

        const songCats = getSongCategoriesForUI(song);
        optionsEl.innerHTML = '';

        categories.forEach(cat => {
            const isChecked = cat.key === 'trghy' ? isTrghyCategory(songCats) : songCats.includes(cat.key);
            const row = document.createElement('label');
            row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: rgba(255,255,255,0.05); border: 1px solid var(--border-glass); border-radius: var(--radius-sm); color: var(--text-main); cursor: pointer; font-size: 0.92rem; font-weight: 500;';

            row.innerHTML = `
                <span>${cat.label}</span>
                <input type="checkbox" ${isChecked ? 'checked' : ''} style="width: 20px; height: 20px; cursor: pointer; accent-color: var(--primary);">
            `;

            const chk = row.querySelector('input');
            const catCleanMap = { nhacdo: 'Nhạc Đỏ', sleep: 'Đi Ngủ', cooking: 'Nấu Ăn', karaoke: 'Karaoke', trghy: 'trghy' };
            const catCleanName = catCleanMap[cat.key] || 'danh sách';

            chk.addEventListener('click', (e) => {
                const nowCats = getSongCategoriesForUI(song);
                const isNowChecked = cat.key === 'trghy' ? isTrghyCategory(nowCats) : nowCats.includes(cat.key);
                const applyChange = async (currentlyActive) => {
                    try {
                        await changeSongCategory(song, cat.key, currentlyActive);
                        chk.checked = !currentlyActive;
                        updateHeartUI();
                        showToast(
                            currentlyActive
                                ? `Đã bỏ bài "${song.title}" khỏi danh sách ${catCleanName}`
                                : `Đã thêm bài "${song.title}" vào ${catCleanName}`,
                            currentlyActive ? 'info' : 'success'
                        );
                    } catch (error) {
                        console.error('[LocalSound] Cloud folder update failed:', error);
                        showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    }
                };

                if (isNowChecked) {
                    e.preventDefault();
                    showConfirmModal({
                        title: '⚠️ Xác nhận bỏ khỏi danh sách',
                        message: `Bạn có thật sự muốn bỏ bài hát "${song.title}" khỏi danh sách ${catCleanName} không?`,
                        confirmText: 'Đồng ý bỏ',
                        isDanger: true,
                        onConfirm: () => { void applyChange(true); }
                    });
                } else {
                    void applyChange(false);
                }
            });

            optionsEl.appendChild(row);
        });

        if (closeBtn) closeBtn.onclick = () => modal.classList.remove('active');
        modal.classList.add('active');
    }

    function updateCurrentTrackTags() {
        const song = getCurrentPlayingSong();
        if (!song || !currentTags) return;
        const cats = getSongCategoriesForUI(song);

        currentTags.innerHTML = '';
        const tagMap = {
            nhacdo: '<span class="icon-cat icon-nhacdo" style="margin-right: 4px;"></span> Nhạc Đỏ',
            trghy: '<span class="icon-cat icon-trghy"></span>',
            tghy: '<span class="icon-cat icon-trghy"></span>',
            xxx: '<span class="icon-cat icon-trghy"></span>',
            cooking: '<span class="icon-cat icon-cooking" style="margin-right: 4px;"></span> Nấu ăn',
            karaoke: '<span class="icon-cat icon-karaoke" style="margin-right: 4px;"></span> Karaoke',
            sleep: '<span class="icon-cat icon-sleep" style="margin-right: 4px;"></span> Đi ngủ'
        };

        const addedTags = new Set();
        cats.forEach(c => {
            const label = tagMap[c];
            if (label && !addedTags.has(label)) {
                addedTags.add(label);
                const chip = document.createElement('span');
                chip.className = 'tag-chip';
                chip.innerHTML = label;
                currentTags.appendChild(chip);
            }
        });
    }


    function addToRecent(songId) {
        if (!Array.isArray(recentSongs)) recentSongs = [];
        recentSongs = [songId, ...recentSongs.filter(id => id !== songId)].slice(0, 20);
            saveUserData();
    }

    function updateLoopModeButtonUI() {
        if (!modeIcon || !modeLabel) return;
        if (loopMode === 'one') {
            modeIcon.textContent = '🔂';
            modeLabel.textContent = 'Lặp 1 bài';
        } else if (loopMode === 'shuffle') {
            modeIcon.textContent = '🔀';
            modeLabel.textContent = 'Ngẫu nhiên';
        } else {
            modeIcon.textContent = '🔁';
            modeLabel.textContent = 'Theo thứ tự';
        }
    }

    // --- Cycle Playback Mode ---
    function cycleLoopMode() {
        if (loopMode === 'sequential') {
            loopMode = 'one';
        } else if (loopMode === 'one') {
            loopMode = 'shuffle';
        } else {
            loopMode = 'sequential';
        }
        updateLoopModeButtonUI();
            saveUserData();
    }

    // --- Setup Listeners ---
    function setupEventListeners() {
        if (playBtn) playBtn.addEventListener('click', togglePlayPause);
        if (nextBtn) nextBtn.addEventListener('click', playNextTrack);
        if (prevBtn) prevBtn.addEventListener('click', playPrevTrack);
        if (modeCycleBtn) modeCycleBtn.addEventListener('click', cycleLoopMode);

        if (authLoginBtn && authModal) {
            authLoginBtn.addEventListener('click', () => {
                setAuthError('');
                authModal.classList.add('active');
                authEmailInput?.focus();
            });
        }
        if (authCloseBtn && authModal) {
            authCloseBtn.addEventListener('click', () => authModal.classList.remove('active'));
        }
        if (authForm) {
            authForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                setAuthError('');
                const email = authEmailInput?.value.trim() || '';
                const password = authPasswordInput?.value || '';
                if (!email || !password) {
                    setAuthError('Vui lòng nhập email và mật khẩu.');
                    return;
                }

                const submitBtn = authForm.querySelector('button[type="submit"]');
                if (submitBtn) submitBtn.disabled = true;
                try {
                    await loginAdmin(email, password);
                    if (authPasswordInput) authPasswordInput.value = '';
                    authModal?.classList.remove('active');
                    filterAndRenderSongs();
                    showToast('Đăng nhập Admin thành công.', 'success');
                } catch (err) {
                    setAuthError(err?.message || 'Đăng nhập thất bại.');
                } finally {
                    if (submitBtn) submitBtn.disabled = false;
                }
            });
        }
        if (adminLogoutBtn) {
            adminLogoutBtn.addEventListener('click', async () => {
                await logoutAdmin();
                filterAndRenderSongs();
                showToast('Đã đăng xuất Admin.', 'info');
            });
        }
        if (adminUploadBtn && uploadPlaceholderModal) {
            adminUploadBtn.addEventListener('click', () => {
                if (!isAdmin) return;
                setUploadStatus('');
                updateUploadFileMeta();
                uploadPlaceholderModal.classList.add('active');
                adminUploadFileInput?.focus();
            });
        }
        if (closeUploadPlaceholder && uploadPlaceholderModal) {
            closeUploadPlaceholder.addEventListener('click', () => uploadPlaceholderModal.classList.remove('active'));
        }
        if (adminUploadFileInput) {
            adminUploadFileInput.addEventListener('change', updateUploadFileMeta);
        }
        if (adminUploadForm) {
            adminUploadForm.addEventListener('submit', async (event) => {
                event.preventDefault();
                if (adminUploadSubmit) adminUploadSubmit.disabled = true;
                setUploadStatus('Uploading...', 'uploading');

                try {
                    await uploadCloudSong({
                        file: adminUploadFileInput?.files?.[0]
                    });

                    adminUploadForm.reset();
                    updateUploadFileMeta();
                    setUploadStatus('Upload thành công.', 'success');
                    uploadPlaceholderModal?.classList.remove('active');
                    await fetchSongs();
                    showToast('Upload thành công.', 'success');
                } catch (error) {
                    console.error('[LocalSound] Cloud upload failed:', error);
                    setUploadStatus(`Upload thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'error');
                } finally {
                    if (adminUploadSubmit) adminUploadSubmit.disabled = false;
                }
            });
        }

        // Mobile Bottom Tab Listeners
        const mobileTabForYou = document.getElementById('mobile-tab-for-you');
        const mobileTabLibrary = document.getElementById('mobile-tab-library');
        if (mobileTabForYou) mobileTabForYou.addEventListener('click', () => setMobileTab('for-you'));
        if (mobileTabLibrary) mobileTabLibrary.addEventListener('click', () => setMobileTab('library'));

        // Mobile Media Session API Integration for Background & Lockscreen Playback
        if ('mediaSession' in navigator) {
            try {
                navigator.mediaSession.setActionHandler('play', () => {
                    if (!isPlaying) togglePlayPause();
                });
                navigator.mediaSession.setActionHandler('pause', () => {
                    if (isPlaying) togglePlayPause();
                });
                navigator.mediaSession.setActionHandler('previoustrack', () => {
                    playPrevTrack();
                });
                navigator.mediaSession.setActionHandler('nexttrack', () => {
                    playNextTrack();
                });
                navigator.mediaSession.setActionHandler('seekto', (details) => {
                    if (details.seekTime !== undefined && audio && !isNaN(audio.duration)) {
                        audio.currentTime = details.seekTime;
                    }
                });
            } catch (err) {
                console.warn('Lỗi đăng ký MediaSession Action Handler:', err);
            }
        }

        // Mobile Mini Player Handlers
        const miniPlayerInfo = document.getElementById('mini-player-info');
        const miniPlayBtn = document.getElementById('mini-play-btn');
        if (miniPlayerInfo) miniPlayerInfo.addEventListener('click', () => setMobileTab('for-you'));
        if (miniPlayBtn) miniPlayBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlayPause(); });

        // Helper functions for Favorite Single Click & Press-and-Hold
        function handleFavoriteSingleClick() {
            const song = getCurrentPlayingSong();
            if (!song) {
                showToast('Vui lòng chọn 1 bài hát để phát!', 'warning');
                return;
            }
            if (!isAdmin) {
                showToast('Chỉ Admin mới được chỉnh folder bài hát.', 'warning');
                return;
            }

            const cats = getSongCategoriesForUI(song);
            const hasAnyCategory = cats.length > 0;

            if (!hasAnyCategory) {
                void changeSongCategory(song, 'trghy', false)
                    .then(() => {
                        showToast(`<span class="icon-cat icon-trghy" style="margin-right: 4px;"></span> Đã thêm bài "${song.title}" vào danh sách`, 'success');
                        updateHeartUI();
                    })
                    .catch(error => {
                        console.error('[LocalSound] Cloud folder update failed:', error);
                        showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                    });
            } else {
                const catCleanMap = { nhacdo: 'Nhạc Đỏ', sleep: 'Đi Ngủ', cooking: 'Nấu Ăn', karaoke: 'Karaoke', trghy: 'trghy', tghy: 'trghy', xxx: 'trghy' };
                const priorityKeys = ['nhacdo', 'sleep', 'cooking', 'karaoke', 'trghy', 'tghy', 'xxx'];
                let activeCatKey = null;
                for (let key of priorityKeys) {
                    if (cats.includes(key)) {
                        activeCatKey = key;
                        break;
                    }
                }
                const catCleanName = catCleanMap[activeCatKey] || 'danh sách';

                showConfirmModal({
                    title: '⚠️ Xác nhận bỏ khỏi danh sách',
                    message: `Bạn có thật sự muốn bỏ bài hát "${song.title}" khỏi danh sách ${catCleanName} không?`,
                    confirmText: 'Đồng ý bỏ',
                    isDanger: true,
                    onConfirm: () => {
                        void changeSongCategory(song, activeCatKey, true)
                            .then(() => {
                                showToast(`Đã bỏ lưu bài hát "${song.title}"`, 'info');
                                updateHeartUI();
                            })
                            .catch(error => {
                                console.error('[LocalSound] Cloud folder update failed:', error);
                                showToast(`Cập nhật folder thất bại: ${error?.message || 'Không rõ nguyên nhân.'}`, 'warning');
                            });
                    }
                });
            }
        }

        function handleFavoriteLongPress() {
            const playerMoreModal = document.getElementById('player-more-modal');
            if (playerMoreModal) playerMoreModal.classList.remove('active');
            openCategoryPickerModal();
        }

        function setupFavoritePressHandler(btnElement) {
            if (!btnElement) return;
            let pressTimer = null;
            let isLongPress = false;
            let lastTouchTime = 0;

            const startPress = (e) => {
                if (e && e.type === 'mousedown' && Date.now() - lastTouchTime < 600) {
                    return;
                }
                if (e && e.type === 'touchstart') {
                    lastTouchTime = Date.now();
                }
                isLongPress = false;
                pressTimer = setTimeout(() => {
                    isLongPress = true;
                    handleFavoriteLongPress();
                }, 750); // 750ms press & hold
            };

            const cancelPress = () => {
                if (pressTimer) clearTimeout(pressTimer);
            };

            const endPress = (e) => {
                if (e && e.type === 'mouseup' && Date.now() - lastTouchTime < 600) {
                    return;
                }
                cancelPress();
                if (!isLongPress) {
                    handleFavoriteSingleClick();
                }
            };

            btnElement.addEventListener('mousedown', startPress);
            btnElement.addEventListener('mouseup', endPress);
            btnElement.addEventListener('mouseleave', cancelPress);

            btnElement.addEventListener('touchstart', startPress, { passive: true });
            btnElement.addEventListener('touchend', (e) => {
                endPress(e);
                if (isLongPress && e.cancelable) e.preventDefault();
            });
            btnElement.addEventListener('touchcancel', cancelPress);
        }

        // Heart Favorite Button Click & Long Press Handler
        const btnHeartFav = document.getElementById('btn-heart-fav');
        if (btnHeartFav) setupFavoritePressHandler(btnHeartFav);

        // 3-Dots Player Options Menu
        const btnPlayerMore = document.getElementById('btn-player-more');
        const playerMoreModal = document.getElementById('player-more-modal');
        const closePlayerMore = document.getElementById('close-player-more');

        const pmFavBtn = document.getElementById('pm-fav-btn');
        const pmModeBtn = document.getElementById('pm-mode-btn');
        const pmTimerBtn = document.getElementById('pm-timer-btn');
        const pmEqBtn = document.getElementById('pm-eq-btn');
        const pmModeLabel = document.getElementById('pm-mode-label');

        if (pmFavBtn) setupFavoritePressHandler(pmFavBtn);

        if (btnPlayerMore && playerMoreModal) {
            btnPlayerMore.addEventListener('click', () => {
                if (pmModeLabel && modeLabel) pmModeLabel.textContent = modeLabel.textContent;
                updateHeartUI();
                playerMoreModal.classList.add('active');
            });

            if (closePlayerMore) closePlayerMore.onclick = () => playerMoreModal.classList.remove('active');

            if (pmModeBtn) {
                pmModeBtn.addEventListener('click', () => {
                    cycleLoopMode();
                    if (pmModeLabel && modeLabel) pmModeLabel.textContent = modeLabel.textContent;
                });
            }

            if (pmTimerBtn) {
                pmTimerBtn.addEventListener('click', () => {
                    playerMoreModal.classList.remove('active');
                    const timerModal = document.getElementById('timer-modal');
                    if (timerModal) timerModal.classList.add('active');
                });
            }

            if (pmEqBtn) {
                pmEqBtn.addEventListener('click', () => {
                    playerMoreModal.classList.remove('active');
                    const eqModal = document.getElementById('eq-modal');
                    if (eqModal) eqModal.classList.add('active');
                });
            }
        }

        // Restore Mobile Tab View from saved state (remembers tab after F5 refresh)
        setMobileTab(mobileTab);

        // Brand / Logo Home Button Click
        const brandHomeBtn = document.getElementById('brand-home-btn');
        if (brandHomeBtn) {
            brandHomeBtn.addEventListener('click', () => {
                const allTabBtn = document.querySelector('.nav-item[data-tab="all"]');
                if (allTabBtn) {
                    allTabBtn.click();
                } else {
                    currentTab = 'all';
                    filterAndRenderSongs();
                }
            });
        }

        // Navigation Tabs
        document.querySelectorAll('.nav-item').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                currentTab = btn.dataset.tab;
                filterAndRenderSongs();
            });
        });

        // Search Autocomplete Real-time Input with Live Dropdown Overlay
        function escapeRegex(string) {
            return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        function renderSearchResultsDropdown() {
            const dropdown = document.getElementById('search-results-dropdown');
            if (!dropdown) return;

            // Only run live search dropdown on Mobile view (width <= 768px)
            if (window.innerWidth > 768) {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
                return;
            }

            const q = searchQuery.trim();
            if (q === '') {
                dropdown.classList.add('hidden');
                dropdown.innerHTML = '';
                return;
            }

            const rawQ = q.toLowerCase();
            const normQ = removeAccents(rawQ);

            const matches = allSongs.filter(s => {
                if (!s || !s.title) return false;
                const titleLower = s.title.toLowerCase();
                const titleNorm = removeAccents(s.title);
                const folderNorm = removeAccents(s.folder || '');
                return titleLower.includes(rawQ) || titleNorm.includes(normQ) || folderNorm.includes(normQ);
            });

            if (matches.length === 0) {
                dropdown.innerHTML = `<div class="search-no-results">Không tìm thấy bài hát nào phù hợp với "${escapeHtml(q)}"</div>`;
            } else {
                dropdown.innerHTML = '';
                matches.slice(0, 25).forEach(song => {
                    const item = document.createElement('div');
                    item.className = 'search-result-item';

                    let displayTitle = escapeHtml(song.title);
                    try {
                        const regex = new RegExp(`(${escapeRegex(q)})`, 'gi');
                        displayTitle = displayTitle.replace(regex, '<span class="highlight-text">$1</span>');
                    } catch (err) { }

                    item.innerHTML = `
                        <span class="search-song-icon">🎵</span>
                        <div class="search-song-info">
                            <span class="search-song-title">${displayTitle}</span>
                            <span class="search-song-folder">${escapeHtml(song.folder || 'Tất cả')}</span>
                        </div>
                    `;

                    let touchStartY = 0;
                    let touchStartX = 0;
                    let isDragging = false;

                    item.addEventListener('touchstart', (e) => {
                        if (e.touches && e.touches[0]) {
                            touchStartY = e.touches[0].clientY;
                            touchStartX = e.touches[0].clientX;
                            isDragging = false;
                        }
                    }, { passive: true });

                    item.addEventListener('touchmove', (e) => {
                        if (e.touches && e.touches[0]) {
                            const moveY = Math.abs(e.touches[0].clientY - touchStartY);
                            const moveX = Math.abs(e.touches[0].clientX - touchStartX);
                            if (moveY > 8 || moveX > 8) {
                                isDragging = true;
                            }
                        }
                    }, { passive: true });

                    const triggerPlay = (e) => {
                        if (isDragging) return;

                        // 1. Clear search input and search query state first
                        searchQuery = '';
                        if (searchInput) {
                            searchInput.value = '';
                            searchInput.blur();
                        }
                        const clearBtn = document.getElementById('clear-search');
                        if (clearBtn) clearBtn.classList.add('hidden');
                        dropdown.classList.add('hidden');
                        dropdown.innerHTML = '';

                        // 2. Populate currentPlaylist with all songs to ensure index accuracy
                        currentPlaylist = [...allSongs];
                        const targetIdx = currentPlaylist.findIndex(s => s && s.id === song.id);

                        if (targetIdx !== -1) {
                            playTrack(targetIdx);
                        } else {
                            currentPlayingSong = song;
                        }

                        // 3. Re-sync view and UI
                        filterAndRenderSongs();
                        updatePlayerUI();
                        updateMiniPlayerUI();
                        showToast(`🎵 Đang phát: ${song.title}`, 'success');
                    };

                    item.addEventListener('touchend', (e) => {
                        if (!isDragging) {
                            triggerPlay(e);
                        }
                    });

                    item.addEventListener('click', (e) => {
                        triggerPlay(e);
                    });

                    dropdown.appendChild(item);
                });
            }

            dropdown.classList.remove('hidden');
        }

        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value;
                if (clearSearchBtn) clearSearchBtn.classList.toggle('hidden', searchQuery === '');
                filterAndRenderSongs();
                renderSearchResultsDropdown();
            });

            searchInput.addEventListener('focus', () => {
                if (searchQuery.trim() !== '') {
                    renderSearchResultsDropdown();
                }
            });
        }

        if (clearSearchBtn) {
            clearSearchBtn.addEventListener('click', () => {
                if (searchInput) searchInput.value = '';
                searchQuery = '';
                clearSearchBtn.classList.add('hidden');
                filterAndRenderSongs();
                renderSearchResultsDropdown();
            });
        }

        document.addEventListener('pointerdown', (e) => {
            const searchBox = document.querySelector('.search-box');
            const dropdown = document.getElementById('search-results-dropdown');
            if (dropdown && searchBox && !searchBox.contains(e.target)) {
                dropdown.classList.add('hidden');
            }
        });

        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                sortOption = e.target.value;
                filterAndRenderSongs();
            });
        }

        // Power Saver Listeners
        if (powerSaverBtn) {
            powerSaverBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePowerSaverMode(undefined, false, true);
            });
        }

        const exitPowerSaverBtn = document.getElementById('exit-power-saver-btn');
        if (exitPowerSaverBtn) {
            exitPowerSaverBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                togglePowerSaverMode(false, false, true);
            });
        }

        const psPlayBtn = document.getElementById('ps-play-btn');
        const psPrevBtn = document.getElementById('ps-prev-btn');
        const psNextBtn = document.getElementById('ps-next-btn');

        if (psPlayBtn) psPlayBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlayPause(); });
        if (psPrevBtn) psPrevBtn.addEventListener('click', (e) => { e.stopPropagation(); playPrevTrack(); });
        if (psNextBtn) psNextBtn.addEventListener('click', (e) => { e.stopPropagation(); playNextTrack(); });

        // Modals
        const eqToggleBtn = document.getElementById('eq-toggle-btn');
        const closeEqBtn = document.getElementById('close-eq');
        if (eqToggleBtn && eqModal) eqToggleBtn.addEventListener('click', () => eqModal.classList.add('active'));
        if (closeEqBtn && eqModal) closeEqBtn.addEventListener('click', () => eqModal.classList.remove('active'));

        const timerToggleBtn = document.getElementById('timer-toggle-btn');
        const closeTimerBtn = document.getElementById('close-timer');
        if (timerToggleBtn && timerModal) timerToggleBtn.addEventListener('click', () => timerModal.classList.add('active'));
        if (closeTimerBtn && timerModal) closeTimerBtn.addEventListener('click', () => timerModal.classList.remove('active'));

        const shortcutHelpBtn = document.getElementById('shortcut-help-btn');
        const closeShortcutBtn = document.getElementById('close-shortcut');
        if (shortcutHelpBtn && shortcutModal) shortcutHelpBtn.addEventListener('click', () => shortcutModal.classList.add('active'));
        if (closeShortcutBtn && shortcutModal) closeShortcutBtn.addEventListener('click', () => shortcutModal.classList.remove('active'));

        [eqModal, timerModal, shortcutModal].forEach(modal => {
            if (modal) {
                modal.addEventListener('click', (e) => {
                    if (e.target === modal) modal.classList.remove('active');
                });
            }
        });

        // Equalizer Sliders
        document.querySelectorAll('.eq-slider').forEach(slider => {
            slider.addEventListener('input', (e) => {
                const bandIndex = parseInt(e.target.dataset.band);
                const val = parseFloat(e.target.value);
                if (eqBands[bandIndex]) {
                    eqBands[bandIndex].gain.value = val;
                }
                if (e.target.nextElementSibling) {
                    e.target.nextElementSibling.textContent = `${val > 0 ? '+' : ''}${val}dB`;
                }
            });
        });

        // Equalizer Presets
        document.querySelectorAll('.preset-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                applyEQPreset(btn.dataset.preset);
            });
        });

        // Sleep Timer Presets & Custom Input
        document.querySelectorAll('.timer-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const minutes = parseInt(btn.dataset.time);
                setSleepTimer(minutes);
                if (timerModal) timerModal.classList.remove('active');
            });
        });

        const customTimerSubmitBtn = document.getElementById('custom-timer-submit');
        if (customTimerSubmitBtn) {
            customTimerSubmitBtn.addEventListener('click', () => {
                const timerInput = document.getElementById('custom-timer-input');
                if (timerInput) {
                    const inputVal = parseInt(timerInput.value);
                    if (!isNaN(inputVal) && inputVal > 0) {
                        setSleepTimer(inputVal);
                        if (timerModal) timerModal.classList.remove('active');
                    }
                }
            });
        }

        // Close 3-dots dropdown menus when clicking outside
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.song-actions-wrapper')) {
                document.querySelectorAll('.song-dropdown-menu').forEach(menu => menu.classList.add('hidden'));
            }
        });

        // Keyboard Shortcuts
        document.addEventListener('keydown', handleShortcuts);
    }

    function applyEQPreset(preset) {
        const presets = {
            flat: [0, 0, 0, 0, 0],
            bass: [7, 4, 0, -1, -2],
            pop: [-1, 2, 4, 3, -1],
            rock: [5, 2, -1, 3, 5],
            vocal: [-3, 0, 4, 5, 2]
        };
        const values = presets[preset] || presets.flat;
        document.querySelectorAll('.eq-slider').forEach((slider, idx) => {
            slider.value = values[idx];
            if (eqBands[idx]) eqBands[idx].gain.value = values[idx];
            if (slider.nextElementSibling) {
                slider.nextElementSibling.textContent = `${values[idx] > 0 ? '+' : ''}${values[idx]}dB`;
            }
        });
    }

    // --- Sleep Timer Countdown Logic ---
    function setSleepTimer(minutes) {
        if (sleepTimerInterval) clearInterval(sleepTimerInterval);

        if (minutes === 0) {
            if (timerBadgeText) timerBadgeText.classList.add('hidden');
            return;
        }

        sleepTimerEndTime = Date.now() + minutes * 60 * 1000;
        if (timerBadgeText) timerBadgeText.classList.remove('hidden');

        updateTimerCountdown();
        sleepTimerInterval = setInterval(updateTimerCountdown, 1000);
    }

    function updateTimerCountdown() {
        const remainingMs = sleepTimerEndTime - Date.now();
        if (remainingMs <= 0) {
            clearInterval(sleepTimerInterval);
            audio.pause();
            isPlaying = false;
            updatePlayerUI();
            if (timerBadgeText) timerBadgeText.classList.add('hidden');
        } else {
            const totalSecs = Math.ceil(remainingMs / 1000);
            const m = Math.floor(totalSecs / 60);
            const s = totalSecs % 60;
            if (timerBadgeText) timerBadgeText.textContent = `${m}:${s.toString().padStart(2, '0')}`;
        }
    }

    function handleShortcuts(e) {
        if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

        if (e.code === 'Space') {
            e.preventDefault();
            togglePlayPause();
        } else if (e.code === 'ArrowLeft') {
            e.preventDefault();
            audio.currentTime = Math.max(0, audio.currentTime - 5);
        } else if (e.code === 'ArrowRight') {
            e.preventDefault();
            audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
        } else if (e.code === 'ArrowUp') {
            e.preventDefault();
            audio.volume = Math.min(1, audio.volume + 0.1);
            if (volumeSlider) volumeSlider.value = audio.volume;
            if (volumeFill) volumeFill.style.width = `${audio.volume * 100}%`;
            updateVolumeIcons();
        } else if (e.code === 'ArrowDown') {
            e.preventDefault();
            audio.volume = Math.max(0, audio.volume - 0.1);
            if (volumeSlider) volumeSlider.value = audio.volume;
            if (volumeFill) volumeFill.style.width = `${audio.volume * 100}%`;
            updateVolumeIcons();
        } else if (e.key.toLowerCase() === 'n') {
            playNextTrack();
        } else if (e.key.toLowerCase() === 'p') {
            playPrevTrack();
        } else if (e.key.toLowerCase() === 'm') {
            if (muteBtn) muteBtn.click();
        } else if (e.key === '/') {
            e.preventDefault();
            if (searchInput) searchInput.focus();
        }
    }

    // --- Audio Spectrum Visualizer ---
    function drawVisualizer() {
        if (!analyserNode || !canvasCtx || !canvas) return;
        requestAnimationFrame(drawVisualizer);

        if (isPowerSaverON) return;

        const bufferLength = analyserNode.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        analyserNode.getByteFrequencyData(dataArray);

        const width = canvas.width;
        const height = canvas.height;

        canvasCtx.clearRect(0, 0, width, height);

        const barWidth = (width / bufferLength) * 2.2;
        let barHeight;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
            barHeight = (dataArray[i] / 255) * height * 0.8;

            const gradient = canvasCtx.createLinearGradient(0, height, 0, height - barHeight);
            gradient.addColorStop(0, 'rgba(0, 245, 160, 0.3)');
            gradient.addColorStop(0.25, 'rgba(0, 217, 245, 0.6)');
            gradient.addColorStop(0.5, 'rgba(134, 168, 231, 0.8)');
            gradient.addColorStop(0.75, 'rgba(204, 134, 209, 0.9)');
            gradient.addColorStop(1, 'rgba(220, 255, 189, 0.95)');

            canvasCtx.fillStyle = gradient;
            canvasCtx.fillRect(x, height - barHeight, barWidth, barHeight);

            x += barWidth + 3;
        }
    }

    // --- Helpers ---
    function formatTime(seconds) {
        if (isNaN(seconds)) return '00:00';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }

    function formatFileSize(bytes) {
        if (!bytes) return '0 MB';
        const mb = bytes / (1024 * 1024);
        return `${mb.toFixed(1)} MB`;
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    // --- Notes & Notepad Logic ---
    let noteDebounceTimer = null;

    function initNotesLogic() {
        const editor = document.getElementById('note-text-editor');
        const saveStatus = document.getElementById('note-save-status');
        const copyBtn = document.getElementById('btn-copy-notes');
        const clearBtn = document.getElementById('btn-clear-notes');

        const checklistInput = document.getElementById('checklist-input');
        const addChecklistBtn = document.getElementById('btn-add-checklist');

        if (editor) {
            editor.addEventListener('input', () => {
                noteText = editor.value;
                if (saveStatus) {
                    saveStatus.textContent = '⏳ Đang lưu...';
                    saveStatus.classList.remove('saved');
                }
                clearTimeout(noteDebounceTimer);
                noteDebounceTimer = setTimeout(() => {
            saveUserData();
                    if (saveStatus) {
                        saveStatus.textContent = '✓ Đã lưu tự động';
                        saveStatus.classList.add('saved');
                    }
                }, 800);
            });
        }

        if (copyBtn) {
            copyBtn.addEventListener('click', () => {
                if (!Array.isArray(noteList) || noteList.length === 0) {
                    showToast('Danh sách trống, không có nội dung để sao chép!', 'warning');
                    return;
                }
                const formattedList = noteList.map((item, idx) => `${idx + 1}. [${item.completed ? 'x' : ' '}] ${item.text}`).join('\n');
                navigator.clipboard.writeText(formattedList).then(() => {
                    showToast('📋 Đã sao chép danh sách bài hát vào khay nhớ tạm!', 'success');
                }).catch(() => {
                    showToast('📋 Đã sao chép danh sách bài hát!', 'success');
                });
            });
        }

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                if (!Array.isArray(noteList) || noteList.length === 0) return;
                showConfirmModal({
                    title: 'Xoá tất cả bài hát',
                    message: 'Hãy đảm bảo bài hát đã được tải...',
                    confirmText: 'Xoá tất cả',
                    isDanger: true,
                    onConfirm: () => {
                        noteList = [];
                        renderChecklist();
            saveUserData();
                        showToast('Đã xoá toàn bộ danh sách bài hát', 'info');
                    }
                });
            });
        }

        if (checklistInput && addChecklistBtn) {
            const addChecklistItem = () => {
                const text = checklistInput.value.trim();
                if (!text) return;
                if (!Array.isArray(noteList)) noteList = [];
                noteList.unshift({
                    id: Date.now(),
                    text: text,
                    completed: false
                });
                checklistInput.value = '';
                renderChecklist();
            saveUserData();
                showToast(`Đã thêm "${text}" vào danh sách cần tải`, 'success');
            };

            addChecklistBtn.addEventListener('click', addChecklistItem);
            checklistInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    addChecklistItem();
                }
            });
        }

        renderChecklist();
    }

    function renderChecklist() {
        const container = document.getElementById('checklist-items-container');
        const countEl = document.getElementById('checklist-count');
        if (!container) return;

        if (!Array.isArray(noteList)) noteList = [];

        if (countEl) {
            const completedCount = noteList.filter(item => item.completed).length;
            countEl.textContent = `${completedCount}/${noteList.length} hoàn thành`;
        }

        if (noteList.length === 0) {
            container.innerHTML = `<div class="loading-spinner" style="padding:20px; font-size:0.85rem;">Chưa có bài hát nào trong danh sách</div>`;
            return;
        }

        container.innerHTML = '';
        noteList.forEach((item, index) => {
            const itemDiv = document.createElement('div');
            itemDiv.className = `checklist-item ${item.completed ? 'completed' : ''}`;

            itemDiv.innerHTML = `
                <input type="checkbox" ${item.completed ? 'checked' : ''} id="chk-${item.id}">
                <span class="checklist-text">${escapeHtml(item.text)}</span>
                <button class="btn-del-checklist" title="Xoá mục này">🗑️</button>
            `;

            const checkbox = itemDiv.querySelector('input[type="checkbox"]');
            const delBtn = itemDiv.querySelector('.btn-del-checklist');

            checkbox.addEventListener('change', () => {
                item.completed = checkbox.checked;
                renderChecklist();
            saveUserData();
            });

            delBtn.addEventListener('click', () => {
                showConfirmModal({
                    title: '⚠️ Xác nhận xoá mục',
                    message: `Bạn có chắc chắn muốn xoá "${item.text}" khỏi danh sách ghi chú không?`,
                    confirmText: 'Xoá mục',
                    isDanger: true,
                    onConfirm: () => {
                        noteList.splice(index, 1);
                        renderChecklist();
            saveUserData();
                        showToast('Đã xoá mục khỏi danh sách', 'info');
                    }
                });
            });

            container.appendChild(itemDiv);
        });
    }
});
