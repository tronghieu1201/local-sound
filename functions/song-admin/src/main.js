import {
    Account,
    Client,
    ID,
    Permission,
    Query,
    Role,
    Storage,
    TablesDB,
    Teams
} from 'node-appwrite';

const BASE_CONFIG_KEYS = [
    'LOCAL_SOUND_DATABASE_ID',
    'LOCAL_SOUND_TABLE_ID',
    'LOCAL_SOUND_BUCKET_ID',
    'LOCAL_SOUND_ADMIN_USER_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID'
];
const REQUEST_CONFIG_KEYS = [
    'LOCAL_SOUND_REQUESTS_TABLE_ID',
    'LOCAL_SOUND_ADMIN_TEAM_ID'
];
const PAGE_SIZE = 100;
const REQUEST_MAX_LENGTH = 2000;
const PUBLIC_NOTE_COOLDOWN_MS = 10000;
const PUBLIC_NOTE_CORS_ORIGINS = new Set([
    'http://localhost:8000',
    'https://tronghieu1201.github.io'
]);
const NOTE_STATUSES = new Set(['new', 'seen', 'done', 'rejected']);
const recentPublicNotesByIp = new Map();
let lastPublicNotePruneAt = 0;

function getHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return '';

    const lowerName = name.toLowerCase();
    const headerKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
    return headerKey ? String(headers[headerKey] || '').trim() : '';
}

