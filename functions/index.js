
'use strict';

const admin = require('firebase-admin');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');

if (!admin.apps.length) {
  admin.initializeApp();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_RETENTION_DAYS = 30;

function safeKey(value) {
  return typeof value === 'string' &&
    value.length > 0 &&
    !/[.#$[\]/]/.test(value);
}

function expiryOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null;
  }

  const explicitExpiry = Number(entry.expiresAt);

  if (Number.isFinite(explicitExpiry) && explicitExpiry > 0) {
    return explicitExpiry;
  }

  // पुरानो Trash record मा expiresAt नभए पनि
  // deletedAt बाट ३० दिनको म्याद गणना गर्ने।
  const deletedAt = Number(entry.deletedAt || entry.deleted_at || 0);

  if (Number.isFinite(deletedAt) && deletedAt > 0) {
    return deletedAt + TRASH_RETENTION_DAYS * DAY_MS;
  }

  // मेटिएको मिति पनि नभएको रेकर्ड नछुने।
  return null;
}

function findExpiredTrashPaths(trash, now = Date.now()) {
  const paths = [];

  function walk(node, pathParts) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return;
    }

    const expiry = expiryOf(node);

    const isTrashRecord =
      Object.prototype.hasOwnProperty.call(node, 'originalPath') ||
      Object.prototype.hasOwnProperty.call(node, 'data') ||
      Object.prototype.hasOwnProperty.call(node, 'originalData') ||
      Object.prototype.hasOwnProperty.call(node, 'recordType') ||
      Object.prototype.hasOwnProperty.call(node, 'trashType');

    if (isTrashRecord && expiry !== null) {
      if (
        expiry <= now &&
        pathParts.length > 0 &&
        pathParts.every(safeKey)
      ) {
        paths.push(pathParts.join('/'));
      }

      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (safeKey(key)) {
        walk(value, [...pathParts, key]);
      }
    }
  }

  walk(trash, []);
  return paths;
}

exports.cleanupExpiredTrash = onSchedule(
  {
    schedule: 'every 24 hours',
    timeZone: 'Asia/Kathmandu'
  },
  async () => {
    const now = Date.now();

    const snapshot = await admin.database()
      .ref('users')
      .once('value');

    const users = snapshot.val() || {};

    let scannedUsers = 0;
    let removedRecords = 0;

    for (const [uid, userData] of Object.entries(users)) {
      if (!safeKey(uid)) continue;

      if (!userData || typeof userData !== 'object') {
        continue;
      }

      const trash = userData.trash;

      if (!trash || typeof trash !== 'object') {
        continue;
      }

      scannedUsers++;

      const expiredPaths = findExpiredTrashPaths(trash, now);

      if (expiredPaths.length === 0) {
        continue;
      }

      // प्रत्येक प्रयोगकर्ताको Trash भित्रका म्याद सकिएका
      // रेकर्ड मात्र हटाउने; अरू data नछुने।
      const updates = {};

      for (const relativePath of expiredPaths) {
        updates[`trash/${relativePath}`] = null;
      }

      await admin.database()
        .ref(`users/${uid}`)
        .update(updates);

      removedRecords += expiredPaths.length;
    }

    logger.info('Digital NoteBook Trash cleanup completed', {
      scannedUsers,
      removedRecords
    });
  }
);

// म्याद गणनाको स्थानीय परीक्षणका लागि।
exports._test = {
  safeKey,
  expiryOf,
  findExpiredTrashPaths
};
