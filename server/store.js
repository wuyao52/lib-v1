import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
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
  generationJobs: [],
  assets: [],
  generatedMedia: [],
  rateLimits: [],
  auditLogs: [],
  userApiConfigs: [],
  paymentOrders: [],
  paymentEvents: [],
  storageQuarantine: [],
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

  async createUser(user) {
    return this.mutate((data) => {
      if (data.users.some((item) => item.email === user.email)) return { created: false, error: 'EMAIL_EXISTS' };
      if (data.users.some((item) => item.username.toLowerCase() === user.username.toLowerCase())) return { created: false, error: 'USERNAME_EXISTS' };
      data.users.push(user);
      return { created: true, error: null };
    });
  }

  async mutate(mutator) {
    const before = structuredClone(this.data);
    try {
      const result = mutator(this.data);
      await this.persist();
      return result;
    } catch (error) {
      this.data = before;
      throw error;
    }
  }

  async mutateCollections(_collections, mutator) {
    return this.mutate(mutator);
  }

  async persist() {
    this.writeQueue = this.writeQueue.catch(() => undefined).then(async () => {
      const tempPath = `${this.filePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    });
    return this.writeQueue;
  }

  async storageStats() {
    const file = await stat(this.filePath).catch(() => ({ size: 0 }));
    return { provider: 'json', bytes: Number(file.size || 0), rows: Object.values(this.data).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0) };
  }

  migrationStatus() {
    return { ready: true, currentVersion: 0, expectedVersion: 0, provider: 'json' };
  }
}
