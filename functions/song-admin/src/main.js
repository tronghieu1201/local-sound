import { Client, Query, Storage, TablesDB } from 'node-appwrite';

const REQUIRED_CONFIG_KEYS = [
    'LOCAL_SOUND_DATABASE_ID',
    'LOCAL_SOUND_TABLE_ID',
    'LOCAL_SOUND_BUCKET_ID',
    'LOCAL_SOUND_ADMIN_USER_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID'
];
const PAGE_SIZE = 100;

function getHeader(headers, name) {
    if (!headers || typeof headers !== 'object') return '';

    const lowerName = name.toLowerCase();
    const headerKey = Object.keys(headers).find((key) => key.toLowerCase() === lowerName);
    return headerKey ? String(headers[headerKey] || '').trim() : '';
}

function parseRequestBody(req) {
    if (req?.bodyJson && typeof req.bodyJson === 'object') {
        return req.bodyJson;
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
        if (value !== undefined && value !== null && String(value).trim()) {
            return String(value).trim();
        }
    }

    return '';
}

function getConfig() {
    const config = Object.fromEntries(REQUIRED_CONFIG_KEYS.map((key) => [key, process.env[key]?.trim() || '']));
    const missingKeys = REQUIRED_CONFIG_KEYS.filter((key) => !config[key]);
    const rawQuotaMb = process.env.LOCAL_SOUND_STORAGE_QUOTA_MB?.trim() || '';
    const parsedQuotaMb = rawQuotaMb ? Number(rawQuotaMb) : null;
    const quotaBytes = Number.isFinite(parsedQuotaMb) && parsedQuotaMb > 0
        ? Math.floor(parsedQuotaMb * 1024 * 1024)
        : null;

    return {
        config,
        missingKeys,
        quotaBytes,
        invalidQuota: Boolean(rawQuotaMb) && quotaBytes === null
    };
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
        offset += page.length;

        if (page.length === 0 || page.length < PAGE_SIZE) break;
        if (Number.isFinite(response?.total) && files.length >= response.total) break;
    }

    return files;
}

async function listAllRows(tablesDB, databaseId, tableId) {
    const rows = [];
    let offset = 0;

    while (true) {
        const response = await tablesDB.listRows({
            databaseId,
            tableId,
            queries: [Query.limit(PAGE_SIZE), Query.offset(offset)]
        });
        const page = Array.isArray(response?.rows) ? response.rows : [];
        rows.push(...page);
        offset += page.length;

        if (page.length === 0 || page.length < PAGE_SIZE) break;
        if (Number.isFinite(response?.total) && rows.length >= response.total) break;
    }

    return rows;
}

async function getStats(storage, tablesDB, config, quotaBytes) {
    const [files, rows] = await Promise.all([
        listAllFiles(storage, config.LOCAL_SOUND_BUCKET_ID),
        listAllRows(tablesDB, config.LOCAL_SOUND_DATABASE_ID, config.LOCAL_SOUND_TABLE_ID)
    ]);

    const usedBytes = files.reduce((total, file) => {
        const fileSize = Number(file?.sizeOriginal ?? file?.size ?? 0);
        return total + (Number.isFinite(fileSize) && fileSize > 0 ? fileSize : 0);
    }, 0);
    const remainingBytes = quotaBytes === null ? null : Math.max(quotaBytes - usedBytes, 0);
    const usagePercent = quotaBytes === null
        ? null
        : Math.round((usedBytes / quotaBytes) * 10000) / 100;

    return {
        success: true,
        storage: {
            usedBytes,
            fileCount: files.length
        },
        database: {
            songCount: rows.length
        },
        quotaBytes,
        remainingBytes,
        usagePercent
    };
}