function getCorsHeaders(req) {
    const origin = getHeader(req?.headers, 'origin');
    const headers = {
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin'
    };
    if (PUBLIC_NOTE_CORS_ORIGINS.has(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function parseRequestBody(req) {
    try {
        const bodyJson = req?.bodyJson;
        if (
            bodyJson
            && typeof bodyJson === 'object'
            && Object.keys(bodyJson).length > 0
        ) {
            return bodyJson;
        }
    } catch {
        // Appwrite may throw while reading bodyJson when the request body is invalid JSON.
    }
    if (req?.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        return req.body;
    }

    const rawBody = typeof req?.bodyText === 'string'
        ? req.bodyText
        : typeof req?.body === 'string'
            ? req.body
            : '';
    if (!rawBody.trim()) return {};

    try {
        const parsed = JSON.parse(rawBody);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function getErrorStatus(err) {
    const status = Number(err?.code ?? err?.statusCode ?? err?.status);
    return Number.isInteger(status) ? status : 0;
}

function getResponseTotal(response) {
    const rawTotal = response?.total;
    if (rawTotal === undefined || rawTotal === null || String(rawTotal).trim() === '') return null;
    const total = Number(rawTotal);
    return Number.isFinite(total) && total >= 0 ? total : null;
}

function getRowFileId(row) {
    const keys = [
        'fileId',
        'fileID',
        'storageFileId',
        'storage_file_id',
        'file_id',
        'audioFileId',
        'audio_file_id'
    ];

    for (const key of keys) {
        const value = row?.[key];
        if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
    }
    return '';
}

function getConfig() {
    const keys = [...BASE_CONFIG_KEYS, ...REQUEST_CONFIG_KEYS];
    const config = Object.fromEntries(keys.map((key) => [key, process.env[key]?.trim() || '']));
    return {
        config,
        missingKeys: BASE_CONFIG_KEYS.filter((key) => !config[key]),
        missingRequestKeys: REQUEST_CONFIG_KEYS.filter((key) => !config[key])
    };
}

async function getAuthenticatedUser(req, config) {
    const jwt = getHeader(req?.headers, 'x-appwrite-user-jwt');
    if (!jwt) return null;

    try {
        const client = new Client()
            .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
            .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
            .setJWT(jwt);
        const account = await new Account(client).get();
        return account?.$id ? account : null;
    } catch {
        return null;
    }
}

async function listAllFiles(storage, bucketId) {
    const files = [];
    let offset = 0;

    while (true) {
        const response = await storage.listFiles({
            bucketId,
            queries: [Query.limit(PAGE_SIZE), Query.offset(offset)]
        });
        const page = Array.isArray(response?.files) ? response.files : [];
        files.push(...page);
        if (page.length === 0) break;

        offset += page.length;
        const total = getResponseTotal(response);
        if (total !== null && offset >= total) break;
        if (page.length < PAGE_SIZE && total === null) break;
    }

    return files;
}

async function listAllRows(tablesDB, databaseId, tableId) {
    const rows = [];
    let offset = 0;
    let reportedTotal = null;

    while (true) {
        const response = await tablesDB.listRows({
            databaseId,
            tableId,
            queries: [Query.limit(PAGE_SIZE), Query.offset(offset)]
        });
        const page = Array.isArray(response?.rows) ? response.rows : [];
        const total = getResponseTotal(response);
        if (total !== null) reportedTotal = total;

        rows.push(...page);
        if (page.length === 0) break;
        offset += page.length;
        if (total !== null && rows.length >= total) break;
        if (page.length < PAGE_SIZE && total === null) break;
    }

    return { rows, total: reportedTotal === null ? rows.length : reportedTotal };
}

async function getStorageSnapshot(storage, tablesDB, config, log) {
    const [{ rows, total: databaseSongCount }, storageFiles] = await Promise.all([
        listAllRows(tablesDB, config.LOCAL_SOUND_DATABASE_ID, config.LOCAL_SOUND_TABLE_ID),
        listAllFiles(storage, config.LOCAL_SOUND_BUCKET_ID)
    ]);

    const referencedFileIds = new Set(rows.map(getRowFileId).filter(Boolean));
    const orphanFiles = storageFiles.filter((file) => !referencedFileIds.has(String(file?.$id || '').trim()));
    const storageUsedBytes = storageFiles.reduce((total, file) => {
        const size = Number(file?.sizeOriginal ?? file?.sizeActual ?? 0);
        return total + (Number.isFinite(size) ? size : 0);
    }, 0);

    return {
        databaseSongCount,
        storageFileCount: storageFiles.length,
        orphanFiles,
        storageUsedBytes
    };
}

async function getStats(storage, tablesDB, config, log) {
    const snapshot = await getStorageSnapshot(storage, tablesDB, config, log);
    return {
        success: true,
        plan: 'Free',
        databaseSongCount: snapshot.databaseSongCount,
        storageFileCount: snapshot.storageFileCount,
        orphanFileCount: snapshot.orphanFiles.length,
        storageUsedBytes: snapshot.storageUsedBytes
    };
}

function getRequestData(row) {
    return {
        $id: String(row?.$id || ''),
        $createdAt: row?.$createdAt || null,
        $updatedAt: row?.$updatedAt || null,
        userId: String(row?.userId || ''),
        userName: String(row?.userName || ''),
        userEmail: String(row?.userEmail || ''),
        message: String(row?.message || ''),
        status: String(row?.status || 'new'),
        adminReply: String(row?.adminReply || '')
    };
}

function requestConfigError(res, missingKeys) {
    return res.json({
        success: false,
        error: `Request feature is not configured: ${missingKeys.join(', ')}.`
    }, 500);
}

async function isUserInAdminTeam(teams, teamId, userId, log) {
    if (!teamId) return false;

    try {
        const response = await teams.listMemberships({
            teamId,
            queries: [Query.equal('userId', [userId]), Query.limit(1)]
        });
        return Array.isArray(response?.memberships) && response.memberships.some((membership) => {
            const membershipUserId = String(membership?.userId || '').trim();
            const confirmed = membership?.confirm === true || Boolean(membership?.joined);
            return membershipUserId === userId && confirmed;
        });
    } catch (err) {
        log?.(`Unable to verify admin team membership for ${userId}: ${err?.message || 'unknown error'}`);
        return false;
    }
}

async function isAdminUser(teams, config, userId, log) {
    const configuredAdminUserId = process.env.LOCAL_SOUND_ADMIN_USER_ID || '';
    const configuredAdminTeamId = process.env.LOCAL_SOUND_ADMIN_TEAM_ID || '';
    const directAdmin = Boolean(userId)
        && Boolean(configuredAdminUserId)
        && userId === configuredAdminUserId;

    let teamAdmin = false;
    if (configuredAdminTeamId && userId) {
        teamAdmin = await isUserInAdminTeam(
            teams,
            configuredAdminTeamId,
            userId,
            log
        );
    }

    const isAdmin = directAdmin || teamAdmin;

    return isAdmin;
}

function reservePublicNoteSlot(req) {
    // Instance memory only slows bursts; durable limits require shared storage.
    const clientIp = getHeader(req?.headers, 'x-appwrite-client-ip');
    if (!clientIp) return { allowed: true, release: () => {} };

    const now = Date.now();
    if (now - lastPublicNotePruneAt >= PUBLIC_NOTE_COOLDOWN_MS) {
        for (const [ip, submittedAt] of recentPublicNotesByIp) {
            if (now - submittedAt >= PUBLIC_NOTE_COOLDOWN_MS) recentPublicNotesByIp.delete(ip);
        }
        lastPublicNotePruneAt = now;
    }
    const previous = recentPublicNotesByIp.get(clientIp);
    if (previous !== undefined && now - previous < PUBLIC_NOTE_COOLDOWN_MS) {
        return {
            allowed: false,
            retryAfterSeconds: Math.ceil((PUBLIC_NOTE_COOLDOWN_MS - (now - previous)) / 1000)
        };
    }
    recentPublicNotesByIp.set(clientIp, now);
    return {
        allowed: true,
        release: () => {
            if (recentPublicNotesByIp.get(clientIp) === now) recentPublicNotesByIp.delete(clientIp);
        }
    };
}

async function submitNote({ tablesDB, config, runtimeUserId, hasExecutionKey, payload, req, log, error }) {
    const message = typeof payload.message === 'string' ? payload.message.trim() : '';
    if (!message) {
        return { status: 400, body: { success: false, error: 'message is required.' } };
    }
    if (message.length > REQUEST_MAX_LENGTH) {
        return { status: 400, body: { success: false, error: `message must be at most ${REQUEST_MAX_LENGTH} characters.` } };
    }

    const reservation = reservePublicNoteSlot(req);
    if (!reservation.allowed) {
        return {
            status: 429,
            body: { success: false, error: `Vui lòng đợi ${reservation.retryAfterSeconds} giây trước khi gửi yêu cầu tiếp theo.` }
        };
    }

    try {
        const data = {
            userId: runtimeUserId || 'guest',
            userName: runtimeUserId ? '' : 'Khách',
            message,
            status: 'new',
            adminReply: ''
        };
        const userJwt = getHeader(req?.headers, 'x-appwrite-user-jwt');
        if (runtimeUserId && userJwt) {
            try {
                const sessionClient = new Client()
                    .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
                    .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
                    .setJWT(userJwt);
                const account = await new Account(sessionClient).get();
                if (account?.$id === runtimeUserId) {
                    data.userName = String(account.name || '').trim();
                    const email = String(account.email || '').trim();
                    if (email) data.userEmail = email;
                } else {
                    log(JSON.stringify({ tag: 'submit-note-identity-mismatch', runtimeUserId }));
                }
            } catch (err) {
                // Profile enrichment is optional and must never block submission.
                log(JSON.stringify({ tag: 'submit-note-profile-unavailable', code: err?.code ?? null }));
            }
        }

        log('PUBLIC_SUBMIT_V8_CREATE_START');
        log(JSON.stringify({
            tag: 'submit-note-create-start',
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
            hasExecutionKey,
            guest: !runtimeUserId
        }));
        let row;
        try {
            row = await tablesDB.createRow({
                databaseId: config.LOCAL_SOUND_DATABASE_ID,
                tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
                rowId: ID.unique(),
                data,
                // Only the admin team receives row permissions.
                permissions: [
                    Permission.read(Role.team(config.LOCAL_SOUND_ADMIN_TEAM_ID)),
                    Permission.update(Role.team(config.LOCAL_SOUND_ADMIN_TEAM_ID)),
                    Permission.delete(Role.team(config.LOCAL_SOUND_ADMIN_TEAM_ID))
                ]
            });
        } catch (err) {
            error(JSON.stringify({
                tag: 'PUBLIC_SUBMIT_V8_CREATE_ERROR',
                message: err?.message ?? String(err),
                code: err?.code ?? null,
                type: err?.type ?? null,
                databaseId: config.LOCAL_SOUND_DATABASE_ID,
                tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
                hasExecutionKey,
                guest: !runtimeUserId
            }));
            throw err;
        }

        log('PUBLIC_SUBMIT_V8_SUCCESS');
        log(JSON.stringify({
            tag: 'submit-note-success',
            requestId: row.$id,
            rowId: row.$id,
            guest: !runtimeUserId
        }));
        return {
            status: 200,
            body: {
                success: true,
                requestId: row.$id,
                request: {
                    id: row.$id,
                    message: row.message,
                    status: row.status,
                    createdAt: row.$createdAt
                }
            }
        };
    } catch (err) {
        reservation.release();
        throw err;
    }
}

async function handleSubmitNote({ req, res, body, corsHeaders, log, error }) {
    const runtimeUserId = getHeader(req?.headers, 'x-appwrite-user-id');
    log(JSON.stringify({
        tag: 'submit-note-auth',
        action: 'submit-note',
        runtimeUserId: runtimeUserId || null,
        hasUser: Boolean(runtimeUserId),
        guest: !runtimeUserId
    }));

    const { config } = getConfig();
    const submitConfigKeys = [
        'LOCAL_SOUND_DATABASE_ID',
        'LOCAL_SOUND_REQUESTS_TABLE_ID',
        'LOCAL_SOUND_ADMIN_TEAM_ID',
        'APPWRITE_FUNCTION_API_ENDPOINT',
        'APPWRITE_FUNCTION_PROJECT_ID'
    ];
    const missingSubmitKeys = submitConfigKeys.filter((key) => !config[key]);
    if (missingSubmitKeys.length > 0) {
        error(JSON.stringify({ tag: 'PUBLIC_SUBMIT_V8_ERROR', stage: 'configuration', missingKeys: missingSubmitKeys }));
        return res.json({
            success: false,
            error: `Request feature is not configured: ${missingSubmitKeys.join(', ')}.`
        }, 500, corsHeaders);
    }

    const executionKey = getHeader(req?.headers, 'x-appwrite-key');
    const dynamicKey = executionKey || process.env.APPWRITE_FUNCTION_API_KEY?.trim();
    if (!dynamicKey) {
        error(JSON.stringify({ tag: 'PUBLIC_SUBMIT_V8_ERROR', stage: 'api-key', hasExecutionKey: false }));
        return res.json({ success: false, error: 'Missing Appwrite function API key.' }, 500, corsHeaders);
    }
    log(JSON.stringify({
        tag: 'submit-note-api-key',
        source: executionKey ? 'execution-header' : 'function-environment'
    }));

    try {
        const client = new Client()
            .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
            .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
            .setKey(dynamicKey);
        const tablesDB = new TablesDB(client);
        const result = await submitNote({
            tablesDB, config, runtimeUserId, hasExecutionKey: Boolean(executionKey), payload: body, req, log, error
        });
        return res.json(result.body, result.status, corsHeaders);
    } catch (err) {
        error(JSON.stringify({
            tag: 'PUBLIC_SUBMIT_V8_ERROR',
            stage: 'submit-note',
            message: err?.message ?? String(err),
            code: err?.code ?? null,
            type: err?.type ?? null,
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
            hasExecutionKey: Boolean(executionKey),
            guest: !runtimeUserId
        }));
        return res.json({ success: false, error: 'Unable to submit song request.' }, 502, corsHeaders);
    }
}

export default async ({ req, res, log, error }) => {
    log('FUNCTION_DEBUG_V8');

    const method = String(req?.method || '').toUpperCase();
    const corsHeaders = getCorsHeaders(req);
    // A browser's JSON POST to the public Function Domain requires a preflight.
    // OPTIONS does not execute any action; admin POSTs still pass the auth guard below.
    if (method === 'OPTIONS') {
        log('PUBLIC_SUBMIT_V7_OPTIONS');
        return res.text('', 204, corsHeaders);
    }
    if (method !== 'POST') {
        return res.json({ success: false, error: 'Only POST requests are supported.' }, 405, corsHeaders);
    }

    const body = parseRequestBody(req);
    const payload = body;
    const requestedAction = String(body.action || '').trim().toLowerCase();
    const requestId = String(body.requestId || '').trim();
    const rowId = String(body.rowId || '').trim();
    const action = requestedAction === 'delete'
        ? 'delete-song'
        : requestedAction || (rowId ? 'delete-song' : '');

    log(JSON.stringify({
        tag: 'incoming-action',
        action,
        requestId: body?.requestId ?? null,
        bodyKeys: Object.keys(body || {})
    }));

    // The only public action must return before any authentication or admin guard.
    if (action === 'submit-note') {
        log('PUBLIC_SUBMIT_V8_ENTRY');
        return await handleSubmitNote({ req, res, body, corsHeaders, log, error });
    }

    if (!getHeader(req?.headers, 'x-appwrite-user-jwt')) {
        return res.json({ success: false, error: 'Authentication is required.' }, 401);
    }

    const { config, missingKeys, missingRequestKeys } = getConfig();
    if (missingKeys.length > 0) {
        error(`song-admin is missing required configuration: ${missingKeys.join(', ')}`);
        return res.json({ success: false, error: 'Function is not configured.' }, 500);
    }

    const authenticatedUser = await getAuthenticatedUser(req, config);
    if (!authenticatedUser) {
        return res.json({ success: false, error: 'Authentication is required.' }, 401);
    }
    const userId = authenticatedUser.$id;
    const headerUserId = getHeader(req?.headers, 'x-appwrite-user-id');
    if (headerUserId && headerUserId !== userId) {
        log(JSON.stringify({ tag: 'authenticated-user-id-mismatch' }));
    }

    const supportedActions = [
        'delete-song',
        'stats',
        'cleanup-upload',
        'cleanup-orphans',
        'list-notes',
        'update-note',
        'delete-note'
    ];

    if (!supportedActions.includes(action)) {
        log(JSON.stringify({
            tag: 'unsupported-action',
            action
        }));
        return res.json({ success: false, error: 'Unsupported action.' }, 400);
    }

    const dynamicKey = getHeader(req?.headers, 'x-appwrite-key')
        || process.env.APPWRITE_FUNCTION_API_KEY?.trim();
    if (!dynamicKey) {
        error('song-admin is missing the Appwrite function API key.');
        return res.json({ success: false, error: 'Missing Appwrite function API key.' }, 500);
    }

    const client = new Client()
        .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(dynamicKey);
    const tablesDB = new TablesDB(client);
    const storage = new Storage(client);
    const teams = new Teams(client);

    const noteAction = ['list-notes', 'update-note', 'delete-note'].includes(action);
    if (noteAction && missingRequestKeys.length > 0) {
        error(`song-admin note action is missing configuration: ${missingRequestKeys.join(', ')}`);
        return requestConfigError(res, missingRequestKeys);
    }

    if (action === 'delete-note') {
        try {
            const isAdmin = await isAdminUser(teams, config, userId, log);
            if (!isAdmin) return res.json({ success: false, error: 'Forbidden.' }, 403);
            if (!requestId) return res.json({ success: false, error: 'Missing requestId' }, 400);

            const databaseId = config.LOCAL_SOUND_DATABASE_ID;
            const tableId = config.LOCAL_SOUND_REQUESTS_TABLE_ID;
            log(JSON.stringify({ tag: 'delete-note-start', databaseId, tableId, requestId }));
            await tablesDB.deleteRow({ databaseId, tableId, rowId: requestId });
            log(JSON.stringify({ tag: 'delete-note-success', requestId }));
            return res.json({ success: true, requestId });
        } catch (err) {
            error(JSON.stringify({
                tag: 'delete-note-error',
                message: err?.message ?? String(err),
                code: err?.code ?? null,
                type: err?.type ?? null
            }));
            if (getErrorStatus(err) === 404) {
                return res.json({ success: false, error: 'Song request not found.', requestId }, 404);
            }
            return res.json({ success: false, error: err?.message || 'Failed to delete note', requestId }, 500);
        }
    }

    if (action === 'list-notes' || action === 'update-note') {
        const isAdmin = await isAdminUser(teams, config, userId, log);
        if (!isAdmin) return res.json({ success: false, error: 'Forbidden.' }, 403);

        if (action === 'list-notes') {
            try {
                const { rows } = await listAllRows(tablesDB, config.LOCAL_SOUND_DATABASE_ID, config.LOCAL_SOUND_REQUESTS_TABLE_ID);
                return res.json({ success: true, requests: rows.map(getRequestData) });
            } catch (err) {
                error(`Failed to list admin song requests: ${err?.message || 'unknown error'}`);
                return res.json({ success: false, error: 'Unable to load song requests.' }, 502);
            }
        }

        const requestId = String(payload.requestId || payload.rowId || '').trim();
        const status = String(payload.status || '').trim().toLowerCase();
        const adminReply = String(payload.adminReply ?? '').trim();
        if (!requestId || !NOTE_STATUSES.has(status)) {
            return res.json({
                success: false,
                error: 'requestId and a valid status (new, seen, done, rejected) are required.'
            }, 400);
        }
        if (adminReply.length > REQUEST_MAX_LENGTH) {
            return res.json({
                success: false,
                error: `adminReply must be at most ${REQUEST_MAX_LENGTH} characters.`
            }, 400);
        }

        try {
            const row = await tablesDB.updateRow({
                databaseId: config.LOCAL_SOUND_DATABASE_ID,
                tableId: config.LOCAL_SOUND_REQUESTS_TABLE_ID,
                rowId: requestId,
                data: { status, adminReply }
            });
            return res.json({ success: true, request: getRequestData(row) });
        } catch (err) {
            if (getErrorStatus(err) === 404) {
                return res.json({ success: false, error: 'Song request not found.', requestId }, 404);
            }
            error(`Failed to update song request ${requestId}: ${err?.message || 'unknown error'}`);
            return res.json({ success: false, error: 'Unable to update song request.' }, 502);
        }
    }

    // Existing song-management mutations remain restricted to the configured admin user.
    if (userId !== config.LOCAL_SOUND_ADMIN_USER_ID) {
        return res.json({ success: false, error: 'Forbidden.' }, 403);
    }

    if (action === 'stats') {
        try {
            const stats = await getStats(storage, tablesDB, config, log);
            return res.json(stats);
        } catch (err) {
            error(`Failed to calculate song stats: ${err?.message || 'unknown error'}`);
            return res.json({ success: false, error: 'Unable to calculate song stats.' }, 502);
        }
    }

    if (action === 'cleanup-upload') {
        const fileId = String(payload.fileId || '').trim();
        if (!fileId) return res.json({ success: false, error: 'fileId is required for cleanup-upload.' }, 400);

        try {
            await storage.deleteFile({ bucketId: config.LOCAL_SOUND_BUCKET_ID, fileId });
        } catch (err) {
            if (getErrorStatus(err) !== 404) {
                error(`Failed to cleanup uploaded storage file ${fileId}: ${err?.message || 'unknown error'}`);
                return res.json({ success: false, error: 'Unable to cleanup uploaded song file.', fileId }, 502);
            }
            log(`Storage file ${fileId} was already missing during upload cleanup.`);
        }
        return res.json({ success: true, fileId });
    }

    if (action === 'cleanup-orphans') {
        let snapshot;
        try {
            snapshot = await getStorageSnapshot(storage, tablesDB, config, log);
        } catch (err) {
            error(`Failed to find orphan files: ${err?.message || 'unknown error'}`);
            return res.json({ success: false, error: 'Unable to find orphan files.' }, 502);
        }

        const orphanLog = snapshot.orphanFiles.map((file) => ({
            $id: String(file?.$id || ''),
            name: String(file?.name || '')
        }));
        log(`[LocalSound] Orphan files before cleanup: ${JSON.stringify(orphanLog, null, 2)}`);

        const deletedFileIds = [];
        const failedFiles = [];
        for (const file of snapshot.orphanFiles) {
            const fileId = String(file?.$id || '').trim();
            if (!fileId) {
                error(`Cannot cleanup orphan Storage file without an $id: ${JSON.stringify(file)}`);
                failedFiles.push({ $id: '', name: String(file?.name || ''), error: 'Storage file is missing $id.' });
                continue;
            }

            try {
                await storage.deleteFile({ bucketId: config.LOCAL_SOUND_BUCKET_ID, fileId });
                deletedFileIds.push(fileId);
            } catch (err) {
                if (getErrorStatus(err) === 404) {
                    log(`Orphan storage file ${fileId} was already missing during cleanup.`);
                    deletedFileIds.push(fileId);
                    continue;
                }
                error(`Failed to delete orphan storage file ${fileId}: ${err?.message || 'unknown error'}`);
                failedFiles.push({ $id: fileId, name: String(file?.name || ''), error: err?.message || 'unknown error' });
            }
        }

        if (failedFiles.length > 0) {
            return res.json({
                success: false,
                error: 'Unable to cleanup all orphan files.',
                deletedFileIds,
                failedFiles
            }, 502);
        }
        return res.json({ success: true, deletedFileIds, orphanFileCount: snapshot.orphanFiles.length });
    }

    if (!rowId) return res.json({ success: false, error: 'rowId is required for delete-song.' }, 400);

    let row;
    try {
        row = await tablesDB.getRow({
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_TABLE_ID,
            rowId
        });
    } catch (err) {
        if (getErrorStatus(err) === 404) return res.json({ success: false, error: 'Song row not found.', rowId }, 404);
        error(`Failed to read song row ${rowId}: ${err?.message || 'unknown error'}`);
        return res.json({ success: false, error: 'Unable to read song row.' }, 502);
    }

    const fileId = getRowFileId(row);
    if (!fileId) log(`Song row ${rowId} does not contain a fileId; deleting the row without a Storage mutation.`);

    if (fileId) {
        try {
            await storage.deleteFile({ bucketId: config.LOCAL_SOUND_BUCKET_ID, fileId });
        } catch (err) {
            if (getErrorStatus(err) !== 404) {
                error(`Failed to delete storage file for row ${rowId}, file ${fileId}: ${err?.message || 'unknown error'}`);
                return res.json({
                    success: false,
                    error: 'Unable to delete song file from Storage; database row was not deleted.',
                    rowId,
                    fileId
                }, 502);
            }
            log(`Storage file ${fileId} was already missing; continuing with row deletion.`);
        }
    }

    try {
        await tablesDB.deleteRow({
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_TABLE_ID,
            rowId
        });
    } catch (err) {
        error(`Failed to delete song row ${rowId} after storage cleanup: ${err?.message || 'unknown error'}`);
        return res.json({ success: false, error: 'Unable to delete song row.', rowId, fileId }, 502);
    }

    return res.json({ success: true, rowId, fileId });
};
