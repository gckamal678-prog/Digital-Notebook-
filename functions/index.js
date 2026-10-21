
'use strict';

const admin = require('firebase-admin');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');

if (!admin.apps.length) {
  admin.initializeApp();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_RETENTION_DAYS = 30;

/**
 * Firebase Realtime Database मा मान्य key मात्र स्वीकार गर्ने।
 */
function safeKey(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[.#$\/\[\]]/.test(value)
  );
}

/**
 * रेकर्डको म्याद पत्ता लगाउने।
 * expiresAt नभए deletedAt बाट ३० दिन गणना गर्ने।
 * मिति नभएको रेकर्ड सुरक्षित रूपमा छोड्ने।
 */
function expiryOf(entry) {
  if (
    !entry ||
    typeof entry !== 'object' ||
    Array.isArray(entry)
  ) {
    return null;
  }

  const explicitExpiry = Number(entry.expiresAt);

  if (
    Number.isFinite(explicitExpiry) &&
    explicitExpiry > 0
  ) {
    return explicitExpiry;
  }

  const deletedAt = Number(
    entry.deletedAt || entry.deleted_at || 0
  );

  if (
    Number.isFinite(deletedAt) &&
    deletedAt > 0
  ) {
    return deletedAt + TRASH_RETENTION_DAYS * DAY_MS;
  }

  return null;
}

/**
 * नयाँ, nested र पुरानो root-level Trash ढाँचा खोज्ने।
 *
 * समर्थन गरिएका उदाहरण:
 * trash/notes/RECORD_ID
 * trash/transactions/RECORD_ID
 * trash/RECORD_ID  (House Expense)
 * पुरानो deletedAt + title/amount भएको Trash रेकर्ड
 */
function findExpiredTrashPaths(trash, now = Date.now()) {
  const paths = [];

  function walk(node, pathParts) {
    if (
      !node ||
      typeof node !== 'object' ||
      Array.isArray(node)
    ) {
      return;
    }

    const expiry = expiryOf(node);

    const hasTrashMarker = [
      'originalPath',
      'data',
      'originalData',
      'recordType',
      'trashType'
    ].some(key =>
      Object.prototype.hasOwnProperty.call(node, key)
    );

    // पुरानो Trash ढाँचामा छुट्टै marker नहुन सक्छ।
    const hasDeleteDate =
      Object.prototype.hasOwnProperty.call(node, 'deletedAt') ||
      Object.prototype.hasOwnProperty.call(node, 'deleted_at');

    const hasLegacyPayload = [
      'title',
      'name',
      'description',
      'amount'
    ].some(key =>
      Object.prototype.hasOwnProperty.call(node, key)
    );

    const isTrashRecord =
      hasTrashMarker ||
      (hasDeleteDate && hasLegacyPayload);

    if (isTrashRecord) {
      // मिति नभएको वा नबुझिने रेकर्ड कहिल्यै नहटाउने।
      if (expiry === null) return;

      if (
        expiry <= now &&
        pathParts.length > 0 &&
        pathParts.every(safeKey)
      ) {
        paths.push(pathParts.join('/'));
      }

      // रेकर्डभित्रको data लाई छुट्टै रेकर्ड नमान्ने।
      return;
    }

    for (const [key, value] of Object.entries(node)) {
      if (!safeKey(key)) continue;

      walk(value, [...pathParts, key]);
    }
  }

  walk(trash, []);

  return paths;
}

/**
 * प्रत्येक २४ घण्टामा म्याद सकिएका Trash रेकर्ड सफा गर्ने।
 * प्रयोगकर्ताको UID बाहिरको डेटा नछुने।
 */
exports.cleanupExpiredTrash = onSchedule(
  {
    schedule: 'every 24 hours',
    timeZone: 'Asia/Kathmandu'
  },
  async () => {
    const now = Date.now();

    const snapshot = await admin
      .database()
      .ref('users')
      .once('value');

    const users = snapshot.val() || {};

    let scannedUsers = 0;
    let removedRecords = 0;
    let failedUsers = 0;

    for (const [uid, userData] of Object.entries(users)) {
      if (!safeKey(uid)) continue;

      if (
        !userData ||
        typeof userData !== 'object' ||
        Array.isArray(userData)
      ) {
        continue;
      }

      const trash = userData.trash;

      if (
        !trash ||
        typeof trash !== 'object' ||
        Array.isArray(trash)
      ) {
        continue;
      }

      scannedUsers++;

      const expiredPaths = findExpiredTrashPaths(trash, now);

      if (expiredPaths.length === 0) continue;

      const updates = {};

      for (const relativePath of expiredPaths) {
        // केवल users/{uid}/trash भित्रका path हटाउने।
        updates[`trash/${relativePath}`] = null;
      }

      try {
        await admin
          .database()
          .ref(`users/${uid}`)
          .update(updates);

        removedRecords += expiredPaths.length;

        logger.info('Expired Trash cleaned', {
          uid,
          removedCount: expiredPaths.length
        });
      } catch (error) {
        failedUsers++;

        logger.error('Trash cleanup failed for user', {
          uid,
          message: error.message
        });
      }
    }

    logger.info('Digital NoteBook Trash cleanup completed', {
      scannedUsers,
      removedRecords,
      failedUsers
    });
  }
);

// स्थानीय परीक्षणका लागि helper functions।
exports._test = {
  safeKey,
  expiryOf,
  findExpiredTrashPaths
};