export default async ({ req, res, log, error }) => {
    const method = String(req?.method || '').toUpperCase();

    if (method !== 'POST') {
        return res.json({
            success: false,
            error: 'Only POST requests are supported.'
        }, 405);
    }

    const adminUserId = getHeader(req?.headers, 'x-appwrite-user-id');
    const { config, missingKeys, quotaBytes, invalidQuota } = getConfig();

    if (!adminUserId || adminUserId !== config.LOCAL_SOUND_ADMIN_USER_ID) {
        return res.json({
            success: false,
            error: 'Forbidden.'
        }, 403);
    }

    if (missingKeys.length > 0) {
        error(`song-admin is missing required configuration: ${missingKeys.join(', ')}`);
        return res.json({
            success: false,
            error: 'Function is not configured.'
        }, 500);
    }

    if (invalidQuota) {
        log('LOCAL_SOUND_STORAGE_QUOTA_MB is invalid; dashboard will report quota as unconfigured.');
    }

    const dynamicKey = getHeader(req?.headers, 'x-appwrite-key');
    if (!dynamicKey) {
        error('song-admin request is missing the dynamic x-appwrite-key header.');
        return res.json({
            success: false,
            error: 'Missing Appwrite function key.'
        }, 500);
    }

    const payload = parseRequestBody(req);
    const requestedAction = String(payload.action || '').trim().toLowerCase();
    const rowId = String(payload.rowId || '').trim();
    // Keep the old { rowId } request format as an implicit delete action.
    const action = requestedAction || (rowId ? 'delete' : '');

    if (!['delete', 'stats', 'cleanup-upload'].includes(action)) {
        return res.json({
            success: false,
            error: 'action must be stats, delete, or cleanup-upload.'
        }, 400);
    }

    const client = new Client()
        .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(dynamicKey);

    const tablesDB = new TablesDB(client);
    const storage = new Storage(client);

    if (action === 'stats') {
        try {
            return res.json(await getStats(storage, tablesDB, config, quotaBytes));
        } catch (err) {
            error(`Failed to calculate song stats: ${err?.message || 'unknown error'}`);
            return res.json({
                success: false,
                error: 'Unable to calculate song stats.'
            }, 502);
        }
    }

    if (action === 'cleanup-upload') {
        const fileId = String(payload.fileId || '').trim();
        if (!fileId) {
            return res.json({
                success: false,
                error: 'fileId is required for cleanup-upload.'
            }, 400);
        }

        try {
            await storage.deleteFile({
                bucketId: config.LOCAL_SOUND_BUCKET_ID,
                fileId
            });
        } catch (err) {
            if (getErrorStatus(err) !== 404) {
                error(`Failed to cleanup uploaded storage file ${fileId}: ${err?.message || 'unknown error'}`);
                return res.json({
                    success: false,
                    error: 'Unable to cleanup uploaded song file.',
                    fileId
                }, 502);
            }

            log(`Storage file ${fileId} was already missing during upload cleanup.`);
        }

        return res.json({
            success: true,
            fileId
        });
    }

    if (!rowId) {
        return res.json({
            success: false,
            error: 'rowId is required for delete.'
        }, 400);
    }

    let row;
    try {
        row = await tablesDB.getRow({
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_TABLE_ID,
            rowId
        });
    } catch (err) {
        if (getErrorStatus(err) === 404) {
            return res.json({
                success: false,
                error: 'Song row not found.',
                rowId
            }, 404);
        }

        error(`Failed to read song row ${rowId}: ${err?.message || 'unknown error'}`);
        return res.json({
            success: false,
            error: 'Unable to read song row.'
        }, 502);
    }

    const fileId = getRowFileId(row);
    if (!fileId) {
        error(`Song row ${rowId} does not contain a fileId.`);
        return res.json({
            success: false,
            error: 'Song row does not contain a fileId.',
            rowId
        }, 422);
    }

    try {
        await storage.deleteFile({
            bucketId: config.LOCAL_SOUND_BUCKET_ID,
            fileId
        });
    } catch (err) {
        if (getErrorStatus(err) !== 404) {
            error(`Failed to delete storage file for row ${rowId}: ${err?.message || 'unknown error'}`);
            return res.json({
                success: false,
                error: 'Unable to delete song file.',
                rowId
            }, 502);
        }

        log(`Storage file ${fileId} was already missing; continuing with row deletion.`);
    }

    try {
        await tablesDB.deleteRow({
            databaseId: config.LOCAL_SOUND_DATABASE_ID,
            tableId: config.LOCAL_SOUND_TABLE_ID,
            rowId
        });
    } catch (err) {
        error(`Failed to delete song row ${rowId} after storage cleanup: ${err?.message || 'unknown error'}`);
        return res.json({
            success: false,
            error: 'Unable to delete song row.',
            rowId,
            fileId
        }, 502);
    }

    return res.json({
        success: true,
        rowId,
        fileId
    });
};
