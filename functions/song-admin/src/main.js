import { Client, Storage, TablesDB } from 'node-appwrite';

const CONFIG_KEYS = [
    'LOCAL_SOUND_DATABASE_ID',
    'LOCAL_SOUND_TABLE_ID',
    'LOCAL_SOUND_BUCKET_ID',
    'LOCAL_SOUND_ADMIN_USER_ID',
    'APPWRITE_FUNCTION_API_ENDPOINT',
    'APPWRITE_FUNCTION_PROJECT_ID'
];

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
    const config = Object.fromEntries(CONFIG_KEYS.map((key) => [key, process.env[key]?.trim() || '']));
    const missingKeys = CONFIG_KEYS.filter((key) => !config[key]);

    return { config, missingKeys };
}

export default async ({ req, res, log, error }) => {
    const method = String(req?.method || '').toUpperCase();

    if (method !== 'POST') {
        return res.json({
            success: false,
            error: 'Only POST requests are supported for delete-song.'
        }, 405);
    }

    const adminUserId = getHeader(req?.headers, 'x-appwrite-user-id');
    const { config, missingKeys } = getConfig();

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

    const dynamicKey = getHeader(req?.headers, 'x-appwrite-key');
    if (!dynamicKey) {
        error('song-admin request is missing the dynamic x-appwrite-key header.');
        return res.json({
            success: false,
            error: 'Missing Appwrite function key.'
        }, 500);
    }

    const payload = parseRequestBody(req);
    const rowId = String(payload.rowId || '').trim();
    if (!rowId) {
        return res.json({
            success: false,
            error: 'rowId is required.'
        }, 400);
    }

    const client = new Client()
        .setEndpoint(config.APPWRITE_FUNCTION_API_ENDPOINT)
        .setProject(config.APPWRITE_FUNCTION_PROJECT_ID)
        .setKey(dynamicKey);

    const tablesDB = new TablesDB(client);
    const storage = new Storage(client);

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
