import * as VFS from '../VFS.js';

// This implementation of a rollback journal file actually stores
// only the journal header and page indexes. When the journal is
// read, the previously discarded data is reconstituted from the
// database file.
export class IDBNoJournalFile extends VFS.Base {
  headerSector = new Int8Array();

  sectorSize = Number.NaN;
  pageSize = Number.NaN;
  pageIndexes = [];

  // SQLite takes 3 xRead() calls to read a page entry. On the
  // first read we reconstitute the entire entry and cache it for
  // the remaining calls.
  cachedPageIndex = 0;
  cachedPageEntry = null;

  constructor(name, mapIdToFile) {
    super();

    // Find the corresponding open database file.
    const dbName = name.replace(/-journal$/, '');
    for (const [dbFileId, dbFile] of mapIdToFile) {
      if (dbFile.name === dbName) {
        this.dbFileId = dbFileId;
        this.dbFile = dbFile;
        this.idb = dbFile.idb;
      }
    }
    if (!this.dbFile) throw new Error(`open database "${dbName} not found`);
  }

  get name() { return this.metadata.name; }
  get type() { return this.flags & VFS.FILE_TYPE_MASK; }

  get entrySize() { return this.pageSize + 8; }

  async xOpen(name, fileId, flags, pOutFlags) {
    this.flags = flags;
    this.metadata = {
      name
    };

    pOutFlags.set(0);
    return VFS.SQLITE_OK;
  }

  xClose() {
    return VFS.SQLITE_OK;
  }

  async xRead(fileId, pData, iOffset) {
    // Check for read past the end of data.
    if (iOffset >= this.sectorSize + this.pageIndexes.length * this.entrySize) {
      pData.value.fill(0, pData.size);
      console.warn('short read');
      return VFS.SQLITE_IOERR_SHORT_READ;
    }

    if (iOffset >= this.sectorSize) {
      // The rollback page entry for this read is regenerated by reading
      // the file. The entry is read with multiple xRead() calls so it
      // is cached for reuse.
      const entryIndex = ((iOffset - this.sectorSize) / this.entrySize) | 0;
      const pageIndex = this.pageIndexes[entryIndex];
      if (this.cachedPageIndex !== pageIndex) {
        // Fetch file data.
        const fileBlock = await this.dbFile.idb.run('readonly', ({ database }) => {
          return database.get([this.dbFile.name, pageIndex - 1]);
        });
        const fileBlockData = new Uint8Array(fileBlock.data);

        // Build a rollback page entry, which contains the page index,
        // the page data, and the page checksum.
        // https://www.sqlite.org/fileformat.html#the_rollback_journal
        this.cachedPageIndex = pageIndex;
        this.cachedPageEntry = new Int8Array(this.entrySize);
        const cachedPageView = new DataView(this.cachedPageEntry.buffer);
        cachedPageView.setUint32(0, pageIndex);
        this.cachedPageEntry.set(fileBlockData, 4);
        cachedPageView.setUint32(this.entrySize - 4, this.#checksum(fileBlockData));
      }
    
      // Transfer the requested portion of the page entry.
      const skip = (iOffset - this.sectorSize) % this.entrySize;
      pData.value.set(this.cachedPageEntry.subarray(skip, skip + pData.value.length));
    } else {
      // Read journal header.
      pData.value.set(this.headerSector.subarray(iOffset, iOffset + pData.size));
    }
    // console.log(pData.value);
    return VFS.SQLITE_OK;
  }

  xWrite(fileId, pData, iOffset) {
    // This logic is a little tricky because the sector size is specified
    // in the header and may not yet have been set.
    if (!(iOffset >= this.sectorSize)) {
      // Store header data.
      if (this.headerSector.length < iOffset + pData.size) {
        const oldJournal = this.headerSector;
        this.headerSector = new Int8Array(oldJournal.length + pData.value.length);
        this.headerSector.set(oldJournal);
      }
      this.headerSector.set(pData.value, iOffset);
    } else if ((iOffset - this.sectorSize) % this.entrySize === 0) {
      // Store the page index for this page entry. The data is discarded.
      const entryIndex = (iOffset - this.sectorSize) / this.entrySize;
      const pageIndex = new DataView(pData.value.buffer, pData.value.byteOffset).getUint32(0);
      this.pageIndexes[entryIndex] = pageIndex;
    }

    // Collect journal layout info from the header.
    // https://www.sqlite.org/fileformat.html#the_rollback_journal
    if (iOffset === 0) {
      if (pData.value[0]) {
        const view = new DataView(this.headerSector.buffer);
        this.nonce = view.getUint32(12);
        this.sectorSize = view.getUint32(20) || this.sectorSize;
        this.pageSize = view.getUint32(24) || this.sectorSize;
      } else {
        // SQLite overwrites the header with zeroes to signal the end of
        // a transaction when locking_mode=exclusive.
        this.dbFile.commit();
      }
    }
    return VFS.SQLITE_OK;
  }

  xTruncate(fileId, iSize) {
    console.assert(iSize <= this.headerSector.length);
    this.headerSector = this.headerSector.slice(0, iSize);
    return VFS.SQLITE_OK;
  }

  xSync(fileId, flags) {
    return VFS.SQLITE_OK;
  }

  xFileSize(fileId, pSize64) {
    const computedLength = this.sectorSize + this.pageIndexes.length * this.entrySize;
    pSize64.set(computedLength);
    return VFS.SQLITE_OK
  }

  xSectorSize(fileId) {
    return this.dbFile.xSectorSize(fileId);
  }

  xDeviceCharacteristics(fileId) {
    return VFS.SQLITE_IOCAP_SAFE_APPEND |
           VFS.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN;
  }

  // SQLite journal checksum
  #checksum(data) {
    let result = this.nonce;
    let x = this.pageSize - 200;
    while (x > 0) {
      result += data[x];
      x -= 200;
    }
    return result;
  }
}

