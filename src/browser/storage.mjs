const DEFAULT_DATABASE_NAME = 'hnd-browser-vault-v1';
const DEFAULT_STORE_NAME = 'vaults';

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('IndexedDB version must be a positive safe integer');
  }
  return value;
}

function nonEmptyName(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function transactionFailure(transaction, fallback) {
  return transaction.error || new Error(fallback);
}

/**
 * Create the browser storage adapter used by vault.mjs. Values are structured
 * cloned by IndexedDB, which allows a non-extractable CryptoKey to remain a
 * CryptoKey across page reloads on browsers that implement the WebCrypto/IDB
 * structured-clone integration.
 */
export function createIndexedDbVaultStorage(options = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory || typeof factory.open !== 'function') {
    throw new Error('IndexedDB is not available in this context');
  }
  const databaseName = nonEmptyName(
    options.databaseName ?? DEFAULT_DATABASE_NAME,
    'IndexedDB database name',
  );
  const storeName = nonEmptyName(
    options.storeName ?? DEFAULT_STORE_NAME,
    'IndexedDB store name',
  );
  const version = positiveVersion(options.version ?? 1);

  const databasePromise = new Promise((resolve, reject) => {
    const request = factory.open(databaseName, version);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(storeName)) {
        request.result.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the browser vault database'));
    request.onblocked = () => reject(new Error('Browser vault database upgrade is blocked by another page'));
  });

  async function get(key) {
    const database = await databasePromise;
    return new Promise((resolve, reject) => {
      let result;
      let settled = false;
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).get(key);
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(request.error || new Error('Could not read the browser vault'));
        }
      };
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transactionFailure(transaction, 'Browser vault read was aborted'));
        }
      };
      transaction.onerror = () => {};
    });
  }

  // This operation must remain atomic: createBrowserVault relies on a
  // unique IndexedDB key to make concurrent first opens converge on one key.
  async function insertIfAbsent(key, value) {
    const database = await databasePromise;
    return new Promise((resolve, reject) => {
      let conflict = false;
      let settled = false;
      const transaction = database.transaction(storeName, 'readwrite');
      const request = transaction.objectStore(storeName).add(value, key);
      request.onerror = (event) => {
        if (request.error?.name === 'ConstraintError') {
          conflict = true;
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!settled) {
          settled = true;
          reject(request.error || new Error('Could not store the browser vault'));
        }
      };
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(!conflict);
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transactionFailure(transaction, 'Browser vault write was aborted'));
        }
      };
      transaction.onerror = () => {};
    });
  }

  // Replace one complete record in a single IndexedDB transaction. Managed
  // account recovery uses this only after recent authentication has made the
  // server copy authoritative; constructing the replacement happens before
  // this method so a WebCrypto failure leaves the old record untouched.
  async function replace(key, value) {
    const database = await databasePromise;
    return new Promise((resolve, reject) => {
      let settled = false;
      const transaction = database.transaction(storeName, 'readwrite');
      const request = transaction.objectStore(storeName).put(value, key);
      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(request.error || new Error('Could not replace the browser vault'));
        }
      };
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transactionFailure(transaction, 'Browser vault replacement was aborted'));
        }
      };
      transaction.onerror = () => {};
    });
  }

  async function deleteValue(key) {
    const database = await databasePromise;
    return new Promise((resolve, reject) => {
      let settled = false;
      const transaction = database.transaction(storeName, 'readwrite');
      transaction.objectStore(storeName).delete(key);
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transactionFailure(transaction, 'Browser vault deletion was aborted'));
        }
      };
      transaction.onerror = () => {};
    });
  }

  async function keys() {
    const database = await databasePromise;
    return new Promise((resolve, reject) => {
      let result = [];
      let settled = false;
      const transaction = database.transaction(storeName, 'readonly');
      const request = transaction.objectStore(storeName).getAllKeys();
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(request.error || new Error('Could not list browser vaults'));
        }
      };
      transaction.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      transaction.onabort = () => {
        if (!settled) {
          settled = true;
          reject(transactionFailure(transaction, 'Browser vault listing was aborted'));
        }
      };
      transaction.onerror = () => {};
    });
  }

  async function close() {
    (await databasePromise).close();
  }

  return Object.freeze({
    get,
    keys,
    insertIfAbsent,
    replace,
    delete: deleteValue,
    close,
  });
}
