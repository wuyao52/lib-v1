import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const EMPTY_DATABASE = {
  users: [],
  sessions: [],
  emailVerifications: [],
  imageCaptchas: [],
  skills: [],
  projects: [],
  systemApis: [],
  modelPricing: [],
  balanceTransactions: [],
  rechargeRequests: [],
  generationHistory: [],
};

export class JsonDatabase {
  constructor(filePath) {
    this.kind = 'json';
    this.filePath = filePath;
    this.data = structuredClone(EMPTY_DATABASE);
    this.writeQueue = Promise.resolve();
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      this.data = { ...structuredClone(EMPTY_DATABASE), ...parsed };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.persist();
    }
    return this;
  }

  read(collection) {
    return this.data[collection];
  }

  async mutate(mutator) {
    const result = mutator(this.data);
    await this.persist();
    return result;
  }

  async persist() {
    this.writeQueue = this.writeQueue.then(async () => {
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    });
    return this.writeQueue;
  }
}
